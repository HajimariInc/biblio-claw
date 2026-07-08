/**
 * Outbound message delivery.
 * Polls session outbound DBs for undelivered messages, delivers through channel adapters.
 *
 * Two-DB architecture:
 *   - Reads messages_out from outbound.db (container-owned, opened read-only)
 *   - Tracks delivery in inbound.db's `delivered` table (host-owned)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 */
import type Database from 'better-sqlite3';

import { getRunningSessions, getActiveSessions, createPendingQuestion } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { getMessagingGroupByPlatform } from './db/messaging-groups.js';
import {
  getDueOutboundMessages,
  getDeliveredIds,
  markDelivered,
  markDeliveryFailed,
  migrateDeliveredTable,
} from './db/session-db.js';
import { log } from './log.js';
import { normalizeOptions } from './channels/ask-question.js';
import {
  clearOutbox,
  isPreSpawnDbOpenError,
  openInboundDb,
  openOutboundDb,
  readOutboxFiles,
} from './session-manager.js';
import { refreshProgressStatus } from './modules/progress-status/poller.js';
import { pauseTypingRefreshAfterDelivery, setTypingAdapter } from './modules/typing/index.js';
import type { OutboundFile, TypingStatus } from './channels/adapter.js';
import type { Session } from './types.js';

const ACTIVE_POLL_MS = 1000;
const SWEEP_POLL_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 3;

/** Track delivery attempt counts. Resets on process restart (gives failed messages a fresh chance). */
const deliveryAttempts = new Map<string, number>();

/**
 * Sessions whose outbound queue is currently being drained.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages, and a running session
 * is in *both* result sets. Without this guard, the two timer chains can
 * race on the same outbound row: both read it as undelivered, both call
 * the channel adapter, both markDelivered (idempotent in the DB via
 * INSERT OR IGNORE — but the user has already seen the message twice).
 *
 * Skipping (vs. queueing) is correct: any message left over when the
 * second caller skips will be picked up on the next poll tick (~1s).
 */
const inflightDeliveries = new Set<string>();

/**
 * `ncl messages send --stub-outbound` の verify 経路で
 * 実 channel deliver を silent skip するための target set。
 *
 * key = `${agentGroupId}:${channelType}:${platformId}` の **3-tuple** (agent_group_id +
 * channel_type + platform_id)。thread_id は key から意図的に除外する。
 *
 * 3-tuple 化の背景: 従来 4-tuple (thread_id を含む) だったが、hybrid Slack DM
 * (`init-hybrid-agent.ts:240`) が `session_mode: 'shared'` で wire されている実運用では、
 * `resolveSession` (`src/session-manager.ts:101,111,174`) が `thread_id = null` に強制する。
 * この `null` が `writeSessionRouting` → agent-runner の `getSessionRouting` → 応答の
 * default routing に伝播し `messages_out.thread_id = null` として書き込まれる一方、
 * `messages.ts` は routeInbound 前に session を持たないため `threadId = mg.platform_id`
 * (非 null) で stub key を積む → 4-tuple 一致条件が構造的に成立せず、stub 対象が
 * 実配送側で恒久的に false 判定される silent 不作動が起きていた。
 *
 * 3-tuple 化のトレードオフ: 同一 MG に **同一 agent_group** から同時に別 thread の deliver
 * が走ると両方 stub される。ただし本 verify 経路の想定用途 (`verify-m4-f.sh`) では 1
 * agent_group × 1 MG × sequential dispatch のため、この巻き添えは実運用上発生しない
 * (fan-out 別 agent_group への副作用ゼロは agent_group_id で担保、これは元設計と同じ)。
 *
 * production 経路は Set が常に空 = `isStubOutboundTarget` は常に false = 挙動不変。
 * verify のみ `addStubOutboundTarget` → messages send → finally で
 * `removeStubOutboundTarget` を必ず呼び、汚染を残さない。
 */
const stubOutboundTargets = new Set<string>();

/** stub target key を組み立てる。agent_group_id + channel_type + platform_id の 3-tuple。
 *  thread_id を除外することで session_mode='shared' が強制する `thread_id=null` を吸収する。 */
function stubTargetKey(agentGroupId: string, channelType: string | null, platformId: string | null): string {
  return `${agentGroupId}:${channelType ?? ''}:${platformId ?? ''}`;
}

