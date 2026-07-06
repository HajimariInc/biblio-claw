/**
 * ncl `messages send` — verify / debug 用の発話注入 verb (host-only)。
 *
 * M4-F Phase 5 で新設。verify-m4-f.sh から任意の messaging_group に対して patron 命令を
 * programmatic に発火するために routeInbound を直呼びする。CLI channel (`cli.sock` +
 * `pnpm run chat`) は platformId が `local` に固定されるため hybrid wire (Slack DM MG)
 * を発火できないという構造制約を、host 側 ncl 経路のバックドアで解消する設計。
 *
 * production 経路は本 verb を使わない (agent caller は host-only guard で forbidden、
 * host caller が明示的に叩くケースは verify script のみ)。
 *
 * Contract:
 *   - `stub_outbound=true` を指定すると、対象 session への実 channel deliver は silent skip
 *     (実 Slack DM 通知を送らずに済む)。verify script はこれを常に true にして副作用ゼロを担保。
 *   - `wait_ms` timeout までに新規 messages_out.chat 行が到達したらそれを stdout に返す。
 *     timeout 超過なら空配列 + delivered_count=0 で return (fail 扱いは呼出側で判断)。
 *   - InboundEvent.message.isMention=true を明示 (evaluateEngage の mention 経路を必ず
 *     通す = wiring の engage_mode 揺れを吸収)。
 */
import { randomUUID } from 'node:crypto';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { findSessionForAgent, findSessionByAgentGroup } from '../../db/sessions.js';
import { getGlobalAdmins, getOwners, getAdminsOfAgentGroup } from '../../modules/permissions/db/user-roles.js';
import { log } from '../../log.js';
import { type OutboundMessage } from '../../db/session-db.js';
// removeStub*: Approach 1 対応 (race avoidance) で削除。将来 approach 2/3 に切り替える場合は
// removeStubOutboundTarget / removeStubDeliveryByMg を再 import し finally block に戻す。
import { addStubOutboundTarget, addStubDeliveryByMg } from '../../delivery.js';
import { routeInbound } from '../../router.js';
import { isPreSpawnDbOpenError, openOutboundDb } from '../../session-manager.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { registerResource } from '../crud.js';

const DEFAULT_WAIT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

/**
 * agent_group に紐づく「発話 sender」の user_id を解決する。
 *   1. --user-id が明示されていればそれを使う
 *   2. agent_group scoped admin の先頭
 *   3. global admin の先頭
 *   4. owner の先頭
 * どれも見つからなければ 'ncl:host' fallback (verify 経路の緊急退路、production では起きない)。
 */
export function resolveSenderUserId(agentGroupId: string, explicitUserId: string | undefined): string {
  if (explicitUserId) return explicitUserId;
  const scoped = getAdminsOfAgentGroup(agentGroupId);
  if (scoped.length > 0) return scoped[0].user_id;
  const globals = getGlobalAdmins();
  if (globals.length > 0) return globals[0].user_id;
  const owners = getOwners();
  if (owners.length > 0) return owners[0].user_id;
  return 'ncl:host';
}

/**
 * DB open エラーを既存の pre-spawn 規律 (`delivery.ts:260` / `poller.ts:46`) と対称に分岐する。
 * PR #154 review CR-5 対応: 従来 catch-all で全 error を silent 化していた結果、EACCES /
 * SQLITE_CORRUPT / EMFILE 等の非 pre-spawn error まで「session がまだ spawn していない」と
 * 誤認して silent に retry timeout していた。`isPreSpawnDbOpenError` は ENOENT + SQLITE_CANTOPEN
 * のみ pre-spawn (debug) 扱いし、それ以外は warn で可視化する。
 */
