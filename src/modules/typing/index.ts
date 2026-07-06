/**
 * Typing indicator refresh — default module.
 *
 * Most platforms expire a typing indicator after 5–10s, so a one-shot
 * call on message arrival goes stale long before the agent finishes
 * thinking. This module keeps it alive by re-firing `setTyping` on a
 * short interval — but only while the agent is actually WORKING, gated
 * on the heartbeat file's mtime after an initial grace period.
 *
 * After delivering a user-facing message, the refresh is paused for
 * POST_DELIVERY_PAUSE_MS so the client-side indicator can visually
 * clear.
 *
 * Default module status:
 *   - Lives in src/modules/ for signaling (not really core), but ships
 *     on main and is imported directly by core. No registry, no hook.
 *   - Removing requires editing src/router.ts, src/delivery.ts, and
 *     src/container-runner.ts to drop the calls.
 */
import fs from 'fs';

import type { TypingStatus } from '../../channels/adapter.js';
import { log } from '../../log.js';
import { heartbeatPath } from '../../session-manager.js';

const TYPING_REFRESH_MS = 4000;
/**
 * Grace window from startTypingRefresh: fire typing unconditionally
 * for this long regardless of heartbeat state. Covers container
 * spawn/wake latency (5–12s on cold start before first heartbeat).
 */
const TYPING_GRACE_MS = 15000;
/**
 * After the grace window, a heartbeat must be mtimed within this
 * many ms of now to count as "agent is working." Heartbeats land
 * every few hundred ms during active work, so 6s is well above
 * the working floor and small enough to stop typing quickly when
 * the agent goes idle.
 */
const HEARTBEAT_FRESH_MS = 6000;
/**
 * After we deliver a user-facing message, pause typing for this
 * long so the client-side indicator has time to visually clear.
 * Tuned for the longest common expiry (Discord ~10s). The interval
 * stays running; ticks inside the pause just skip the setTyping call.
 */
const POST_DELIVERY_PAUSE_MS = 10000;

interface TypingAdapter {
  // status 引数の意味は TypingStatus (channels/adapter.ts) を参照。
  setTyping?(channelType: string, platformId: string, threadId: string | null, status?: TypingStatus): Promise<void>;
}

interface TypingTarget {
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  interval: NodeJS.Timeout;
  startedAt: number;
  pausedUntil: number; // epoch ms; 0 = not paused
  /**
   * M4-F Phase 4: 現在の progress-status 文言。updateTypingStatus で書き換えられ、
   * refresh loop の 4s tick が毎回 vendor に forward する (Slack 側 2 分自動クリア回避 +
   * status 継続表示)。null = 未設定 (vendor 側 default 文言に fallback)。
   */
  currentStatus: TypingStatus;
}

let adapter: TypingAdapter | null = null;
const typingRefreshers = new Map<string, TypingTarget>();

/**
 * Bind the typing module to the channel delivery adapter so it can
 * call `setTyping`. Called once by `src/delivery.ts` inside
 * `setDeliveryAdapter`. Passing a fresh adapter replaces the prior
 * binding and leaves active refreshers in place (they'll use the
 * new adapter on their next tick).
 */
export function setTypingAdapter(a: TypingAdapter): void {
  adapter = a;
}

