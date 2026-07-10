/**
 * session-gc.ts のユニットテスト (issue #150 で追加).
 *
 * `sweep()` の LRU + TTL 動作を fake InMemorySessionService で検証する。
 * mock 対象:
 *   - `./dispatcher.js` の `getSharedRunner` (fake sessionService を返す)
 *   - `../log.js`
 *
 * `sweep()` は module scope の side effect なしの pure 関数として直接呼び出せる。
 * `setInterval` を触る `startAdkSessionGc` / `stopAdkSessionGc` は timer 系 test で扱う。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const { deleteSessionMock, getSharedRunnerMock } = vi.hoisted(() => ({
  deleteSessionMock: vi.fn(),
  getSharedRunnerMock: vi.fn(),
}));

vi.mock('./dispatcher.js', () => ({
  getSharedRunner: (...args: unknown[]) => getSharedRunnerMock(...args),
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { sweep, startAdkSessionGc, stopAdkSessionGc } from './session-gc.js';
import { log } from '../log.js';

const APP = 'biblio_m4b';

/** InMemorySessionService.sessions と同型の 3 段 Map を作る helper。 */
function makeSessions(): Map<string, Map<string, Map<string, { id: string; lastUpdateTime?: number }>>> {
  return new Map();
}

/** (userId, sessionId, lastUpdateTime) を 3 段 Map に追加する helper。 */
function addSession(
  sessions: Map<string, Map<string, Map<string, { id: string; lastUpdateTime?: number }>>>,
  userId: string,
  sessionId: string,
  lastUpdateTime: number,
): void {
  let userMap = sessions.get(APP);
  if (!userMap) {
    userMap = new Map();
    sessions.set(APP, userMap);
  }
  let sessionMap = userMap.get(userId);
  if (!sessionMap) {
    sessionMap = new Map();
    userMap.set(userId, sessionMap);
  }
  sessionMap.set(sessionId, { id: sessionId, lastUpdateTime });
}

beforeEach(() => {
  deleteSessionMock.mockReset();
  deleteSessionMock.mockResolvedValue(undefined);
  getSharedRunnerMock.mockReset();
  vi.mocked(log.info).mockReset();
  vi.mocked(log.warn).mockReset();
});

afterEach(() => {
  stopAdkSessionGc();
});

describe('sweep — TTL prune', () => {
  it('lastUpdateTime が TTL_MS (24h) を超えた session は無条件 prune される', async () => {
    const sessions = makeSessions();
    const now = Date.now();
    // 25h 前 (TTL 超過)
    addSession(sessions, 'user-old', 'slack:C1:t-1', now - 25 * 60 * 60 * 1000);
    // 1h 前 (TTL 内)
    addSession(sessions, 'user-fresh', 'slack:C1:t-2', now - 1 * 60 * 60 * 1000);
    getSharedRunnerMock.mockReturnValue({
      sessionService: { sessions, deleteSession: deleteSessionMock },
    });

    await sweep();

    expect(deleteSessionMock).toHaveBeenCalledTimes(1);
    expect(deleteSessionMock).toHaveBeenCalledWith({
      appName: APP,
      userId: 'user-old',
      sessionId: 'slack:C1:t-1',
    });
  });

  it('lastUpdateTime が未定義の session は 0 として扱われ TTL prune 対象になる', async () => {
    const sessions = makeSessions();
    let userMap = sessions.get(APP);
    if (!userMap) {
      userMap = new Map();
      sessions.set(APP, userMap);
    }
    const sessionMap = new Map<string, { id: string; lastUpdateTime?: number }>();
    // lastUpdateTime 未定義
    sessionMap.set('slack:C1:t-orphan', { id: 'slack:C1:t-orphan' });
    userMap.set('user-orphan', sessionMap);
    getSharedRunnerMock.mockReturnValue({
      sessionService: { sessions, deleteSession: deleteSessionMock },
    });

    await sweep();

    expect(deleteSessionMock).toHaveBeenCalledTimes(1);
    expect(deleteSessionMock).toHaveBeenCalledWith({
      appName: APP,
      userId: 'user-orphan',
      sessionId: 'slack:C1:t-orphan',
    });
  });
});

