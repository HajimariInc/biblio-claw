/**
 * shelve-multi-tool のユニットテスト。
 *
 * shelve-tool.test.ts と同流儀。items array + per-item BIBLIO_NAME_RE guard + execute 委譲を
 * 1 path で検証。`mockToolContext` / `resetLogMocks` は `test-helpers.ts` 参照。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { MultiShelveResult } from '../../biblio/types.js';

const { shelveMultiMock } = vi.hoisted(() => ({
  shelveMultiMock: vi.fn(),
}));

vi.mock('../../biblio/shelve.js', () => ({
  shelveMulti: (...args: unknown[]) => shelveMultiMock(...args),
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { shelveBiblioMultiTool } from './shelve-multi-tool.js';
import { log } from '../../log.js';
import { mockToolContext, resetLogMocks } from './test-helpers.js';

beforeEach(() => {
  shelveMultiMock.mockReset();
  resetLogMocks(log);
});

describe('shelveBiblioMultiTool — name / description', () => {
  it('tool 名と description が LLM 公開向けに設定されている', () => {
    expect(shelveBiblioMultiTool.name).toBe('shelve_biblio_multi');
    expect(shelveBiblioMultiTool.description).toContain('Shelve multiple');
    expect(shelveBiblioMultiTool.description).toContain('atomic');
  });
});

describe('shelveBiblioMultiTool — 正常系', () => {
  it('複数 items を受けて shelveMulti() を 1 回呼ぶ + ctx 伝搬', async () => {
    shelveMultiMock.mockResolvedValue({
      ok: true,
      prUrl: 'https://github.com/HajimariInc/biblio-shelf/pull/200',
      prNumber: 200,
      branchName: 'shelve/multi-owner--repo-1700000000',
      items: [
        { biblioName: 'wf--a', category: 'biblio-dev' },
        { biblioName: 'wf--b', category: 'biblio-art' },
      ],
    });
    const result = await shelveBiblioMultiTool.runAsync({
      args: {
        items: [
          { biblioName: 'wf--a', category: 'biblio-dev', reason: 'dev tool' },
          { biblioName: 'wf--b', category: 'biblio-art', reason: 'creative' },
        ],
      },
      toolContext: mockToolContext({ invocationId: 'inv-abc', sessionId: 'sess-xyz' }),
    });
    expect(shelveMultiMock).toHaveBeenCalledTimes(1);
    expect(shelveMultiMock).toHaveBeenCalledWith(
      [
        { biblioName: 'wf--a', category: 'biblio-dev', reason: 'dev tool' },
        { biblioName: 'wf--b', category: 'biblio-art', reason: 'creative' },
      ],
      { ctx: { requestId: 'inv-abc', sessionId: 'sess-xyz' } },
    );
    expect(result).toMatchObject({ ok: true, prNumber: 200 });
  });

  it('構造化ログ event=adk.tool.shelve_multi.invoke が 1 件出る + count 属性', async () => {
    shelveMultiMock.mockResolvedValue({
      ok: true,
      prUrl: 'https://github.com/HajimariInc/biblio-shelf/pull/201',
      prNumber: 201,
      branchName: 'shelve/multi-owner-1700000000',
      items: [{ biblioName: 'wf--x', category: 'biblio-dev' }],
    });
    await shelveBiblioMultiTool.runAsync({
      args: { items: [{ biblioName: 'wf--x', category: 'biblio-dev', reason: 'x' }] },
      toolContext: mockToolContext(),
    });
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining('shelve_biblio_multi invoked'),
      expect.objectContaining({
        event: 'adk.tool.shelve_multi.invoke',
        count: 1,
      }),
    );
  });

  it('shelveMulti() が ok:false を返したらそのまま中継する', async () => {
    shelveMultiMock.mockResolvedValue({
      ok: false,
      reason: 'already_shelved',
      detail: 'marketplace.json に既存 entry',
      items: [{ biblioName: 'wf--a', category: 'biblio-dev' }],
    });
    const result = await shelveBiblioMultiTool.runAsync({
      args: { items: [{ biblioName: 'wf--a', category: 'biblio-dev', reason: 'x' }] },
      toolContext: mockToolContext(),
    });
    expect(result).toMatchObject({ ok: false, reason: 'already_shelved' });
  });
});

describe('shelveBiblioMultiTool — Zod schema 検証', () => {
  it('items が空配列だと Zod reject で throw + shelveMulti() は呼ばれない', async () => {
    await expect(
      shelveBiblioMultiTool.runAsync({
        args: { items: [] },
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow();
    expect(shelveMultiMock).not.toHaveBeenCalled();
  });

  it('reason 空文字は Zod reject', async () => {
    await expect(
      shelveBiblioMultiTool.runAsync({
        args: { items: [{ biblioName: 'wf--a', category: 'biblio-dev', reason: '' }] },
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow();
    expect(shelveMultiMock).not.toHaveBeenCalled();
  });

  it('無効 category ("biblio-invalid") は Zod enum reject', async () => {
    await expect(
      shelveBiblioMultiTool.runAsync({
        args: { items: [{ biblioName: 'wf--a', category: 'biblio-invalid' as never, reason: 'x' }] },
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow();
    expect(shelveMultiMock).not.toHaveBeenCalled();
  });
});

describe('shelveBiblioMultiTool — BIBLIO_NAME_RE guard (per-item)', () => {
  it('1 件でも不正 biblioName があれば ok:false + config_error + shelveMulti() 未呼出', async () => {
    const result = (await shelveBiblioMultiTool.runAsync({
      args: {
        items: [
          { biblioName: 'wf--valid', category: 'biblio-dev', reason: 'x' },
          { biblioName: '../etc/passwd', category: 'biblio-art', reason: 'y' },
        ],
      },
      toolContext: mockToolContext(),
    })) as MultiShelveResult;
    expect(result).toMatchObject({
      ok: false,
      reason: 'config_error',
    });
    expect(result.ok).toBe(false);
    // items 配列は入力全件を含む (= failMulti 相当)
    if (!result.ok) {
      expect(result.items).toHaveLength(2);
    }
    expect(shelveMultiMock).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('invalid name (path-traversal guard)'),
      expect.objectContaining({
        event: 'adk.tool.shelve_multi.schema_invalid',
        biblio_name: '../etc/passwd',
      }),
    );
  });
});

describe('shelveBiblioMultiTool — 異常系 (shelveMulti throw 経路)', () => {
  it('shelveMulti() が throw したら tool もそのまま throw する', async () => {
    shelveMultiMock.mockRejectedValue(new Error('GH API 503'));
    await expect(
      shelveBiblioMultiTool.runAsync({
        args: { items: [{ biblioName: 'wf--a', category: 'biblio-dev', reason: 'x' }] },
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow(/GH API 503/);
  });
});
