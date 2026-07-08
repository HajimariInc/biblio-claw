import { createHash } from 'node:crypto';

/**
 * Fugue ask endpoint の rate limit helper (自前 sliding window Map、
 * token digest 単位、依存追加ゼロ)。
 *
 * `handleRequest` の path 分岐直前で `checkFugueAskRateLimit(tokenDigest(token))` を呼び、
 * `{allowed: false, retryAfterSec}` が返ったら 429 + `Retry-After` header で早期 return。
 * consult / equip endpoint は ASK_PATH 条件で構造的 bypass (PRD 意思決定 #7)。
 *
 * 実装は `src/modules/progress-status/pre-spawn.ts:112, 130-175` の module-scope Map + 4
 * 点セット (Map / key helper / check&set / clear / _resetForTest) を完全踏襲。差分は
 * value 型 (`string` → `number[]` = timestamps 配列) と GC (単一 delete → window 外
 * timestamp filter) のみ。
 *
 * **atomicity**: Node.js single-threaded の event loop 前提で `checkFugueAskRateLimit`
 * は **同期関数**にする (async 化すると `await` の隙間で Map の read-modify-write が
 * 非 atomic に = 同時 61 req が全部 through する silent fail)。
 *
 * **粒度 (重要、review 中 1 対応)**: biblio-claw では handler 側 (`fugue-http.ts:652`) が
 * `tokenDigest(this.opts.expectedToken)` を key に渡す = server 側 constant で、Fugue と
 * biblio-claw が共有する **shared Bearer token 1 つ**を digest 化している。したがって
 * 認証を通過した全 request が同一 digest に集約され、実質「**per biblio-claw instance の
 * global 60 req/min rate limit**」として動作する (Contract §5.6 の cost 保護意図と整合)。
 * 将来 multi-caller / per-tenant 化する場合は、handler 側で request 由来の Bearer を渡す
 * ように切り替える (helper 本体は無変更で対応可能、key generic な設計を維持)。
 */

/** Contract §5.6 想定の default = 60 req/min */
export const FUGUE_ASK_RATE_DEFAULT_POINTS = 60;

/** Contract §5.6 想定の default sliding window = 1 分 */
export const FUGUE_ASK_RATE_DEFAULT_WINDOW_MS = 60_000;

/** timestamps 配列を token digest ごとに保持 */
const buckets = new Map<string, number[]>();

/**
 * `checkFugueAskRateLimit` の戻り値 (discriminated union)。allowed=true 時は
 * retryAfterSec を持たず、rejected 時のみ Retry-After header 用の秒数を返す。
 */
export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSec: number };

/**
 * token を 32 hex char (128 bit) に切り詰めた sha256 digest を返す。Map key 短縮 +
 * secret を全長 log/error に晒さない (先頭 32 hex で衝突リスク実質ゼロ)。
 *
 * **本 helper は generic**: 引数の `token` は「rate limit を掛けたい単位」を identifier で
 * 表す任意の文字列。biblio-claw 現行実装は `this.opts.expectedToken` を渡して instance
 * global の rate limit として動作するが (module docstring §粒度 参照)、将来 request 由来の
 * Bearer に切り替える場合も本 helper は無変更で対応する。
 */
export function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

/**
 * `FUGUE_ASK_RATE_DISABLE=1|true` で rate limit を全 bypass する escape hatch。
 * test 用 (fake timers 不要で disable 経路を通す) + 開発時の debug 用途。
 * Prod では **未設定を維持** (StatefulSet env に含めない、Phase 5 で明記)。
 * `src/gate/gate.ts` の `isGateEnabled()` と同型の env 判定 pattern。
 */
export function isFugueAskRateLimitDisabled(): boolean {
  return process.env.FUGUE_ASK_RATE_DISABLE === '1' || process.env.FUGUE_ASK_RATE_DISABLE === 'true';
}

/**
 * `FUGUE_ASK_RATE_POINTS` env override を解決。finite && > 0 なら採用、else default。
 * `Number('')` は `0` に、`Number('1a')` は `NaN` に返るため `Number.isFinite() && > 0`
 * で明示評価。
 */
