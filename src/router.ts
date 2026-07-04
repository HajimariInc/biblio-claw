/**
 * Inbound message routing.
 *
 * Channel adapter event → resolve messaging group → sender resolver →
 * resolve/pick agent → access gate → resolve/create session → write
 * messages_in → wake container.
 *
 * Two module hooks (registered by the permissions module):
 *   - `setSenderResolver` runs BEFORE agent resolution so user rows get
 *     upserted even if the message ends up dropped by agent wiring.
 *     Without the module, userId is null and downstream code tolerates it.
 *   - `setAccessGate` runs AFTER agent resolution so policy decisions can
 *     branch on the target agent group. Without the module, access is
 *     allow-all.
 *
 * `dropped_messages` is core audit infra. Core writes rows for structural
 * drops (no agent wired, no trigger match); the access gate writes rows
 * for policy refusals.
 */
import { randomUUID } from 'node:crypto';

import { dispatchToAdk } from './adk/dispatcher.js';
import { getChannelAdapter } from './channels/channel-registry.js';
import { gateCommand } from './command-gate.js';
import { appendGateAuditLog } from './gate/audit-log.js';
import { evaluateGate, isGateEnabled, withGateSpan } from './gate/gate.js';
import type { GateResult } from './gate/types.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getContainerConfig } from './db/container-configs.js';
import { recordDroppedMessage } from './db/dropped-messages.js';
import {
  createMessagingGroup,
  getMessagingGroupAgents,
  getMessagingGroupWithAgentCount,
} from './db/messaging-groups.js';
import { findSessionForAgent } from './db/sessions.js';
import { startTypingRefresh, stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { notifyAdmin } from './modules/approvals/notify-admin.js';
import { resolveSession, writeSessionMessage, writeOutboundDirect } from './session-manager.js';
import { wakeContainer } from './container-runner.js';
import { getSession } from './db/sessions.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent } from './types.js';
import type { InboundEvent } from './channels/adapter.js';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Sender-resolver hook. Runs before agent resolution.
 *
 * The permissions module registers this to extract the sender's namespaced
 * user id and upsert the users row. Returns null when the payload doesn't
 * carry enough info to identify a sender. Without the hook, every message
 * arrives at the gate with userId=null.
 */
export type SenderResolverFn = (event: InboundEvent) => string | null;

let senderResolver: SenderResolverFn | null = null;

export function setSenderResolver(fn: SenderResolverFn): void {
  if (senderResolver) {
    log.warn('Sender resolver overwritten');
  }
  senderResolver = fn;
}

/**
 * Access-gate hook. Runs after agent resolution.
 *
 * The permissions module registers this; without it, core defaults to
 * allow-all. The gate receives the raw event so it can extract the sender
 * name for audit-trail purposes, and it is responsible for recording its
 * own `dropped_messages` row on refusal (structural drops are already
 * recorded by core before the gate runs).
 */
export type AccessGateResult = { allowed: true } | { allowed: false; reason: string };

export type AccessGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agentGroupId: string,
) => AccessGateResult;

let accessGate: AccessGateFn | null = null;

export function setAccessGate(fn: AccessGateFn): void {
  if (accessGate) {
    log.warn('Access gate overwritten');
  }
  accessGate = fn;
}

/**
 * Per-wiring sender-scope hook. Runs alongside the access gate for each
 * agent that would otherwise engage — lets the permissions module enforce
 * `sender_scope='known'` on wirings that are stricter than the messaging
 * group's `unknown_sender_policy`. When the hook isn't registered (module
 * not installed), sender_scope is a no-op.
 */
export type SenderScopeGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agent: MessagingGroupAgent,
) => AccessGateResult;

let senderScopeGate: SenderScopeGateFn | null = null;

export function setSenderScopeGate(fn: SenderScopeGateFn): void {
  if (senderScopeGate) {
    log.warn('Sender-scope gate overwritten');
  }
  senderScopeGate = fn;
}