async function triggerTyping(
  channelType: string,
  platformId: string,
  threadId: string | null,
  status: TypingStatus,
  sessionId: string | null = null,
  agentGroupId: string | null = null,
): Promise<void> {
  const adapterSupportsTyping = typeof adapter?.setTyping === 'function';
  try {
    // TypingStatus (channels/adapter.ts) の内部設計語彙では null (明示クリア) と
    // undefined (未指定) を区別するが、vendor 境界では両者とも `"Typing..."` fallback に
    // 収束する。`status ?? undefined` で null → undefined 正規化して vendor 実装契約に合わせる。
    await adapter?.setTyping?.(channelType, platformId, threadId, status ?? undefined);
    // M4-F Phase 5: 成功パス observability。「送信を試みた事実」を確定的に記録する。
    // vendor 内部 catch (rate limit / 401) は本 code から観測不能なため outcome='triggered'
    // に統一 (握りつぶし事案は vendor 生ログ `[chat-sdk:slack]` prefix と timestamp 突合で
    // 復元、runbook §M4-F Phase 5 罠に手順集約)。
    log.info('progress.status.transition', {
      event: 'progress.status.transition',
      source: 'triggerTyping',
      session_id: sessionId,
      agent_group_id: agentGroupId,
      channel_type: channelType,
      platform_id: platformId,
      thread_id: threadId,
      status,
      adapter_supports_typing: adapterSupportsTyping,
      outcome: 'triggered',
    });
  } catch (err) {
    // Typing is best-effort — don't let it fail delivery or routing.
    // ただし PR #145 review C2 で判明: vendor (@chat-adapter/slack) が `logger:'silent'`
    // で初期化されているため vendor 側の warn log も出ない = 完全不可視化。既定 4s refresh +
    // 1s poller の高頻度呼出しなので同一 error は multiplicative に鳴りうる = log flooding
    // 防止のため warn 発火は本来 debounce したいが、まず可視化を優先 (重要度は Slack scope 剥奪
    // + rate limit 429 の検知 > 大量ノイズの回避)。debounce は将来 issue 化。
    log.warn('setTyping failed (best-effort, routing continues)', {
      event: 'progress.status.set_typing_failed',
      channel_type: channelType,
      err: err instanceof Error ? err.message : String(err),
    });
    // M4-F Phase 5: 失敗パスも progress.status.transition に含めて集計を dashboard 化可能に。
    log.info('progress.status.transition', {
      event: 'progress.status.transition',
      source: 'triggerTyping',
      session_id: sessionId,
      agent_group_id: agentGroupId,
      channel_type: channelType,
      platform_id: platformId,
      thread_id: threadId,
      status,
      adapter_supports_typing: adapterSupportsTyping,
      outcome: 'failed',
    });
  }
}

function isHeartbeatFresh(agentGroupId: string, sessionId: string): boolean {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    const stat = fs.statSync(hbPath);
    return Date.now() - stat.mtimeMs < HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
}

export function startTypingRefresh(
  sessionId: string,
  agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  initialStatus: TypingStatus = null,
): void {
  const existing = typingRefreshers.get(sessionId);
  if (existing) {
    // Already refreshing. Fire an immediate tick for the new inbound
    // event and reset the grace window — the new message restarts
    // the container-wake latency budget. Also clear any lingering
    // post-delivery pause: a new inbound means the user expects
    // typing to show immediately.
    //
    // M4-F Phase 4: 直近 status を維持したまま refresh 再開 (新 inbound で status を
    // リセットしない = poller が次 tick で新しい tool 名を反映する)。
    // initialStatus 引数は re-inbound では無視 (既存 currentStatus を優先)。
    // .catch は on-purpose dead: triggerTyping は内部で全 error を catch + log.warn 化
    // (C2 対応、event: 'progress.status.set_typing_failed') するため契約上 reject しない。
    // 将来 triggerTyping が rethrow に変わったら unhandledRejection 撲滅の保険として残す。
    triggerTyping(channelType, platformId, threadId, existing.currentStatus, sessionId, agentGroupId).catch(() => {});
    existing.startedAt = Date.now();
    existing.pausedUntil = 0;
    return;
  }

  // Immediate tick + periodic refresh. initialStatus を渡すと最初の発火から
  // その status で送る = 直後の updateTypingStatus 呼出との race を撲滅する
  // (PR #145 実機で発見: startTypingRefresh(null) + updateTypingStatus('container 起動中')
  //  の 2 発 fire-and-forget が Slack API 到達順で「Typing...」が後勝ちする経路あり)。
  // .catch on-purpose dead (triggerTyping contract: never rejects、上の説明参照)。
  triggerTyping(channelType, platformId, threadId, initialStatus, sessionId, agentGroupId).catch(() => {});
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const entry = typingRefreshers.get(sessionId);
    if (!entry) return; // stopped externally since this tick was scheduled

    // Inside a post-delivery pause: skip setTyping but keep the
    // interval running so we resume automatically once the pause
    // expires.
    if (entry.pausedUntil > Date.now()) return;

    const withinGrace = Date.now() - entry.startedAt < TYPING_GRACE_MS;
    if (withinGrace || isHeartbeatFresh(entry.agentGroupId, sessionId)) {
      // .catch on-purpose dead (triggerTyping contract: never rejects、C2 対応済)。
      triggerTyping(
        entry.channelType,
        entry.platformId,
        entry.threadId,
        entry.currentStatus,
        sessionId,
        entry.agentGroupId,
      ).catch(() => {});
      return;
    }

    // Out of grace AND heartbeat stale — agent is idle, stop refreshing.
    clearInterval(entry.interval);
    typingRefreshers.delete(sessionId);
  }, TYPING_REFRESH_MS);
  // unref so a stale refresher can't hold the event loop alive.
  interval.unref();
  typingRefreshers.set(sessionId, {
    agentGroupId,
    channelType,
    platformId,
    threadId,
    interval,
    startedAt,
    pausedUntil: 0,
    currentStatus: initialStatus,
  });
}

