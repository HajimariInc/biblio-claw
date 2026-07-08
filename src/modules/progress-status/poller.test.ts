/**
 * progress-status poller の unit test。
 *
 * カバー範囲:
 *   - agent group 削除済 session の silent skip
 *   - outbound.db ENOENT (初回 spawn 前) の silent 化 (debug)
 *   - EACCES 等の I/O 障害の warn (throw なし)
 *   - current_tool 設定時に mapper 経由で updateTypingStatus 発火
 *   - current_tool=null (post-hook idle) 時に null forward
 *   - getContainerState throw 稀ケースでも close 保証
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(),
}));
vi.mock('../../db/session-db.js', () => ({
  getContainerState: vi.fn(),
}));
vi.mock('../../session-manager.js', () => ({
  openOutboundDb: vi.fn(),
  // isPreSpawnDbOpenError は pure 関数のため本物と同じロジックで stub (poller.ts の
  // 分岐挙動を検証する = ここで実装を替えると本物と乖離する罠を避ける)。
  isPreSpawnDbOpenError: (code: string | undefined) => code === 'ENOENT' || code === 'SQLITE_CANTOPEN',
}));
vi.mock('../typing/index.js', () => ({
  updateTypingStatus: vi.fn(),
}));
vi.mock('../../log.js', () => ({
  log: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerState } from '../../db/session-db.js';
import { log } from '../../log.js';
import { openOutboundDb } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { updateTypingStatus } from '../typing/index.js';

import { refreshProgressStatus } from './poller.js';

const mkSession = (): Session =>
  ({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
  }) as Session;

const mkOutDb = () => ({ close: vi.fn() });

describe('refreshProgressStatus', () => {
  beforeEach(() => {
    vi.mocked(getAgentGroup).mockReturnValue({
      id: 'ag-1',
      folder: 'x',
      name: 'x',
    } as ReturnType<typeof getAgentGroup>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('silent skip when agent group not found', async () => {
    vi.mocked(getAgentGroup).mockReturnValue(undefined);
    await refreshProgressStatus(mkSession());
    expect(openOutboundDb).not.toHaveBeenCalled();
    expect(updateTypingStatus).not.toHaveBeenCalled();
  });

  it('debug on ENOENT (pre-spawn), no updateTypingStatus called', async () => {
    vi.mocked(openOutboundDb).mockImplementation(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    await refreshProgressStatus(mkSession());
    expect(updateTypingStatus).not.toHaveBeenCalled();
  });

  it('does not throw on non-ENOENT db open failure (EACCES etc.)', async () => {
    vi.mocked(openOutboundDb).mockImplementation(() => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });
    await expect(refreshProgressStatus(mkSession())).resolves.not.toThrow();
    expect(updateTypingStatus).not.toHaveBeenCalled();
  });

  // SQLITE_CANTOPEN (better-sqlite3 readonly open 特有) が ENOENT と同じ debug 抑制
  // 分岐に落ちる (cold start 中の意図せぬ warn を silent 化) ことを assert する。
  // 「throw しないこと」だけでは debug vs warn の振り分けが未確認になる罠を防ぐ。
  it('debug on SQLITE_CANTOPEN (better-sqlite3 readonly 特有), no warn', async () => {
    vi.mocked(openOutboundDb).mockImplementation(() => {
      const err = new Error('unable to open database file') as NodeJS.ErrnoException;
      err.code = 'SQLITE_CANTOPEN';
      throw err;
    });
    await refreshProgressStatus(mkSession());
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining('pre-spawn'),
      expect.objectContaining({ err_code: 'SQLITE_CANTOPEN', event: 'progress.status.pre_spawn' }),
    );
    expect(log.warn).not.toHaveBeenCalled();
    expect(updateTypingStatus).not.toHaveBeenCalled();
  });

  it('warn on EACCES (I/O 障害) with structured event (regression: debug へ落ちない)', async () => {
    vi.mocked(openOutboundDb).mockImplementation(() => {
      const err = new Error('permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });
    await refreshProgressStatus(mkSession());
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('open failed'),
      expect.objectContaining({ err_code: 'EACCES', event: 'progress.status.db_open_failed' }),
    );
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('calls updateTypingStatus with mapped Japanese status when current_tool is set', async () => {
    const db = mkOutDb();
    vi.mocked(openOutboundDb).mockReturnValue(db as unknown as ReturnType<typeof openOutboundDb>);
    vi.mocked(getContainerState).mockReturnValue({
      current_tool: 'mcp__tavily__tavily_search',
      tool_declared_timeout_ms: null,
      tool_started_at: null,
    });

    await refreshProgressStatus(mkSession());

    expect(updateTypingStatus).toHaveBeenCalledWith('sess-1', 'Web 検索中');
    expect(db.close).toHaveBeenCalled();
  });

  it('calls updateTypingStatus with null when current_tool is null (post-hook idle)', async () => {
    const db = mkOutDb();
    vi.mocked(openOutboundDb).mockReturnValue(db as unknown as ReturnType<typeof openOutboundDb>);
    vi.mocked(getContainerState).mockReturnValue({
      current_tool: null,
      tool_declared_timeout_ms: null,
      tool_started_at: null,
    });

    await refreshProgressStatus(mkSession());

    expect(updateTypingStatus).toHaveBeenCalledWith('sess-1', null);
    expect(db.close).toHaveBeenCalled();
  });

  it('calls updateTypingStatus with null when getContainerState returns null (no state row)', async () => {
    const db = mkOutDb();
    vi.mocked(openOutboundDb).mockReturnValue(db as unknown as ReturnType<typeof openOutboundDb>);
    vi.mocked(getContainerState).mockReturnValue(null);

    await refreshProgressStatus(mkSession());

    expect(updateTypingStatus).toHaveBeenCalledWith('sess-1', null);
    expect(db.close).toHaveBeenCalled();
  });

  it('closes outDb even if getContainerState throws (defensive)', async () => {
    const db = mkOutDb();
    vi.mocked(openOutboundDb).mockReturnValue(db as unknown as ReturnType<typeof openOutboundDb>);
    vi.mocked(getContainerState).mockImplementation(() => {
      throw new Error('boom');
    });
    // getContainerState は本来 null fallback するので稀ケース保険 = throw が抜けるが close は保証
    await expect(refreshProgressStatus(mkSession())).rejects.toThrow('boom');
    expect(db.close).toHaveBeenCalled();
  });

  it('maps ADK native tool name (mcp__ prefix なし) to Japanese via ADK map', async () => {
    const db = mkOutDb();
    vi.mocked(openOutboundDb).mockReturnValue(db as unknown as ReturnType<typeof openOutboundDb>);
    vi.mocked(getContainerState).mockReturnValue({
      current_tool: 'acquire_biblio',
      tool_declared_timeout_ms: null,
      tool_started_at: null,
    });

    await refreshProgressStatus(mkSession());

    expect(updateTypingStatus).toHaveBeenCalledWith('sess-1', '仕入れ中');
  });
});
