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
  // M4-F Phase 4: `status` 引数追加。日本語の進行ステート文言 (「Web 検索中」等) を
  // vendor 経由で Slack `assistant.threads.setStatus` に forward する。undefined → vendor
  // default (`"Typing..."`)、非空 string → カスタム文言、null → clear 相当。
  setTyping?(channelType: string, platformId: string, threadId: string | null, status?: string | null): Promise<void>;
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
  currentStatus: string | null;
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
  status: string | null,
): Promise<void> {
  try {
    // M4-F Phase 4: `status ?? undefined` で null → undefined 正規化 (vendor 側は
    // undefined を `"Typing..."` fallback、null は明示クリア相当だが vendor 実装依存)。
    await adapter?.setTyping?.(channelType, platformId, threadId, status ?? undefined);
  } catch {
    // Typing is best-effort — don't let it fail delivery or routing.
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
    triggerTyping(channelType, platformId, threadId, existing.currentStatus).catch(() => {});
    existing.startedAt = Date.now();
    existing.pausedUntil = 0;
    return;
  }

  // Immediate tick + periodic refresh. 初回は status なし (null) で vendor default 文言。
  triggerTyping(channelType, platformId, threadId, null).catch(() => {});
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
      triggerTyping(entry.channelType, entry.platformId, entry.threadId, entry.currentStatus).catch(() => {});
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
    currentStatus: null,
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
 *   - refresh loop の 4s tick が currentStatus を毎回 forward (Slack 2 分自動クリア回避)
 */
export function updateTypingStatus(sessionId: string, status: string | null): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  if (entry.currentStatus === status) return;
  entry.currentStatus = status;
  // 即発火: 次の 4s tick を待たず変化点で 1 回送信 (UX 反応性)
  triggerTyping(entry.channelType, entry.platformId, entry.threadId, status).catch(() => {});
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