/**
 * Message-interceptor hook. Runs at the very top of routeInbound, before
 * messaging-group resolution. When the interceptor returns true the message
 * is consumed and routing stops. Used by the permissions module to capture
 * free-text replies during multi-step approval flows (e.g. agent naming).
 */
export type MessageInterceptorFn = (event: InboundEvent) => Promise<boolean>;

let messageInterceptor: MessageInterceptorFn | null = null;

export function setMessageInterceptor(fn: MessageInterceptorFn): void {
  messageInterceptor = fn;
}

/**
 * Channel-registration hook. Runs when the router sees a mention/DM on a
 * messaging group that has no wirings AND hasn't been denied. The hook is
 * expected to escalate to an owner (card, etc.) and arrange for future
 * replay via routeInbound after approval. Fire-and-forget from the
 * router's perspective.
 *
 * Registered by the permissions module. Without the module the router
 * silently records the drop with reason='no_agent_wired' and moves on.
 */
export type ChannelRequestGateFn = (mg: MessagingGroup, event: InboundEvent) => Promise<void>;

let channelRequestGate: ChannelRequestGateFn | null = null;

export function setChannelRequestGate(fn: ChannelRequestGateFn): void {
  if (channelRequestGate) {
    log.warn('Channel-request gate overwritten');
  }
  channelRequestGate = fn;
}

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

/**
 * Route an inbound message from a channel adapter to the correct session.
 * Creates messaging group + session if they don't exist yet.
 */
