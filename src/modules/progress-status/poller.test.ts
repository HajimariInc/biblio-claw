/**
 * M4-F Phase 4: progress-status poller の unit test。
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
}));
vi.mock('../typing/index.js', () => ({
  updateTypingStatus: vi.fn(),
}));

import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerState } from '../../db/session-db.js';
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

describe('refreshProgressStatus (M4-F Phase 4)', () => {
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
