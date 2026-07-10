/**
 * ADK Session GC — LRU + TTL sweep for `InMemorySessionService`.
 *
 * issue #150 で dispatcher.ts の通常経路 `deleteSession` を廃止した結果、`InMemorySessionService`
 * の internal Map に session が無制限に蓄積するようになった。本 module は起動時に
 * `setInterval` で sweep loop を回し、以下 2 経路で session を prune する:
 *   - **TTL sweep**: `lastUpdateTime` から `TTL_MS` 以上経過した session は無条件で prune
 *   - **LRU sweep**: TTL prune 後の残数が `MAX_SESSIONS` を超える場合、oldest から超過分を prune
 *
 * # 契約
 *   - `InMemorySessionService` は Pod 内メモリで動作し Pod 再起動で全 session が消失する
 *     (= Non-goal: Pod 再起動を跨いだ持続。VertexAiSessionService / DatabaseSessionService への
 *     切替は別 issue)
 *   - `Session.lastUpdateTime` (`base_session_service.d.ts` の Session interface の field) を
 *     判断起点にする
 *   - HITL pending 経路の session を GC 対象から外す flag は Phase 1 では**入れない** (TTL=24h は
 *     admin 承認 window (数分〜数時間) より十分長く、実害限定的、issue #150 §エッジケース)
 *
 * # implementation detail 依存
 *   - `BaseSessionService.listSessions` は `(appName, userId)` 単位でしか叩けないため、全 session
 *     を走査するには userId 集合が事前必要 = adk-js が公開する API では GC を実装できない
 *   - `InMemorySessionService.sessions` (private field) の 3 段 **plain nested object** 構造
 *     (`this.sessions = {}` + bracket-indexed 追加、`dist/cjs/sessions/in_memory_session_service.js`
 *     の実装で確認済) に直接触ることで代替する。**型定義 (`.d.ts`) では
 *     "map from ... to map ..." と記載されているが、実装は Map ではなく plain object であり
 *     `for (const [k, v] of obj)` は throw する。走査は `Object.entries()` を使う。**
 *   - 本依存は adk-js@1.3.0 の実装契約に基づく (major version bump 時は本 module の動作確認が必要、
 *     `docs/operations-runbook.md` に check を追記)
 */
import { log } from '../log.js';

import { getSharedRunner } from './dispatcher.js';
import { BIBLIO_M4B_APP_NAME } from './runner.js';

/** LRU sweep が prune を開始する session 総数の閾値 (Prod 実測で調整可能)。 */
const MAX_SESSIONS = 500;
/** TTL sweep の閾値 (24h、admin 承認 window より十分長い設定)。 */
const TTL_MS = 24 * 60 * 60 * 1000;
/** sweep loop の周期 (1h、低頻度で十分)。 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let sweepTimer: NodeJS.Timeout | undefined;

/**
 * `InMemorySessionService.sessions` (private field) を module-local に露出させる interface。
 *
 * **実装契約 (adk-js@1.3.0 の `dist/cjs/sessions/in_memory_session_service.js` で確認)**:
 * 3 段 plain nested object。`this.sessions = {}` で初期化 → `this.sessions[appName] = {}` →
 * `this.sessions[appName][userId] = {}` → `this.sessions[appName][userId][sessionId] = session`
 * の bracket-indexed 追加。型定義 (`.d.ts`) の "map from ... to map ..." 表現に惑わされて
 * `Map<...>` として型付けすると `for (const [k, v] of obj)` 経路で TypeError で throw する
 * (= 走査は `Object.entries()` を使う必要がある)。
 */
interface InternalInMemorySessionService {
  sessions: Record<string, Record<string, Record<string, { id: string; lastUpdateTime?: number }>>>;
}

interface SessionCandidate {
  appName: string;
  userId: string;
  sessionId: string;
  lastUpdateTime: number;
}

/**
 * GC を起動 (idempotent、既に起動済なら no-op)。`src/index.ts` main() 末尾で呼ぶ。
 *
 * `setInterval` の unref は行わない = process.exit で clean-up される Node.js 挙動を前提。
 */
export function startAdkSessionGc(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void sweep().catch((err) => {
      log.warn('ADK session GC: sweep threw unexpectedly', {
        event: 'adk.session_gc.sweep_error',
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }, SWEEP_INTERVAL_MS);
  log.info('ADK session GC started', {
    event: 'adk.session_gc.started',
    max_sessions: MAX_SESSIONS,
    ttl_ms: TTL_MS,
    sweep_interval_ms: SWEEP_INTERVAL_MS,
  });
}

/** test 用 (= `stopAdkSessionGc()` で timer をクリア)。 */
export function stopAdkSessionGc(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
}

/**
 * 1 回 sweep を実行する (LRU + TTL)。test では直接呼んで挙動を検証する。
 *
 * throw しない契約 = 内部エラーは warn log のみで sweep を継続する (silent failure 撲滅と
 * 両立させるため、`getSharedRunner` throw のみ再 throw して setInterval の catch で拾う)。
 */
export async function sweep(): Promise<void> {
  const { sessionService } = getSharedRunner();
  const internal = sessionService as unknown as InternalInMemorySessionService;
  // Pod 起動直後 (session 皆無) or non-InMemory 実装 (契約変更) 時は silent skip。
  if (!internal.sessions) return;

  const now = Date.now();
  const candidates: SessionCandidate[] = [];

  // 3 段 plain nested object を Object.entries() で走査 (Map ではない、interface docstring 参照)。
  for (const [appName, users] of Object.entries(internal.sessions)) {
    if (appName !== BIBLIO_M4B_APP_NAME) continue;
    for (const [userId, sessions] of Object.entries(users)) {
      for (const [sessionId, session] of Object.entries(sessions)) {
        candidates.push({
          appName,
          userId,
          sessionId,
          lastUpdateTime: session.lastUpdateTime ?? 0,
        });
      }
    }
  }

  const ttlExpired = candidates.filter((c) => now - c.lastUpdateTime > TTL_MS);
  const ttlExpiredKeys = new Set(ttlExpired.map((c) => `${c.userId}:${c.sessionId}`));
  const remaining = candidates
    .filter((c) => !ttlExpiredKeys.has(`${c.userId}:${c.sessionId}`))
    .sort((a, b) => a.lastUpdateTime - b.lastUpdateTime);
  const lruOverflow = Math.max(0, remaining.length - MAX_SESSIONS);
  const lruExpired = remaining.slice(0, lruOverflow);

  const toDelete = [...ttlExpired, ...lruExpired];
  for (const c of toDelete) {
    try {
      await sessionService.deleteSession({
        appName: c.appName,
        userId: c.userId,
        sessionId: c.sessionId,
      });
    } catch (err) {
      log.warn('ADK session GC: deleteSession failed', {
        event: 'adk.session_gc.delete_failed',
        session_id: c.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (toDelete.length > 0) {
    log.info('ADK session GC sweep completed', {
      event: 'adk.session_gc.swept',
      ttl_expired: ttlExpired.length,
      lru_expired: lruExpired.length,
      total_before: candidates.length,
      total_after: candidates.length - toDelete.length,
    });
  }
}