/**
 * M4-F Phase 4: active な typing refresh の現在 status を書き換える。
 *
 * refresh loop の次 4s tick が新 status を vendor に forward するが、UX 反応性のため
 * 「変化検知点で 1 回即発火」も併用する。**同値時 no-op は rate limit ガードの主機構** =
 * poller が 1s tick で呼び出しても、tool 未変化なら追加 API 呼出しなし。
 *
 * Contract:
 *   - session が typingRefreshers に居ない場合 (未起動 / stop 済) は no-op で throw しない
 *   - 前値と同一 status は no-op (rate limit 節約)
 *   - null → 非 null、非 null → null、A → B の遷移は即 1 回発火
 *   - **pause 中 (pausedUntil > Date.now()) は状態更新のみで即発火は skip**、次 pause 明け
 *     tick が forward する (PR #145 review code-reviewer IM-2 対応: 実応答直後 10 秒間の
 *     `pauseTypingRefreshAfterDelivery` が周期 tick 側では尊重されているのに、poller の
 *     1s tick から呼ばれる updateTypingStatus が pause を無視して発火する race を解消)
 *   - refresh loop の 4s tick が currentStatus を毎回 forward (Slack 2 分自動クリア回避)
 */
export function updateTypingStatus(sessionId: string, status: TypingStatus): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  const previousStatus = entry.currentStatus;
  if (previousStatus === status) return;
  entry.currentStatus = status;
  // M4-F Phase 5: 遷移点の観測 log。previousStatus を含めることで status 履歴を復元可能に。
  // pause 中の状態変更 (即発火 skip) と 実発火の両ケースで emit (「状態は遷移した」事実の記録)、
  // 実発火の outcome は triggerTyping 側 emit に載る (source='triggerTyping')。
  log.info('progress.status.transition', {
    event: 'progress.status.transition',
    source: 'updateTypingStatus',
    session_id: sessionId,
    agent_group_id: entry.agentGroupId,
    channel_type: entry.channelType,
    platform_id: entry.platformId,
    thread_id: entry.threadId,
    status,
    previous_status: previousStatus,
    adapter_supports_typing: typeof adapter?.setTyping === 'function',
    outcome: 'transition',
  });
  // pause 中は状態のみ更新 = pause 明け tick が新 status を forward する
  if (entry.pausedUntil > Date.now()) return;
  // 即発火: 次の 4s tick を待たず変化点で 1 回送信 (UX 反応性)。
  // .catch on-purpose dead (triggerTyping contract: never rejects、C2 対応済)。
  triggerTyping(entry.channelType, entry.platformId, entry.threadId, status, sessionId, entry.agentGroupId).catch(
    () => {},
  );
}

/**
 * Pause the typing refresh for POST_DELIVERY_PAUSE_MS. Called after
 * a user-facing message is delivered so the client-side indicator
 * has a chance to visually clear before the agent's next SDK event
 * pushes it back on. No-op if no refresh is active for this session.
 */
export function pauseTypingRefreshAfterDelivery(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  entry.pausedUntil = Date.now() + POST_DELIVERY_PAUSE_MS;
}

export function stopTypingRefresh(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  clearInterval(entry.interval);
  typingRefreshers.delete(sessionId);
}
