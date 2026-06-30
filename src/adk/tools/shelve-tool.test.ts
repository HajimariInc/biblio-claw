/**
 * shelve-tool のユニットテスト (M4-B Phase 1)。
 *
 * acquire-tool.test.ts と同流儀。`category` の Zod enum 検証 (= `BIBLIO_CATEGORIES` 4 値以外
 * reject) も含む。`mockToolContext` / `resetLogMocks` は `test-helpers.ts` 参照。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { BIBLIO_CATEGORIES } from '../../biblio/types.js';

const { shelveMock } = vi.hoisted(() => ({
  shelveMock: vi.fn(),
}));

vi.mock('../../biblio/shelve.js', () => ({
  shelve: (...args: unknown[]) => shelveMock(...args),
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { shelveBiblioTool } from './shelve-tool.js';
import { log } from '../../log.js';
import { mockToolContext, resetLogMocks } from './test-helpers.js';

beforeEach(() => {
  shelveMock.mockReset();
  resetLogMocks(log);
});

describe('shelveBiblioTool — name / description', () => {
  it('tool 名と description が LLM 公開向けに設定されている', () => {
    expect(shelveBiblioTool.name).toBe('shelve_biblio');
    expect(shelveBiblioTool.description).toContain('Shelve');
    expect(shelveBiblioTool.description).toContain('draft PR');
  });
});

describe('shelveBiblioTool — 正常系 (execute → shelve 委譲)', () => {
  it('全フィールドを受けて shelve() を 1 回呼ぶ + ctx 伝搬', async () => {
    shelveMock.mockResolvedValue({
      ok: true,
      biblioName: 'wf--test',
      category: 'biblio-dev',
      prUrl: 'https://github.com/HajimariInc/biblio-shelf/pull/123',
      prNumber: 123,
      branchName: 'biblio-add-wf--test',
    });
    const result = await shelveBiblioTool.runAsync({
      args: { biblioName: 'wf--test', category: 'biblio-dev', reason: 'dev tooling' },
      toolContext: mockToolContext({ invocationId: 'inv-abc', sessionId: 'sess-xyz' }),
    });
    expect(shelveMock).toHaveBeenCalledTimes(1);
    expect(shelveMock).toHaveBeenCalledWith(
      { biblioName: 'wf--test', category: 'biblio-dev', reason: 'dev tooling' },
      { ctx: { requestId: 'inv-abc', sessionId: 'sess-xyz' } },
    );
    expect(result).toMatchObject({ ok: true, prNumber: 123 });
  });

  it('構造化ログ event=adk.tool.shelve.invoke が 1 件出る + category 属性付き', async () => {
    shelveMock.mockResolvedValue({
      ok: true,
      biblioName: 'wf--test',
      category: 'biblio-art',
      prUrl: 'https://github.com/HajimariInc/biblio-shelf/pull/124',
      prNumber: 124,
      branchName: 'biblio-add-wf--test',
    });
    await shelveBiblioTool.runAsync({
      args: { biblioName: 'wf--test', category: 'biblio-art', reason: 'creative skill' },
      toolContext: mockToolContext(),
    });
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining('shelve_biblio invoked'),
      expect.objectContaining({
        event: 'adk.tool.shelve.invoke',
        biblio_name: 'wf--test',
        category: 'biblio-art',
      }),
    );
  });

  it('shelve() が ok:false を返したらそのまま中継する', async () => {
    shelveMock.mockResolvedValue({
      ok: false,
      biblioName: 'wf--test',
      reason: 'already_shelved',
      detail: 'marketplace.json に既に存在: wf--test',
    });
    const result = await shelveBiblioTool.runAsync({
      args: { biblioName: 'wf--test', category: 'biblio-dev', reason: 'dev tooling' },
      toolContext: mockToolContext(),
    });
    expect(result).toMatchObject({ ok: false, reason: 'already_shelved' });
  });
});

describe('shelveBiblioTool — Zod enum (category) 検証', () => {
  it.each(BIBLIO_CATEGORIES)('有効カテゴリ "%s" は accept される', async (cat) => {
    shelveMock.mockResolvedValue({
      ok: true,
      biblioName: 'wf--test',
      category: cat,
      prUrl: 'https://github.com/HajimariInc/biblio-shelf/pull/1',
      prNumber: 1,
      branchName: 'biblio-add-wf--test',
    });
    await expect(
      shelveBiblioTool.runAsync({
        args: { biblioName: 'wf--test', category: cat, reason: 'test reason' },
        toolContext: mockToolContext(),
      }),
    ).resolves.toBeTruthy();
  });

  it('無効カテゴリ ("biblio-invalid") は Zod enum reject で throw + shelve() は呼ばれない', async () => {
    await expect(
      shelveBiblioTool.runAsync({
        args: { biblioName: 'wf--test', category: 'biblio-invalid', reason: 'x' },
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow();
    expect(shelveMock).not.toHaveBeenCalled();
  });

  it('reason の長さ制約 (1-200 chars)。空文字は Zod reject', async () => {
    await expect(
      shelveBiblioTool.runAsync({
        args: { biblioName: 'wf--test', category: 'biblio-dev', reason: '' },
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow();
    expect(shelveMock).not.toHaveBeenCalled();
  });

  it('reason が 201 chars だと Zod reject', async () => {
    const longReason = 'x'.repeat(201);
    await expect(
      shelveBiblioTool.runAsync({
        args: { biblioName: 'wf--test', category: 'biblio-dev', reason: longReason },
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow();
    expect(shelveMock).not.toHaveBeenCalled();
  });
});

describe('shelveBiblioTool — 異常系 (shelve throw 経路)', () => {
  it('shelve() が throw したら tool もそのまま throw する', async () => {
    shelveMock.mockRejectedValue(new Error('GH API 503'));
    await expect(
      shelveBiblioTool.runAsync({
        args: { biblioName: 'wf--test', category: 'biblio-dev', reason: 'x' },
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow(/GH API 503/);
  });
});