export function addStubOutboundTarget(agentGroupId: string, channelType: string, platformId: string): void {
  stubOutboundTargets.add(stubTargetKey(agentGroupId, channelType, platformId));
}

export function removeStubOutboundTarget(agentGroupId: string, channelType: string, platformId: string): void {
  stubOutboundTargets.delete(stubTargetKey(agentGroupId, channelType, platformId));
}

export function isStubOutboundTarget(
  agentGroupId: string,
  channelType: string | null,
  platformId: string | null,
): boolean {
  if (stubOutboundTargets.size === 0) return false;
  return stubOutboundTargets.has(stubTargetKey(agentGroupId, channelType, platformId));
}

/** test 用 backdoor: module state を reset する。production import path からは呼ばない。 */
export function _resetStubOutboundTargetsForTest(): void {
  stubOutboundTargets.clear();
}

/**
 * issue #155 案 B 対応: `--stub-outbound` を「outbound + notify + reject」全経路に拡張するため
 * の 2-tuple key の Set。key = `${channelType}:${platformId}`。
 *
 * **既存 stubOutboundTargets (3-tuple) との使い分け**:
 * - stubOutboundTargets = agent_group_id + channel + platform。既存 deliverToSession 用。
 * - stubDeliveryByMg = channel + platform のみ。**agent_group_id が resolvable でない経路**
 *   (in-secure reject / notify-admin / ADK fallback) 用。
 *
 * **案 B の想定副作用**:
 * - fan-out 別 agent_group から同 MG への deliver も stub される可能性 = ただし verify 用途
 *   では 1 agent_group × 1 MG のため実運用で衝突しない
 * - deliverToSession で二重防御に使うことで **案 F (session 経路 stub 適用漏れ) の症状も吸収**
 *   (agent_group_id 不整合による key mismatch を回避)
 *
 * production 経路は Set が常に空 = 挙動不変。
 */
const stubDeliveryByMg = new Set<string>();

function stubMgKey(channelType: string | null, platformId: string | null): string {
  return `${channelType ?? ''}:${platformId ?? ''}`;
}

export function addStubDeliveryByMg(channelType: string, platformId: string): void {
  stubDeliveryByMg.add(stubMgKey(channelType, platformId));
}

export function removeStubDeliveryByMg(channelType: string, platformId: string): void {
  stubDeliveryByMg.delete(stubMgKey(channelType, platformId));
}

export function isStubDeliveryByMg(channelType: string | null, platformId: string | null): boolean {
  if (stubDeliveryByMg.size === 0) return false;
  return stubDeliveryByMg.has(stubMgKey(channelType, platformId));
}

/** test 用 backdoor。 */
export function _resetStubDeliveryByMgForTest(): void {
  stubDeliveryByMg.clear();
}

export interface ChannelDeliveryAdapter {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
    files?: OutboundFile[],
  ): Promise<string | undefined>;
  // status 引数の意味は TypingStatus (channels/adapter.ts) を参照。
  setTyping?(channelType: string, platformId: string, threadId: string | null, status?: TypingStatus): Promise<void>;
}

let deliveryAdapter: ChannelDeliveryAdapter | null = null;
let activePolling = false;
let sweepPolling = false;

/**
 * Callbacks fired when the delivery adapter is first set (and again if it's
 * replaced). Lets modules that need the adapter at boot (e.g. approvals →
 * OneCLI handler) hook in without core calling into the module directly.
 *
 * Not a general-purpose registry — narrow lifecycle hook only.
 */
type AdapterReadyCallback = (adapter: ChannelDeliveryAdapter) => void | Promise<void>;
const adapterReadyCallbacks: AdapterReadyCallback[] = [];

/** Current delivery adapter or null if not yet set. Modules use this in live
 *  message-flow handlers where the adapter is guaranteed to be set. For
 *  boot-time setup (before the adapter is ready), use onDeliveryAdapterReady. */
export function getDeliveryAdapter(): ChannelDeliveryAdapter | null {
  return deliveryAdapter;
}