function classifyDbOpenError(
  err: unknown,
  ctx: { agentGroupId: string; sessionId: string; caller: 'currentMaxOutboundSeq' | 'pollOutbound' },
): void {
  const code = (err as NodeJS.ErrnoException)?.code;
  const payload = {
    session_id: ctx.sessionId,
    agent_group_id: ctx.agentGroupId,
    caller: ctx.caller,
    err_code: code,
    err,
  };
  if (isPreSpawnDbOpenError(code)) {
    log.debug('ncl messages send: outbound.db open skipped (pre-spawn)', {
      event: 'ncl.messages.send.db_open_skipped',
      ...payload,
    });
  } else {
    log.warn('ncl messages send: outbound.db open failed', {
      event: 'ncl.messages.send.db_open_failed',
      ...payload,
    });
  }
}

/** 現在の messages_out max seq を安全に取得する (session が未作成 or DB open 失敗時は 0)。 */
function currentMaxOutboundSeq(agentGroupId: string, sessionId: string): number {
  try {
    const db = openOutboundDb(agentGroupId, sessionId);
    try {
      const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number };
      return row.m ?? 0;
    } finally {
      db.close();
    }
  } catch (err) {
    classifyDbOpenError(err, { agentGroupId, sessionId, caller: 'currentMaxOutboundSeq' });
    return 0;
  }
}

/**
 * outbound.db を polling して from_seq 超えの chat/system row を集める。timeout までに
 * 検出できなければ空配列 + timeout=true。500ms tick を wait_ms に達するまで繰り返す。
 */
async function pollOutbound(
  agentGroupId: string,
  sessionId: string,
  fromSeq: number,
  waitMs: number,
): Promise<{ messages: OutboundMessage[]; timedOut: boolean }> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    let msgs: OutboundMessage[] = [];
    try {
      const db = openOutboundDb(agentGroupId, sessionId);
      try {
        msgs = (
          db.prepare('SELECT * FROM messages_out WHERE seq > ? ORDER BY seq ASC').all(fromSeq) as OutboundMessage[]
        ).filter((m) => m.kind === 'chat' || m.kind === 'system');
      } finally {
        db.close();
      }
    } catch (err) {
      // PR #154 review CR-5 対応: pre-spawn (debug) vs 非 pre-spawn (warn) の 2 分岐
      classifyDbOpenError(err, { agentGroupId, sessionId, caller: 'pollOutbound' });
      msgs = [];
    }
    if (msgs.length > 0) return { messages: msgs, timedOut: false };
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { messages: [], timedOut: true };
}