export async function routeInbound(event: InboundEvent): Promise<void> {
  // Pre-route interceptor — lets modules consume messages before any routing
  // (e.g. free-text replies during multi-step approval flows).
  if (messageInterceptor && (await messageInterceptor(event))) return;

  // 0. Apply the adapter's thread policy. Non-threaded adapters (Telegram,
  //    WhatsApp, iMessage, email) collapse threads to the channel.
  const adapter = getChannelAdapter(event.channelType);
  if (adapter && !adapter.supportsThreads) {
    event = { ...event, threadId: null };
  }

  const isMention = event.message.isMention === true;

  // 1. Combined lookup: messaging_group row + count of wired agents in a
  //    single query. Cheap short-circuit for the common "unwired channel"
  //    case — one DB read and we're out, no auto-create, no sender
  //    resolution, no log spam.
  const found = getMessagingGroupWithAgentCount(event.channelType, event.platformId);

  let mg: MessagingGroup;
  let agentCount: number;
  if (!found) {
    // No messaging_groups row. Auto-create only when the message warrants
    // attention (the bot was addressed — @mention or DM). Plain chatter in
    // channels we merely sit in stays silent — no row, no DB writes.
    if (!isMention) return;
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mg = {
      id: mgId,
      channel_type: event.channelType,
      platform_id: event.platformId,
      name: null,
      is_group: event.message.isGroup ? 1 : 0,
      unknown_sender_policy: 'request_approval',
      denied_at: null,
      created_at: new Date().toISOString(),
    };
    createMessagingGroup(mg);
    log.info('Auto-created messaging group', {
      id: mgId,
      channelType: event.channelType,
      platformId: event.platformId,
    });
    agentCount = 0;
  } else {
    mg = found.mg;
    agentCount = found.agentCount;
  }

  // 1b. No wirings — either silent drop (plain chatter / denied channel) or
  //     escalate to owner for channel-registration approval.
  if (agentCount === 0) {
    if (!isMention) return;
    if (mg.denied_at) {
      log.debug('Message dropped — channel was denied by owner', {
        messagingGroupId: mg.id,
        deniedAt: mg.denied_at,
      });
      return;
    }

    const parsed = safeParseContent(event.message.content);
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: null,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_wired',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });

    if (channelRequestGate) {
      // Fire-and-forget escalation. The gate is expected to build a card,
      // persist pending_channel_approvals, and replay the event via
      // routeInbound after approval. Errors are logged internally — the
      // user's message still stays dropped here either way.
      void channelRequestGate(mg, event).catch((err) =>
        log.error('Channel-request gate threw', { messagingGroupId: mg.id, err }),
      );
    } else {
      log.warn('MESSAGE DROPPED — no agent groups wired and no channel-request gate registered', {
        messagingGroupId: mg.id,
        channelType: event.channelType,
        platformId: event.platformId,
      });
    }
    return;
  }

  // 2. Sender resolution (permissions module upserts the users row as a
  //    side effect so later role/access lookups find a real record).
  //    Without the module, userId is null — downstream tolerates it.
  const userId: string | null = senderResolver ? senderResolver(event) : null;

  // 3. Fetch wired agents in full (we already know the count is > 0; now
  //    we need their actual rows for fan-out).
  const agents = getMessagingGroupAgents(mg.id);

  // 4. Fan-out: evaluate each wired agent independently against engage_mode,
  //    sender_scope, and access gate. An agent that engages gets its own
  //    session and container wake. An agent that declines but has
  //    ignored_message_policy='accumulate' still gets the message stored in
  //    its session (trigger=0) so the context is available when it does
  //    engage later. Drop policy = skip silently.
  //
  //    Subscribe (for mention-sticky wirings on threaded platforms) fires
  //    once per message from this loop — the first engaging mention-sticky
  //    wiring triggers adapter.subscribe(...); subsequent wirings don't
  //    re-subscribe (chat.subscribe is idempotent anyway, but the flag
  //    avoids the extra await).
  const parsed = safeParseContent(event.message.content);
  const messageText = parsed.text ?? '';

  // M4-F Phase 2: gate 判定 (`GATE_ENABLED=true` 時のみ発火)。
  //   - biblio-adk / biblio-other → gateResult を fan-out loop に渡し、deliverToAgent 冒頭で
  //     provider mismatch skip
  //   - in-secure → 3 点セット (admin DM 通知 + audit log + patron 定型文返信) 発火 + 早期 return
  //   - gate 自体の unexpected throw は fail-open (gateResult=null) で従来経路継続
  //     (Layer 4 内部の Vertex/Zod fallback は既に biblio-other に倒れるため throw は稀ケース)
  let gateResult: GateResult | null = null;
  if (isGateEnabled()) {
    try {
      gateResult = await withGateSpan(messageText, async (span) => {
        const result = await evaluateGate(messageText);
        span.setAttribute('gate.classification', result.classification);
        span.setAttribute('gate.layer_hit', result.layerHit);
        span.setAttribute('gate.reason', result.reason);
        span.setAttribute('gate.latency_ms', result.latencyMs);
        if (result.model) span.setAttribute('gate.model', result.model);
        span.setAttribute('gate.outcome', result.classification === 'in-secure' ? 'blocked' : 'allowed');
        return result;
      });
      log.info('gate classified', {
        event: 'gate.classified',
        gate_classification: gateResult.classification,
        gate_layer: gateResult.layerHit,
        gate_reason: gateResult.reason,
        gate_latency_ms: gateResult.latencyMs,
        channel_type: event.channelType,
        messaging_group_id: mg.id,
      });
      appendGateAuditLog({
        outcome: gateResult.classification === 'in-secure' ? 'blocked' : 'allowed',
        layer: gateResult.layerHit,
        classification: gateResult.classification,
        reason: gateResult.reason,
        utterance: messageText,
        // audit 側 channel enum は 'slack' | 'cli' | 'fugue' の 3 値、それ以外は 'slack' に丸める
        // (暫定、Phase 3+ で拡張)
        channel:
          event.channelType === 'slack'
            ? 'slack'
            : event.channelType === 'cli'
              ? 'cli'
              : 'slack',
        channelType: event.channelType,
        userId,
      });
      // in-secure 早期 return + 3 点セット発火
      if (gateResult.classification === 'in-secure') {
        // (1) admin DM 通知 (notify-only、承認カードではない)
        void notifyAdmin({
          channelType: event.channelType,
          agentGroupId: agents[0]?.agent_group_id ?? null,
          subject: 'gate.blocked',
          body: `Injection 疑い発話を検出しました。\nlayer: ${gateResult.layerHit}\nreason: ${gateResult.reason}\nchannel: ${event.channelType}\nuser: ${userId ?? '(unknown)'}`,
        }).catch((err) =>
          log.warn('gate notifyAdmin unexpected throw', {
            event: 'gate.blocked.notify_admin_throw',
            err: err instanceof Error ? err.message : String(err),
          }),
        );
        // (2) audit log は既に appendGateAuditLog で発火済
        // (3) patron 定型文返信 (session 未作成のため adapter.deliver 直接呼出、ADK dispatcher
        //     fallback (L482-497) の写経)
        const adapter = getChannelAdapter(event.channelType);
        if (adapter) {
          await adapter
            .deliver(event.platformId, event.threadId, {
              kind: 'chat',
              content: {
                text: '入力に不審な内容が含まれる可能性があるため、この発話は処理できませんでした。管理者に通知しました。',
              },
            })
            .catch((deliverErr) => {
              log.error('gate in-secure patron deliver failed', {
                event: 'gate.blocked.patron_deliver_failed',
                err: deliverErr instanceof Error ? deliverErr.message : String(deliverErr),
              });
            });
        }
        return; // fan-out loop に入らず終了 (dropped_messages 記録経路も skip)
      }
    } catch (err) {
      // gate 自体の unexpected throw (Layer 4 fallback を超えた例外) は fail-open で対話継続。
      // 「in-secure 判定は Layer 1-4 が両方 fail した稀ケース」= fallback は現状挙動継続。
      log.warn('gate unexpected throw, falling back to open (existing wiring)', {
        event: 'gate.unexpected_throw',
        err: err instanceof Error ? err.message : String(err),
      });
      gateResult = null; // 以降の provider mismatch skip も無効化
    }
  }

  let engagedCount = 0;
  let accumulatedCount = 0;
  let subscribed = false;

  for (const agent of agents) {
    const agentGroup = getAgentGroup(agent.agent_group_id);
    if (!agentGroup) continue;

    const engages = evaluateEngage(agent, messageText, isMention, mg, event.threadId);

    const accessOk = engages && (!accessGate || accessGate(event, userId, mg, agent.agent_group_id).allowed);
    const scopeOk = engages && (!senderScopeGate || senderScopeGate(event, userId, mg, agent).allowed);

    if (engages && accessOk && scopeOk) {
      await deliverToAgent(agent, agentGroup, mg, event, userId, adapter?.supportsThreads === true, true, gateResult);
      engagedCount++;

      // Mention-sticky: ask the adapter to subscribe the thread so the
      // platform's subscribed-message path carries follow-ups without
      // requiring another @mention. Threaded-adapter only; DMs and
      // non-threaded platforms skip.
      if (
        !subscribed &&
        agent.engage_mode === 'mention-sticky' &&
        adapter?.supportsThreads &&
        adapter.subscribe &&
        event.threadId !== null &&
        mg.is_group !== 0
      ) {
        subscribed = true;
        // Fire-and-forget — subscribe is platform-side bookkeeping and
        // shouldn't block message routing. Errors are logged inside the
        // adapter (or by the promise rejection handler below).
        void adapter.subscribe(event.platformId, event.threadId).catch((err) => {
          log.warn('adapter.subscribe failed', { channelType: event.channelType, threadId: event.threadId, err });
        });
      }
    } else if (agent.ignored_message_policy === 'accumulate' && !(engages && (!accessOk || !scopeOk))) {
      // Accumulate stores the message as silent context. We allow it when
      // engagement simply didn't fire, but NOT when engagement fired and
      // the access/scope gate refused — those refusals are security
      // decisions about an untrusted sender, and silently storing their
      // message (which also stages their attachments to disk via
      // writeSessionMessage → extractAttachmentFiles) is exactly what the
      // gate is meant to prevent.
      await deliverToAgent(agent, agentGroup, mg, event, userId, adapter?.supportsThreads === true, false, gateResult);
      accumulatedCount++;
    } else {
      log.debug('Message not engaged for agent (drop policy)', {
        agentGroupId: agent.agent_group_id,
        engage_mode: agent.engage_mode,
        engages,
        accessOk,
        scopeOk,
      });
    }
  }

  if (engagedCount + accumulatedCount === 0) {
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: userId,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_engaged',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });
  }
}

