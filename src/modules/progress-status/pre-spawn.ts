/**
 * M4-F Phase 4: session 確定前 or session 概念なし経路の一発 status 発射。
 *
 * session 未確定な spawn 前段 (gate 分類中) と、session 概念がない ADK 経路 (in-process
 * dispatcher) で使う。startTypingRefresh は使わない (= session に紐付いた refresh loop の
 * 対象外)。呼出側は fire-and-forget (`void`) で、非同期 Slack API 呼出 waiting による
 * routing / dispatch の遅延を回避する。
 *
 * Slack 側 2 分自動クリアの手前で通常は spawn / gate / ADK event が進行する想定 = 単発
 * 発射で十分。session 確定後は `startTypingRefresh` に `initialStatus=PIPELINE_STATUS
 * .CONTAINER_STARTING` を渡す経路 (`router.ts:deliverToAgent` wake 分岐 = grep で「Typing
 * indicator + wake」を検索) に引き継がれる。行番号 hardcode は refactor で drift するため
 * 関数名ベースの参照に統一する (PR #145 review comment-analyzer IM-12 対応)。
 *
 * silent failure 撲滅: adapter 未登録 (registerChannelAdapter 未実行) の稀ケースは debug
 * ログを出す (gate.blocked.no_patron_adapter の warn pattern を継承しつつ、通常経路の
 * 「adapter を持たない channel (CLI 等)」でも呼ばれる = warn は noise になるため debug)。
 * setTyping 未実装の adapter (CLI / Fugue) も同様に silent skip。
 */
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { log } from '../../log.js';

import { toolNameToStatus } from './tool-status-map.js';

/**
 * session 未確定な pre-spawn 経路 (gate 分類中) 用の一発 status 発射。
 *
 * @param channelType 'slack' / 'cli' / 'fugue' 等。CLI / Fugue は setTyping 未実装で silent skip。
 * @param platformId Slack DM の場合は user id。
 * @param threadId Slack thread ts (DM は null)。
 * @param status 表示する日本語文言 (「分類中」等)。
 */
export async function emitPreSpawnStatus(
  channelType: string,
  platformId: string,
  threadId: string | null,
  status: string,
): Promise<void> {
  const adapter = getChannelAdapter(channelType);
  if (!adapter?.setTyping) {
    // adapter 未登録 or setTyping 未実装 (CLI / Fugue) は silent skip。
    // 呼出元 (router / dispatcher) は provider 分岐前に発火するため channelType が
    // typing 対応外でも吐かれるのが正常経路 = debug で noise 回避。
    log.debug('emitPreSpawnStatus: adapter has no setTyping', {
      event: 'progress.status.pre_spawn.no_adapter',
      channel_type: channelType,
    });
    return;
  }
  try {
    await adapter.setTyping(platformId, threadId, status);
  } catch (err) {
    // best-effort: pre-spawn status failure は routing / dispatch を殺さない。
    log.warn('emitPreSpawnStatus failed', {
      event: 'progress.status.pre_spawn.failed',
      channel_type: channelType,
      err,
    });
  }
}

/**
 * ADK 経路 (session 概念なし、in-process dispatcher) の per-target 直近 status を
 * 保持する module-scope Map。「変化時のみ発火」の rate-limit ガード用。
 *
 * PR #145 review code-reviewer IM-1 対応: hybrid 経路 (`updateTypingStatus` in
 * typing/index.ts) は `entry.currentStatus === status` 比較で「変化時のみ 1 回発火」
 * を強制するが、ADK 経路 (`emitAdkToolStatus`) はセッション概念がないため同等の
 * 主機構がなく、同 tool の連続呼出で `adapter.setTyping` が無駄に連続発火して
 * Slack rate limit (600/min 共有枠) を圧迫していた。
 *
 * key = `${channelType}:${platformId}:${threadId ?? ''}` で ADK invocation の
 * 「配送先」を一意に識別。ADK invocation 終了時 (dispatcher の finally) に
 * `clearAdkTargetStatus` で明示解放して累積を防ぐ。
 */
const lastAdkStatus = new Map<string, string>();

function adkTargetKey(channelType: string, platformId: string, threadId: string | null): string {
  return `${channelType}:${platformId}:${threadId ?? ''}`;
}

/**
 * ADK 経路 (session 概念なし、in-process dispatcher) 用の tool status 発射。
 *
 * dispatcher.ts の event loop で functionCall.name 検知時に呼ぶ。emitPreSpawnStatus と
 * 機能同等 (=同じ adapter 直呼び経路を辿る) だが命名を分けて grep 追跡性を上げる
 * (「ADK 経路 typing」= emitAdkToolStatus 検索で見つかる)。
 *
 * PR #145 review IM-1 対応: hybrid 経路と対称に「前回 status と同値なら skip」の
 * rate-limit ガードを内蔵。同 tool 連続呼出で Slack API が重複発火しない。
 *
 * `toolNameToStatus` が null (= 未知 tool でも generic fallback に落ちるため実質的には
 * 起こらない、defensive) 時は silent no-op。
 */
export async function emitAdkToolStatus(
  channelType: string,
  platformId: string,
  threadId: string | null,
  toolName: string,
): Promise<void> {
  const status = toolNameToStatus(toolName);
  if (!status) return;
  const key = adkTargetKey(channelType, platformId, threadId);
  if (lastAdkStatus.get(key) === status) return; // 変化時のみ = hybrid updateTypingStatus と対称
  lastAdkStatus.set(key, status);
  await emitPreSpawnStatus(channelType, platformId, threadId, status);
}

/**
 * ADK invocation 終了時に per-target 直近 status を明示解放する。dispatcher.ts の
 * finally (= 通常経路の deleteSession 前後) で呼び、次 invocation で同 tool の初回発火が
 * 通るようにする。key 累積 (メモリリーク) 防止も兼ねる。
 */
export function clearAdkTargetStatus(channelType: string, platformId: string, threadId: string | null): void {
  lastAdkStatus.delete(adkTargetKey(channelType, platformId, threadId));
}

/** test 用 backdoor: module state を reset する。production import path からは呼ばない。 */
export function _resetAdkTargetStatusForTest(): void {
  lastAdkStatus.clear();
}