export function onDeliveryAdapterReady(cb: AdapterReadyCallback): void {
  adapterReadyCallbacks.push(cb);
  if (deliveryAdapter) {
    // Already set — fire immediately so late registrations still run.
    void Promise.resolve()
      .then(() => cb(deliveryAdapter as ChannelDeliveryAdapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

export function setDeliveryAdapter(adapter: ChannelDeliveryAdapter): void {
  deliveryAdapter = adapter;
  // Forward to the typing module so it can fire setTyping on its own
  // interval. Direct call, not a registry — typing is a default module.
  setTypingAdapter(adapter);
  for (const cb of adapterReadyCallbacks) {
    void Promise.resolve()
      .then(() => cb(adapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

/** Start the active container poll loop (~1s). */
export function startActiveDeliveryPoll(): void {
  if (activePolling) return;
  activePolling = true;
  pollActive();
}

/** Start the sweep poll loop (~60s). */
export function startSweepDeliveryPoll(): void {
  if (sweepPolling) return;
  sweepPolling = true;
  pollSweep();
}

async function pollActive(): Promise<void> {
  if (!activePolling) return;

  try {
    const sessions = getRunningSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
      // container_state.current_tool を 1s poll で読んで typing status を更新。
      // deliverSessionMessages と直列で問題ない (inflightDeliveries は delivery 用の別集合、
      // refreshProgressStatus は同期実行 + updateTypingStatus の変化時 no-op で吸収)。
      // best-effort: progress-status failure は delivery を殺さない。
      await refreshProgressStatus(session).catch((err) => {
        log.warn('progress-status refresh failed', {
          event: 'progress.status.refresh_failed',
          session_id: session.id,
          err,
        });
      });
    }
  } catch (err) {
    log.error('Active delivery poll error', { err });
  }

  setTimeout(pollActive, ACTIVE_POLL_MS);
}

async function pollSweep(): Promise<void> {
  if (!sweepPolling) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Sweep delivery poll error', { err });
  }

  setTimeout(pollSweep, SWEEP_POLL_MS);
}

export async function deliverSessionMessages(session: Session): Promise<void> {
  // Reject re-entry from a concurrent poll on the same session — see the
  // comment on inflightDeliveries above.
  if (inflightDeliveries.has(session.id)) return;
  inflightDeliveries.add(session.id);

  try {
    await drainSession(session);
  } finally {
    inflightDeliveries.delete(session.id);
  }
}

async function drainSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  let outDb: Database.Database;
  let inDb: Database.Database;
  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch (err) {
    // pre-spawn 判定は session-manager.ts の isPreSpawnDbOpenError に集約 (ENOENT +
    // SQLITE_CANTOPEN の 2 code で「初回 spawn 前」の正常経路 = poller.ts と共通化)。
    // それ以外 (EACCES / EMFILE / EIO 等の パーミッション / I/O エラー) は本番
    // LOG_LEVEL=info でも見える warn に倒す。
    // 当初は ENOENT のみ debug 分岐で、SQLITE_CANTOPEN (better-sqlite3 readonly open 特有)
    // が warn に落ちて cold start ごとにノイズが出ていた実測経路。
    // poller.ts の SQLITE_CANTOPEN 判定と対称に是正。
    const code = (err as NodeJS.ErrnoException)?.code;
    const ctx = { session_id: session.id, agent_group_id: agentGroup.id, err_code: code, err };
    if (isPreSpawnDbOpenError(code)) {
      log.debug('drainSession: db open skipped (pre-spawn)', { event: 'delivery.db_open_skipped', ...ctx });
    } else {
      log.warn('drainSession: db open failed', { event: 'delivery.db_open_failed', ...ctx });
    }
    return;
  }

  try {
    // Read all due messages from outbound.db (read-only)
    const allDue = getDueOutboundMessages(outDb);
    if (allDue.length === 0) return;

    // Filter out already-delivered messages using inbound.db's delivered table
    const delivered = getDeliveredIds(inDb);
    const undelivered = allDue.filter((m) => !delivered.has(m.id));
    if (undelivered.length === 0) return;

    // Ensure platform_message_id column exists (migration for existing sessions)
    migrateDeliveredTable(inDb);

    for (const msg of undelivered) {
      try {
        const platformMsgId = await deliverMessage(msg, session, inDb);
        markDelivered(inDb, msg.id, platformMsgId ?? null);
        deliveryAttempts.delete(msg.id);

        // Pause the typing indicator after a real user-facing message
        // lands on the user's screen, so the client has time to visually
        // clear the indicator before the next heartbeat tick brings it
        // back. Skip the pause for internal traffic (system actions,
        // agent-to-agent routing) — the user doesn't see those and
        // shouldn't get a gap in their typing indicator for them.
        if (msg.kind !== 'system' && msg.channel_type !== 'agent') {
          pauseTypingRefreshAfterDelivery(session.id);
        }
      } catch (err) {
        const attempts = (deliveryAttempts.get(msg.id) ?? 0) + 1;
        deliveryAttempts.set(msg.id, attempts);
        if (attempts >= MAX_DELIVERY_ATTEMPTS) {
          log.error('Message delivery failed permanently, giving up', {
            messageId: msg.id,
            sessionId: session.id,
            attempts,
            err,
          });
          markDeliveryFailed(inDb, msg.id);
          deliveryAttempts.delete(msg.id);
        } else {
          log.warn('Message delivery failed, will retry', {
            messageId: msg.id,
            sessionId: session.id,
            attempt: attempts,
            maxAttempts: MAX_DELIVERY_ATTEMPTS,
            err,
          });
        }
      }
    }
  } finally {
    outDb.close();
    inDb.close();
  }
}

async function deliverMessage(
  msg: {
    id: string;
    kind: string;
    platform_id: string | null;
    channel_type: string | null;
    thread_id: string | null;
    content: string;
    in_reply_to: string | null;
  },
  session: Session,
  inDb: Database.Database,
): Promise<string | undefined> {
  if (!deliveryAdapter) {
    log.warn('No delivery adapter configured, dropping message', { id: msg.id });
    return;
  }

  const content = JSON.parse(msg.content);

  // System actions — handle internally (schedule_task, cancel_task, etc.)
  if (msg.kind === 'system') {
    await handleSystemAction(content, session, inDb);
    return;
  }

  // Agent-to-agent — route to target session via the agent-to-agent module.
  // Guarded by the channel_type check. If the module isn't installed the
  // `agent_destinations` table won't exist and `routeAgentMessage`'s permission
  // check will throw, which falls into the normal retry → mark-failed path.
  if (msg.channel_type === 'agent') {
    if (!hasTable(getDb(), 'agent_destinations')) {
      throw new Error(`agent-to-agent module not installed — cannot route message ${msg.id}`);
    }
    const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');
    await routeAgentMessage(msg, session);
    return;
  }

  // Permission check: the source agent must be allowed to deliver to this
  // channel destination. Two ways it passes:
  //
  //   1. The target is the session's own origin chat (session.messaging_group_id
  //      matches). An agent can always reply to the chat it was spawned from;
  //      requiring a destinations row for the obvious case is a footgun.
  //
  //   2. Otherwise, the agent must have an explicit agent_destinations row
  //      targeting that messaging group. createMessagingGroupAgent() inserts
  //      these automatically when wiring, so an operator wiring additional
  //      chats to the agent doesn't need a separate ACL step.
  //
  // Failures throw — unlike a silent `return`, an Error falls into the retry
  // path in deliverSessionMessages and eventually marks the message as failed
  // (instead of marking it delivered when nothing was actually delivered,
  // which was the pre-refactor bug).
  if (msg.channel_type && msg.platform_id) {
    const mg = getMessagingGroupByPlatform(msg.channel_type, msg.platform_id);
    if (!mg) {
      throw new Error(`unknown messaging group for ${msg.channel_type}/${msg.platform_id} (message ${msg.id})`);
    }
    const isOriginChat = session.messaging_group_id === mg.id;
    // Guarded: without the agent-to-agent module, `agent_destinations`
    // doesn't exist and we permit all non-origin channel sends (the
    // origin-chat case is always allowed regardless). Inlined SQL instead
    // of importing `hasDestination` so core doesn't depend on the module.
    if (!isOriginChat && hasTable(getDb(), 'agent_destinations')) {
      const row = getDb()
        .prepare(
          'SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ? LIMIT 1',
        )
        .get(session.agent_group_id, 'channel', mg.id);
      if (!row) {
        throw new Error(
          `unauthorized channel destination: ${session.agent_group_id} cannot send to ${mg.channel_type}/${mg.platform_id}`,
        );
      }
    }
  }

  // Track pending questions for ask_user_question flow.
  // Guarded: without the interactive module, `pending_questions` doesn't
  // exist and we skip persistence — the card still delivers to the user,
  // but the response path has nowhere to land and will log unclaimed.
  if (content.type === 'ask_question' && content.questionId && hasTable(getDb(), 'pending_questions')) {
    const title = content.title as string | undefined;
    const rawOptions = content.options as unknown;
    if (!title || !Array.isArray(rawOptions)) {
      log.error('ask_question missing required title/options — not persisting', {
        questionId: content.questionId,
      });
    } else {
      const inserted = createPendingQuestion({
        question_id: content.questionId,
        session_id: session.id,
        message_out_id: msg.id,
        platform_id: msg.platform_id,
        channel_type: msg.channel_type,
        thread_id: msg.thread_id,
        title,
        options: normalizeOptions(rawOptions as never),
        created_at: new Date().toISOString(),
      });
      if (inserted) {
        log.info('Pending question created', { questionId: content.questionId, sessionId: session.id });
      }
    }
  }

  // Channel delivery
  if (!msg.channel_type || !msg.platform_id) {
    log.warn('Message missing routing fields', { id: msg.id });
    return;
  }

  // verify 用 stub-outbound の skip 分岐。verify 中に `ncl messages send
  // --stub-outbound` から key を仕込むと、この session への実 channel deliver を silent
  // skip する (production 経路は Set 空 = 常に false = 挙動不変)。stub 対象は
  // markDelivered だけ通り、outbox cleanup も走らせる (通常 deliver の副作用と対称)。
  // key は 3-tuple (agent_group_id + channel_type + platform_id) で thread_id を
  // 含めない。詳細は stubTargetKey の JSDoc を参照。
  // log level は info。本番 `LOG_LEVEL=info` でも Cloud Logging に届くようにして
  // 「verify 中に何を skip したか」の運用調査を可能にする。
  // issue #155 で 3-tuple (既存) と 2-tuple (新設) の OR 判定で二重防御。
  // session 経路の agent_group_id 不整合による key mismatch を吸収する。
  if (
    isStubOutboundTarget(session.agent_group_id, msg.channel_type, msg.platform_id) ||
    isStubDeliveryByMg(msg.channel_type, msg.platform_id)
  ) {
    log.info('delivery skipped by stub-outbound (verify path)', {
      event: 'delivery.stub_outbound.skipped',
      session_id: session.id,
      agent_group_id: session.agent_group_id,
      channel_type: msg.channel_type,
      platform_id: msg.platform_id,
      thread_id: msg.thread_id,
      message_id: msg.id,
    });
    clearOutbox(session.agent_group_id, session.id, msg.id);
    return;
  }

  // Read file attachments from outbox if the content declares files.
  // File I/O lives in session-manager.ts (symmetric with inbound
  // extractAttachmentFiles) — delivery just hands buffers to the adapter.
  const files =
    Array.isArray(content.files) && content.files.length > 0
      ? readOutboxFiles(session.agent_group_id, session.id, msg.id, content.files as string[])
      : undefined;

  const platformMsgId = await deliveryAdapter.deliver(
    msg.channel_type,
    msg.platform_id,
    msg.thread_id,
    msg.kind,
    msg.content,
    files,
  );
  log.info('Message delivered', {
    id: msg.id,
    channelType: msg.channel_type,
    platformId: msg.platform_id,
    platformMsgId,
    fileCount: files?.length,
  });

  clearOutbox(session.agent_group_id, session.id, msg.id);

  return platformMsgId;
}

/**
 * Delivery action registry.
 *
 * Modules register handlers for system-kind outbound message actions via
 * `registerDeliveryAction`. Core checks the registry first in
 * `handleSystemAction` and falls through to the inline switch when no
 * handler is registered. The switch will shrink as modules are extracted
 * (scheduling, approvals, agent-to-agent) and eventually only its default
 * branch remains.
 *
 * Default when no handler registered and the switch doesn't match: log
 * "Unknown system action" and return.
 */
export type DeliveryActionHandler = (
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
) => Promise<void>;

const actionHandlers = new Map<string, DeliveryActionHandler>();

export function registerDeliveryAction(action: string, handler: DeliveryActionHandler): void {
  if (actionHandlers.has(action)) {
    log.warn('Delivery action handler overwritten', { action });
  }
  actionHandlers.set(action, handler);
}

/**
 * Handle system actions from the container agent.
 * These are written to messages_out because the container can't write to inbound.db.
 * The host applies them to inbound.db here.
 */
async function handleSystemAction(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const action = content.action as string;
  log.info('System action from agent', { sessionId: session.id, action });

  const registered = actionHandlers.get(action);
  if (registered) {
    await registered(content, session, inDb);
    return;
  }

  log.warn('Unknown system action', { action });
}

export function stopDeliveryPolls(): void {
  activePolling = false;
  sweepPolling = false;
}