export function resolveFugueAskRatePoints(): number {
  const raw = process.env.FUGUE_ASK_RATE_POINTS;
  if (raw === undefined || raw === '') return FUGUE_ASK_RATE_DEFAULT_POINTS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : FUGUE_ASK_RATE_DEFAULT_POINTS;
}

/**
 * `FUGUE_ASK_RATE_WINDOW_MS` env override を解決。`resolveFugueAskRatePoints` と同型。
 */
export function resolveFugueAskRateWindowMs(): number {
  const raw = process.env.FUGUE_ASK_RATE_WINDOW_MS;
  if (raw === undefined || raw === '') return FUGUE_ASK_RATE_DEFAULT_WINDOW_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : FUGUE_ASK_RATE_DEFAULT_WINDOW_MS;
}

/**
 * sliding window Map で digest ごとの rate limit を判定する。**同期関数**
 * (Node.js atomicity 前提、Task 1 GOTCHA 参照)。
 *
 * - window 外の timestamp を filter で除去 (自動 GC)
 * - `filtered.length < points` なら push + set + `{allowed: true}` を返す
 * - overflow 時は最古 timestamp + windowMs - nowMs から `retryAfterSec` を計算
 *   (`Math.max(1, Math.ceil(...))` で最低 1 秒保証、client の即時再送ループ防止)
 *
 * **clock skew 対策**: default nowMs は
 * `performance.now()` (単調時計、プロセス起動 relative ms) を使う。壁時計 (`Date.now()`) は
 * NTP 前方補正で無警告 sliding window リセット → 直後 burst 素通り (rate limit の一時 bypass)
 * を silent に起こす経路があるため。helper は数値の大小比較しか行わないので、スケールが
 * 絶対時刻でなくても内部整合性は保たれる。test は明示 `nowMs` を渡すので影響なし。
 *
 * @param digest `tokenDigest(token)` の返す 32 hex string
 * @param nowMs 呼出時刻 (default `performance.now()`、test では明示指定で決定性確保)
 * @param points 上限 req 数 (default env `FUGUE_ASK_RATE_POINTS` → 60)
 * @param windowMs sliding window の幅 ms (default env `FUGUE_ASK_RATE_WINDOW_MS` → 60_000)
 */
export function checkFugueAskRateLimit(
  digest: string,
  nowMs: number = performance.now(),
  points?: number,
  windowMs?: number,
): RateLimitResult {
  if (isFugueAskRateLimitDisabled()) return { allowed: true };
  const limit = points ?? resolveFugueAskRatePoints();
  const window = windowMs ?? resolveFugueAskRateWindowMs();
  // review 提案 1 対応: `points <= 0` を明示 override された defensive path。実運用では
  // `resolveFugueAskRatePoints()` が `> 0` フィルタで default fallback するため到達不能だが、
  // test で points=0 を直接渡すと `filtered.length < 0` が常に false = 拒否経路に落ち、
  // `filtered[0]=undefined` → `Math.ceil((undefined + window - nowMs) / 1000)=NaN` →
  // `Math.max(1, NaN)=NaN` の silent NaN 汚染が発生する。fail-closed で 1 秒 backoff を
  // 返して呼び出し側 (client) に retry を促す (0 point = 永久拒否の意図と一致)。
  if (limit <= 0) return { allowed: false, retryAfterSec: 1 };
  const existing = buckets.get(digest) ?? [];
  const cutoff = nowMs - window;
  const filtered = existing.filter((t) => t > cutoff);
  if (filtered.length < limit) {
    filtered.push(nowMs);
    buckets.set(digest, filtered);
    return { allowed: true };
  }
  buckets.set(digest, filtered);
  const oldest = filtered[0];
  const retryAfterSec = Math.max(1, Math.ceil((oldest + window - nowMs) / 1000));
  return { allowed: false, retryAfterSec };
}

/** test 用 backdoor: module state を reset する。production import path からは呼ばない。 */
export function _resetFugueRateLimitForTest(): void {
  buckets.clear();
}