registerResource({
  name: 'message',
  plural: 'messages',
  table: 'messages_in',
  description:
    'Inbound messages (host-owned inbound.db per session). host-only debug 経路として `send` verb のみ露出 = 任意の messaging_group への発話を routeInbound 直呼びで注入し、outbound.db を polling して応答を stdout に返す。verify script (verify-m4-f.sh) が本 verb で hybrid Slack DM MG を programmatic に発火する。generic list/get/create/update/delete は提供しない。',
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    send: {
      access: 'hidden',
      description:
        'Inject a message into a wired messaging group via routeInbound. Host-only (agent callers are rejected). Use --agent-group-id, --messaging-group-id, --text; optional --user-id, --thread-id, --stub-outbound, --wait-ms, --from-seq.',
      handler: async (args, ctx) => {
        // 二重防御: dispatch.ts 側でも agent caller は forbidden で return するが、本 handler
        // 側でも明示 throw (Task 1 GOTCHA + Task 4 対称化)。
        if (ctx.caller !== 'host') {
          throw new Error('messages send is host-only (agent callers cannot invoke this verb)');
        }

        const agentGroupId = args.agent_group_id as string;
        const messagingGroupId = args.messaging_group_id as string;
        const text = args.text as string;
        const explicitUserId = args.user_id as string | undefined;
        const explicitThreadId = args.thread_id as string | undefined;
        const stubOutbound = args.stub_outbound === true || args.stub_outbound === 'true' || args.stub_outbound === 1;
        // PR #154 review IM-4 対応: 数値引数の NaN 経路を fail-fast 化。
        // 従来 `Math.max(0, Number('abc')) = NaN` → `Date.now() < NaN` は常に false →
        // pollOutbound が一度も回らず即 `timedOut: true` で silent 退化していた。
        const waitMsRaw = args.wait_ms;
        const waitMs = waitMsRaw === undefined || waitMsRaw === null ? DEFAULT_WAIT_MS : Number(waitMsRaw);
        if (!Number.isFinite(waitMs) || waitMs < 0) {
          throw new Error(`--wait-ms must be a non-negative number (received: ${String(waitMsRaw)})`);
        }
        let explicitFromSeq: number | undefined;
        if (args.from_seq !== undefined && args.from_seq !== null) {
          const parsed = Number(args.from_seq);
          if (!Number.isFinite(parsed) || parsed < 0) {
            throw new Error(`--from-seq must be a non-negative number (received: ${String(args.from_seq)})`);
          }
          explicitFromSeq = parsed;
        }

        if (!agentGroupId) throw new Error('--agent-group-id is required');
        if (!messagingGroupId) throw new Error('--messaging-group-id is required');
        if (!text) throw new Error('--text is required');

        const agentGroup = getAgentGroup(agentGroupId);
        if (!agentGroup) throw new Error(`agent group not found: ${agentGroupId}`);
        const mg = getMessagingGroup(messagingGroupId);
        if (!mg) throw new Error(`messaging group not found: ${messagingGroupId}`);

        const senderUserId = resolveSenderUserId(agentGroupId, explicitUserId);
        const threadId = explicitThreadId ?? mg.platform_id;

        // 事前に既存 session (per-thread / shared / agent-shared のどれでも first hit を使う)
        // の max seq を控える。routeInbound 実行後の poll で seq > from_seq を検出。
        const preSession =
          findSessionForAgent(agentGroupId, messagingGroupId, threadId) ?? findSessionByAgentGroup(agentGroupId);
        const fromSeq = explicitFromSeq ?? (preSession ? currentMaxOutboundSeq(agentGroupId, preSession.id) : 0);

        if (stubOutbound) {
          // PR #154 review CR-1 対応: 3-tuple key (agent_group_id + channel_type + platform_id)。
          // thread_id は session_mode='shared' で null 化される仕様のため key から除外。
          // 詳細は `src/delivery.ts:stubTargetKey` の JSDoc 参照。
          addStubOutboundTarget(agentGroupId, mg.channel_type, mg.platform_id);
          // issue #155 案 B 対応: 2-tuple key を追加登録。in-secure reject / notify-admin /
          // ADK fallback / session 経路 (agent_group 不整合時の二重防御) の 4 経路を塞ぐ。
          addStubDeliveryByMg(mg.channel_type, mg.platform_id);
        }

        const requestId = randomUUID();
        const eventId = `ncl-${requestId}`;
        const event: InboundEvent = {
          channelType: mg.channel_type,
          platformId: mg.platform_id,
          threadId,
          message: {
            id: eventId,
            kind: 'chat',
            content: JSON.stringify({
              text,
              sender: agentGroup.name ?? 'ncl-sender',
              senderId: senderUserId,
            }),
            timestamp: new Date().toISOString(),
            isMention: true,
            isGroup: mg.is_group === 1,
          },
        };

        log.info('ncl messages send: routeInbound', {
          event: 'ncl.messages.send.dispatch',
          request_id: requestId,
          agent_group_id: agentGroupId,
          messaging_group_id: messagingGroupId,
          channel_type: mg.channel_type,
          platform_id: mg.platform_id,
          thread_id: threadId,
          stub_outbound: stubOutbound,
          wait_ms: waitMs,
          from_seq: fromSeq,
        });

        try {
          await routeInbound(event);

          // routeInbound 実行後、session が作成 or 解決されているはず。再検索 (per-thread
          // 経路で新規 session が作られている場合を吸収)。
          const postSession =
            findSessionForAgent(agentGroupId, messagingGroupId, threadId) ??
            findSessionByAgentGroup(agentGroupId) ??
            preSession;

          let messages: OutboundMessage[] = [];
          let timedOut = false;
          let sessionId: string | null = null;
          if (postSession) {
            sessionId = postSession.id;
            const result = await pollOutbound(agentGroupId, postSession.id, fromSeq, waitMs);
            messages = result.messages;
            timedOut = result.timedOut;
          } else {
            // session が作成されなかった (in-secure early return / gate mismatch / drop)。
            // 応答は log と patron 定型文 (adapter 直呼び) 経路にのみ流れる = polling 対象外。
            log.info('ncl messages send: no session created (in-secure / gate mismatch / drop path)', {
              event: 'ncl.messages.send.no_session',
              request_id: requestId,
            });
          }

          return {
            request_id: requestId,
            event_id: eventId,
            session_id: sessionId,
            channel_type: mg.channel_type,
            platform_id: mg.platform_id,
            thread_id: threadId,
            from_seq: fromSeq,
            delivered_count: messages.length,
            timed_out: timedOut,
            stub_outbound: stubOutbound,
            messages: messages.map((m) => ({
              id: m.id,
              kind: m.kind,
              seq: m.seq,
              content: m.content,
            })),
          };
        } finally {
          // issue #155 Approach 1 対応: **removeStub は呼ばず、Pod restart まで Set に残す**。
          //
          // 従来の設計 (handler finally で removeStub 呼出) には race condition があった:
          //   t=0s   handler が addStub → routeInbound → session 作成 → agent 走行 (cold start 30-60s)
          //   t=??   pollOutbound が wait_ms 内に応答検出 or timeout で return
          //   t=??   handler 終了、finally で removeStub (Set 空)
          //   t=??   ★ delivery poll (別 loop) が agent 応答 messages_out を pull → stub check → Set 空 → 実 deliver
          //
          // Agent 応答が pollOutbound の wait_ms を超えて生成される場合 (kubectl exec i/o timeout や
          // LLM 応答遅延)、handler 終了後に delivery poll が実 deliver 経路に流す。
          //
          // Approach 1 のトレードオフ:
          //   - production 経路は addStub を呼ばない (verify script でしか渡さない) = Set は常に空 =
          //     isStubXxx は false = 挙動不変 (production 完全影響ゼロ)
          //   - verify 実行後、Pod restart までの間 Set に entry が残る (メモリリーク) = 実質無害
          //     (verify 1 回あたり 2 entry、Pod restart で自動 clear)
          //   - 冪等 verify (Section 9 の再帰) は Set.add が idempotent = 問題なし
          //
          // 将来 approach 2/3 に切り替える場合は本 finally block を復活させ、対応する
          // delayed-clear or session-lifecycle-tied clear を追加する。
          void stubOutbound; // reference for linter (unused-var 警告回避、Set 残置は意図的)
        }
      },
    },
  },
});

// 参照: 本 file は resources/index.ts から barrel import される (Task 2 で追加)。
// verb 名は `messages-send` として registry.ts に登録される (crud.ts の customOperations 変換規則)。
export const _messagesResourceLoaded = true;

// 設計メモ: session 解決は findSessionForAgent (thread_id 直マッチ) を第一候補、
// findSessionByAgentGroup (最新 active) を fallback として並置する (`preSession` / `postSession`
// の 2 段解決)。session_mode='per-thread' で thread_id なし session が存在するケース (Fugue 経路
// など今は理論上のみ) を吸収するための defensive fallback。verify 経路は毎回 fresh session を
// 想定するため実運用では preSession/postSession の第一候補が hit する。
// PR #154 review CM-3 対応: `getSessionsByAgentGroup` import + void は本 file の実装に無関係な
// 説明コメントで誤導的だったため削除 (import 自体も撤去)。