describe('sweep — LRU prune (MAX_SESSIONS 超過分を oldest から)', () => {
  it('MAX_SESSIONS (500) を超えた分だけ oldest から prune される', async () => {
    const sessions = makeSessions();
    const now = Date.now();
    // 505 session を 1s 刻みで作る (全部 TTL 内)
    for (let i = 0; i < 505; i++) {
      addSession(sessions, `u-${i}`, `slack:C1:t-${i}`, now - i * 1000);
    }
    getSharedRunnerMock.mockReturnValue({
      sessionService: { sessions, deleteSession: deleteSessionMock },
    });

    await sweep();

    // 500 超過 = 5 個 prune、oldest から
    expect(deleteSessionMock).toHaveBeenCalledTimes(5);
    // 最古 5 個 (i=504, 503, 502, 501, 500) が prune 対象
    const deletedSessionIds = deleteSessionMock.mock.calls.map((c) => (c[0] as { sessionId: string }).sessionId);
    expect(deletedSessionIds).toEqual(
      expect.arrayContaining([
        'slack:C1:t-500',
        'slack:C1:t-501',
        'slack:C1:t-502',
        'slack:C1:t-503',
        'slack:C1:t-504',
      ]),
    );
  });

  it('MAX_SESSIONS 以下の場合は LRU prune は発生しない', async () => {
    const sessions = makeSessions();
    const now = Date.now();
    for (let i = 0; i < 300; i++) {
      addSession(sessions, `u-${i}`, `slack:C1:t-${i}`, now - i * 1000);
    }
    getSharedRunnerMock.mockReturnValue({
      sessionService: { sessions, deleteSession: deleteSessionMock },
    });

    await sweep();

    expect(deleteSessionMock).not.toHaveBeenCalled();
  });
});

describe('sweep — TTL + LRU の複合', () => {
  it('TTL prune 済み分は LRU 判定から除外される (2 重 prune されない)', async () => {
    const sessions = makeSessions();
    const now = Date.now();
    // 100 個の TTL 超過 (25h 前)
    for (let i = 0; i < 100; i++) {
      addSession(sessions, `u-old-${i}`, `slack:C1:t-old-${i}`, now - 25 * 60 * 60 * 1000);
    }
    // 505 個の TTL 内 (i 秒前、oldest は 504s 前)
    for (let i = 0; i < 505; i++) {
      addSession(sessions, `u-fresh-${i}`, `slack:C1:t-fresh-${i}`, now - i * 1000);
    }
    getSharedRunnerMock.mockReturnValue({
      sessionService: { sessions, deleteSession: deleteSessionMock },
    });

    await sweep();

    // TTL 100 + LRU 5 = 105 個 prune、2 重 prune なし
    expect(deleteSessionMock).toHaveBeenCalledTimes(105);
    const deletedIds = deleteSessionMock.mock.calls.map((c) => (c[0] as { sessionId: string }).sessionId);
    // TTL prune 対象は全部含まれる
    for (let i = 0; i < 100; i++) {
      expect(deletedIds).toContain(`slack:C1:t-old-${i}`);
    }
    // LRU prune は fresh の oldest 5 個 (i=500..504)
    expect(deletedIds).toContain('slack:C1:t-fresh-500');
    expect(deletedIds).toContain('slack:C1:t-fresh-504');
  });
});