/**
 * Decide whether a given wired agent should engage on this message.
 *
 *   'pattern'        — regex test on text; '.' = always
 *   'mention'        — bot must be mentioned on the platform. Resolved by
 *                      the adapter (SDK-level) and forwarded as
 *                      `event.message.isMention`. Agent display name
 *                      (`agent_group.name`) is irrelevant — users address
 *                      the bot via its platform username (@botname on
 *                      Telegram, user-id mention on Slack/Discord), not
 *                      via the agent's NanoClaw-side display name. If a
 *                      user wants to disambiguate between multiple agents
 *                      wired to one chat, use engage_mode='pattern' with
 *                      the disambiguator as the regex.
 *   'mention-sticky' — platform mention OR an active per-thread session
 *                      already exists for this (agent, mg, thread). The
 *                      session existence IS our subscription state; once
 *                      a thread has engaged us once, follow-ups arrive
 *                      with no mention and should still fire.
 */
function evaluateEngage(
  agent: MessagingGroupAgent,
  text: string,
  isMention: boolean,
  mg: MessagingGroup,
  threadId: string | null,
): boolean {
  switch (agent.engage_mode) {
    case 'pattern': {
      const pat = agent.engage_pattern ?? '.';
      if (pat === '.') return true;
      try {
        return new RegExp(pat).test(text);
      } catch {
        // Bad regex: fail open so admin sees the agent responding + can fix.
        return true;
      }
    }
    case 'mention':
      return isMention;
    case 'mention-sticky': {
      if (isMention) return true;
      // Sticky follow-up: session already exists for this (agent, mg, thread)
      // — the thread was activated before, keep firing.
      if (mg.is_group === 0) return false; // DMs never use mention-sticky sensibly
      const existing = findSessionForAgent(agent.agent_group_id, mg.id, threadId);
      return existing !== undefined;
    }
    default:
      return false;
  }
}

