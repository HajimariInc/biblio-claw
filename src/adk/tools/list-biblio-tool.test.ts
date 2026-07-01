/**
 * list-biblio-tool のユニットテスト (M4-B Phase 4)。
 *
 * inspect-tool.test.ts と同流儀。`category` は optional (Zod enum optional)、
 * undefined 時は全件取得を意味する。`mockToolContext` / `resetLogMocks` は `test-helpers.ts` 参照。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { BIBLIO_CATEGORIES } from '../../biblio/types.js';

const { listBiblioMock } = vi.hoisted(() => ({
  listBiblioMock: vi.fn(),
}));

vi.mock('../../biblio/list-biblio.js', () => ({
  listBiblio: (...args: unknown[]) => listBiblioMock(...args),
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { listBiblioTool } from './list-biblio-tool.js';
import { log } from '../../log.js';
import { mockToolContext, resetLogMocks } from './test-helpers.js';

beforeEach(() => {
  listBiblioMock.mockReset();
  resetLogMocks(log);
});

describe('listBiblioTool — name / description', () => {
  it('tool 名と description が LLM 公開向けに設定されている', () => {
    expect(listBiblioTool.name).toBe('list_biblio');
    expect(listBiblioTool.description).toContain('List biblios');
  });
});

describe('listBiblioTool — 正常系 (execute → listBiblio 委譲)', () => {
  it('category 未指定で全件取得: listBiblio({}, {ctx}) を呼ぶ', async () => {
    listBiblioMock.mockResolvedValue({
      ok: true,
      items: [{ name: 'wf--a', category: 'biblio-dev', description: 'x', version: '1.0.0' }],
      counts: { 'biblio-dev': 1, 'biblio-art': 0, 'biblio-bf': 0, 'biblio-ai': 0, unknown: 0 },
      total: 1,
      appliedFilter: null,
    });
    const result = await listBiblioTool.runAsync({
      args: {},
      toolContext: mockToolContext({ invocationId: 'inv-abc', sessionId: 'sess-xyz' }),
    });
    expect(listBiblioMock).toHaveBeenCalledTimes(1);
    expect(listBiblioMock).toHaveBeenCalledWith({}, { ctx: { requestId: 'inv-abc', sessionId: 'sess-xyz' } });
    expect(result).toMatchObject({ ok: true, total: 1, appliedFilter: null });
  });

  it.each(BIBLIO_CATEGORIES)('category "%s" 指定で listBiblio({category}, {ctx}) を呼ぶ', async (cat) => {
    listBiblioMock.mockResolvedValue({
      ok: true,
      items: [],
      counts: { 'biblio-dev': 0, 'biblio-art': 0, 'biblio-bf': 0, 'biblio-ai': 0, unknown: 0 },
      total: 0,
      appliedFilter: cat,
    });
    const result = await listBiblioTool.runAsync({
      args: { category: cat },
      toolContext: mockToolContext(),
    });
    expect(listBiblioMock).toHaveBeenCalledWith(
      { category: cat },
      expect.objectContaining({ ctx: expect.any(Object) }),
    );
    expect(result).toMatchObject({ ok: true, appliedFilter: cat });
  });

  it('構造化ログ event=adk.tool.list.invoke が 1 件出る + category 属性', async () => {
    listBiblioMock.mockResolvedValue({
      ok: true,
      items: [],
      counts: { 'biblio-dev': 0, 'biblio-art': 0, 'biblio-bf': 0, 'biblio-ai': 0, unknown: 0 },
      total: 0,
      appliedFilter: 'biblio-dev',
    });
    await listBiblioTool.runAsync({
      args: { category: 'biblio-dev' },
      toolContext: mockToolContext(),
    });
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining('list_biblio invoked'),
      expect.objectContaining({
        event: 'adk.tool.list.invoke',
        category: 'biblio-dev',
      }),
    );
  });

  it('404 経路 (棚が空): listBiblio() が items:[] を返しても ok:true でそのまま中継', async () => {
    listBiblioMock.mockResolvedValue({
      ok: true,
      items: [],
      counts: { 'biblio-dev': 0, 'biblio-art': 0, 'biblio-bf': 0, 'biblio-ai': 0, unknown: 0 },
      total: 0,
      appliedFilter: null,
    });
    const result = await listBiblioTool.runAsync({
      args: {},
      toolContext: mockToolContext(),
    });
    expect(result).toMatchObject({ ok: true, items: [], total: 0 });
  });
});

describe('listBiblioTool — Zod enum (category optional) 検証', () => {
  it('無効カテゴリ ("biblio-invalid") は Zod enum reject で throw', async () => {
    await expect(
      listBiblioTool.runAsync({
        args: { category: 'biblio-invalid' as never },
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow();
    expect(listBiblioMock).not.toHaveBeenCalled();
  });
});

describe('listBiblioTool — 異常系 (listBiblio throw 経路)', () => {
  it('listBiblio() が throw したら tool もそのまま throw する', async () => {
    listBiblioMock.mockRejectedValue(new Error('marketplace fetch failed'));
    await expect(
      listBiblioTool.runAsync({
        args: {},
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow(/marketplace fetch failed/);
  });
});