describe('sweep — 契約と防御', () => {
  it('internal.sessions が undefined (契約違反時) → silent skip', async () => {
    getSharedRunnerMock.mockReturnValue({
      sessionService: { deleteSession: deleteSessionMock },
    });

    await sweep();

    expect(deleteSessionMock).not.toHaveBeenCalled();
  });

  it('別 appName の session は無視される (biblio_m4b のみ処理)', async () => {
    const sessions = makeSessions();
    const now = Date.now();
    // biblio_m4b: 25h 前
    addSession(sessions, 'user-1', 'slack:C1:t-1', now - 25 * 60 * 60 * 1000);
    // 別 app: 25h 前 (処理対象外)
    const otherAppMap = new Map<string, Map<string, { id: string; lastUpdateTime?: number }>>();
    const otherUserMap = new Map<string, { id: string; lastUpdateTime?: number }>();
    otherUserMap.set('other-session', { id: 'other-session', lastUpdateTime: now - 25 * 60 * 60 * 1000 });
    otherAppMap.set('user-1', otherUserMap);
    sessions.set('some_other_app', otherAppMap);

    getSharedRunnerMock.mockReturnValue({
      sessionService: { sessions, deleteSession: deleteSessionMock },
    });

    await sweep();

    expect(deleteSessionMock).toHaveBeenCalledTimes(1);
    expect(deleteSessionMock).toHaveBeenCalledWith({
      appName: APP,
      userId: 'user-1',
      sessionId: 'slack:C1:t-1',
    });
  });

  it('deleteSession が throw しても sweep 全体は継続 (warn ログのみ、他 session の prune を続行)', async () => {
    const sessions = makeSessions();
    const now = Date.now();
    addSession(sessions, 'u-1', 'slack:C1:t-1', now - 25 * 60 * 60 * 1000);
    addSession(sessions, 'u-2', 'slack:C1:t-2', now - 25 * 60 * 60 * 1000);
    deleteSessionMock.mockRejectedValueOnce(new Error('lock timeout')).mockResolvedValueOnce(undefined);
    getSharedRunnerMock.mockReturnValue({
      sessionService: { sessions, deleteSession: deleteSessionMock },
    });

    await expect(sweep()).resolves.toBeUndefined();

    expect(deleteSessionMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('deleteSession failed'),
      expect.objectContaining({ event: 'adk.session_gc.delete_failed' }),
    );
  });

  it('prune 対象なし → log.info swept は呼ばれない (noise 抑制)', async () => {
    const sessions = makeSessions();
    const now = Date.now();
    addSession(sessions, 'u-1', 'slack:C1:t-1', now - 1 * 60 * 60 * 1000);
    getSharedRunnerMock.mockReturnValue({
      sessionService: { sessions, deleteSession: deleteSessionMock },
    });

    await sweep();

    expect(deleteSessionMock).not.toHaveBeenCalled();
    expect(vi.mocked(log.info)).not.toHaveBeenCalledWith('ADK session GC sweep completed', expect.anything());
  });

  it('prune 対象あり → log.info swept が呼ばれる (集計値付き)', async () => {
    const sessions = makeSessions();
    const now = Date.now();
    addSession(sessions, 'u-old', 'slack:C1:t-old', now - 25 * 60 * 60 * 1000);
    addSession(sessions, 'u-fresh', 'slack:C1:t-fresh', now - 1 * 60 * 60 * 1000);
    getSharedRunnerMock.mockReturnValue({
      sessionService: { sessions, deleteSession: deleteSessionMock },
    });

    await sweep();

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      'ADK session GC sweep completed',
      expect.objectContaining({
        event: 'adk.session_gc.swept',
        ttl_expired: 1,
        lru_expired: 0,
        total_before: 2,
        total_after: 1,
      }),
    );
  });
});

describe('startAdkSessionGc / stopAdkSessionGc — idempotent + graceful', () => {
  it('startAdkSessionGc は 1 度目で timer 起動 + log.info started、2 度目は no-op (idempotent)', () => {
    startAdkSessionGc();
    startAdkSessionGc();
    // log.info started は 1 度だけ
    const startedCalls = vi.mocked(log.info).mock.calls.filter((c) => c[0] === 'ADK session GC started');
    expect(startedCalls.length).toBe(1);
  });

  it('stopAdkSessionGc 後の再 start は再度 timer 起動する', () => {
    startAdkSessionGc();
    stopAdkSessionGc();
    startAdkSessionGc();
    const startedCalls = vi.mocked(log.info).mock.calls.filter((c) => c[0] === 'ADK session GC started');
    expect(startedCalls.length).toBe(2);
  });
});