async function deliverToAgent(
  agent: MessagingGroupAgent,
  agentGroup: AgentGroup,
  mg: MessagingGroup,
  event: InboundEvent,
  userId: string | null,
  adapterSupportsThreads: boolean,
  wake: boolean,
  gateResult: GateResult | null = null,
): Promise<void> {
  // Provider dispatch (M4-B Phase 3): agent_group が provider='adk' を選択している
  // 場合、agent-runner container 経路 (= session / container spawn) をスキップし、
  // orchestrator 内 in-process ADK Runner に patron 命令を直接流す。
  //
  // - session concept なし (= `runEphemeral` が都度 ephemeral session を作る)
  // - Command gate / typing indicator は既存 claude 経路のみに適用 (ADK 経路では
  //   dispatcher 内で応答返却まで完結するため typing の意味が薄い)
  // - `wake=false` は「傍受中、message 蓄積のみ or 完全ドロップ」の 2 ポリシーが
  //   `ignored_message_policy` で分岐するが、ADK 経路は session なし = **accumulate
  //   相当の永続化手段を持たない**。よってどちらのポリシーでも実質 drop 挙動になる
  //   (I5 = PR #101 review 指摘)。`ignored_message_policy='accumulate'` を ADK
  //   provider の wiring に設定しても実際には蓄積されず silent に消える点に注意 —
  //   `init-adk-agent.ts` は現状 `'drop'` 固定で作成するため今は顕在化しないが、
  //   将来 accumulate を選ぶ運用で silent data loss を招く。Phase 4/90 で session
  //   永続化を導入するか、accumulate ポリシーを ADK provider では reject する経路
  //   を検討する。
  //
  // 実装 note: `resolveProviderName` (container-runner.ts) を import せず inline 化するのは、
  // 既存 test 群が `vi.mock('./container-runner.js', ...)` で 4 関数 stub (wakeContainer /
  // isContainerRunning / getActiveContainerCount / killContainer) している都合。
  // `resolveProviderName` を追加 export しても既存 mock 側で unimport になり、複数の
  // test file (host-core.test.ts / channel-registry.test.ts / channel-approval.test.ts /
  // sender-approval.test.ts / delivery.test.ts / container-restart.test.ts / agent-route.test.ts
  // / destinations.test.ts / groups.test.ts 等 10+ 箇所) の mock 追記が必要になる。
  // ADK 分岐は container_configs.provider だけ見れば十分 (= session.agent_provider は
  // session 作成前の deliverToAgent 冒頭では未確定)。
  //
  // TODO(Phase 4/90): 将来 session.agent_provider を non-null に更新する mutator が
  // 追加されたら、本 inline 版も追従して session.agent_provider を優先する経路が要る
  // (現状 `ncl sessions` は read-only で該当 mutator 不在のため実害ゼロ)。
  const containerConfig = getContainerConfig(agentGroup.id);
  const providerName = (containerConfig?.provider ?? 'claude').toLowerCase();
  // M4-F Phase 2: gate classification と provider の mismatch skip。
  // gateResult=null (= GATE_ENABLED=false or gate unexpected throw で fail-open) 時は
  // skip せず既存経路継続 (= gate 無効化時の main 合流退路を担保)。
  if (gateResult) {
    const isAdk = providerName === 'adk';
    const shouldSkip =
      (gateResult.classification === 'biblio-adk' && !isAdk) ||
      (gateResult.classification === 'biblio-other' && isAdk);
    if (shouldSkip) {
      log.debug('gate skip: classification-provider mismatch', {
        event: 'gate.skip.mismatch',
        gate_classification: gateResult.classification,
        agent_provider: providerName,
        agent_group_id: agentGroup.id,
      });
      return;
    }
  }
  if (providerName === 'adk') {
    if (!wake) {
      log.debug('ADK path: non-wake message dropped (in-process = no session accumulation)', {
        agentGroupId: agent.agent_group_id,
        messagingGroupId: mg.id,
      });
      return;
    }
    const parsed = safeParseContent(event.message.content);
    const patronText = parsed.text ?? '';
    const requestId = randomUUID();
    log.info('routeInbound → ADK dispatcher', {
      event: 'router.dispatch.adk',
      agent_group_id: agent.agent_group_id,
      messaging_group_id: mg.id,
      channel_type: event.channelType,
      request_id: requestId,
    });
    try {
      await dispatchToAdk({
        agentGroupId: agent.agent_group_id,
        messagingGroupId: mg.id,
        channelType: event.channelType,
        platformId: event.platformId,
        threadId: event.threadId,
        userId,
        patronText,
        requestId,
      });
    } catch (err) {
      // dispatcher は throw しない contract (内部で catch + fallback text)。
      // 万一の unexpected throw を silent 化しないため保険で拾う + patron に最終砦
      // fallback を送る (I6 = PR #101 review 指摘、dispatcher の contract 破綻時に
      // patron が完全無応答になる二重の脆さを解消)。
      log.error('ADK dispatcher threw (should not happen)', {
        event: 'router.dispatch.adk_unexpected_throw',
        agent_group_id: agent.agent_group_id,
        request_id: requestId,
        err: err instanceof Error ? err.message : String(err),
      });
      const adapter = getChannelAdapter(event.channelType);
      if (adapter) {
        // deliver 自体の失敗は log 拾って swallow (= 循環 catch 防止、routeInbound 全体
        // を throw させない)
        await adapter
          .deliver(event.platformId, event.threadId, {
            kind: 'chat',
            content: { text: 'エラー: システムエラーが発生しました。しばらくして再度お試しください。' },
          })
          .catch((deliverErr) => {
            log.error('ADK dispatcher fallback deliver also failed', {
              event: 'router.dispatch.adk_fallback_deliver_failed',
              request_id: requestId,
              err: deliverErr instanceof Error ? deliverErr.message : String(deliverErr),
            });
          });
      }
    }
    return;
  }

  // Apply the adapter thread policy: threaded adapter in a group chat →
  // per-thread session regardless of wiring. agent-shared preserved (it's
  // a cross-channel directive the adapter doesn't know about). DMs collapse
  // sub-threads to one session (is_group=0 short-circuit).
  let effectiveSessionMode = agent.session_mode;
  if (adapterSupportsThreads && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
    effectiveSessionMode = 'per-thread';
  }

  const { session, created } = resolveSession(agent.agent_group_id, mg.id, event.threadId, effectiveSessionMode);

  // The inbound row's (channel_type, platform_id, thread_id) is the address
  // the agent's reply will be delivered to. Normally it mirrors the source
  // (stamped from the event). When the caller supplied `replyTo` (CLI admin
  // transport acting on operator intent), the reply is redirected there.
  const deliveryAddr = event.replyTo ?? {
    channelType: event.channelType,
    platformId: event.platformId,
    threadId: event.threadId,
  };

  // Command gate: classify slash commands before they reach the container.
  // Filtered commands are dropped silently. Denied admin commands get a
  // permission-denied response written directly to messages_out.
  if (event.message.kind === 'chat' || event.message.kind === 'chat-sdk') {
    const gate = gateCommand(event.message.content, userId, agent.agent_group_id);
    if (gate.action === 'filter') {
      log.debug('Filtered command dropped by gate', { agentGroupId: agent.agent_group_id });
      return;
    }
    if (gate.action === 'deny') {
      writeOutboundDirect(session.agent_group_id, session.id, {
        id: `deny-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        platformId: deliveryAddr.platformId,
        channelType: deliveryAddr.channelType,
        threadId: deliveryAddr.threadId,
        content: JSON.stringify({ text: `Permission denied: ${gate.command} requires admin access.` }),
      });
      log.info('Admin command denied by gate', { command: gate.command, userId, agentGroupId: agent.agent_group_id });
      return;
    }
  }

  writeSessionMessage(session.agent_group_id, session.id, {
    id: messageIdForAgent(event.message.id, agent.agent_group_id),
    kind: event.message.kind,
    timestamp: event.message.timestamp,
    platformId: deliveryAddr.platformId,
    channelType: deliveryAddr.channelType,
    threadId: deliveryAddr.threadId,
    content: event.message.content,
    trigger: wake ? 1 : 0,
  });

  log.info('Message routed', {
    sessionId: session.id,
    agentGroup: agent.agent_group_id,
    engage_mode: agent.engage_mode,
    kind: event.message.kind,
    userId,
    wake,
    created,
    agentGroupName: agentGroup.name,
  });

  if (wake) {
    // Typing indicator + wake are only for the engaged branch; accumulated
    // messages sit silently until a real trigger fires.
    startTypingRefresh(session.id, session.agent_group_id, event.channelType, event.platformId, event.threadId);
    const freshSession = getSession(session.id);
    if (freshSession) {
      const woke = await wakeContainer(freshSession);
      // wakeContainer never throws — it returns false on transient spawn
      // failure (host-sweep retries). Stop the typing indicator we just
      // started so it doesn't leak; the inbound row stays pending.
      if (!woke) stopTypingRefresh(freshSession.id);
    }
  }
}

/**
 * When fanning out, the same inbound message lands in multiple per-agent
 * session DBs. messages_in.id is PRIMARY KEY, so reuse of the raw id would
 * collide across sessions (or, more subtly, within one session if re-routed
 * after a retry). Namespace by agent_group_id to keep ids unique per session.
 */
function messageIdForAgent(baseId: string | undefined, agentGroupId: string): string {
  const id = baseId && baseId.length > 0 ? baseId : generateId();
  return `${id}:${agentGroupId}`;
}
