/**
 * categorize-tool のユニットテスト。
 *
 * inspect-tool.test.ts と同流儀。`BIBLIO_NAME_RE` guard による path-traversal 防御 + execute 委譲を
 * 1 path で検証。`mockToolContext` / `resetLogMocks` は `test-helpers.ts` 参照。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { categorizeMock } = vi.hoisted(() => ({
  categorizeMock: vi.fn(),
}));

vi.mock('../../biblio/categorize.js', () => ({
  categorize: (...args: unknown[]) => categorizeMock(...args),
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { categorizeBiblioTool } from './categorize-tool.js';
import { log } from '../../log.js';
import { mockToolContext, resetLogMocks } from './test-helpers.js';

beforeEach(() => {
  categorizeMock.mockReset();
  resetLogMocks(log);
});

describe('categorizeBiblioTool — name / description', () => {
  it('tool 名と description が LLM 公開向けに設定されている', () => {
    expect(categorizeBiblioTool.name).toBe('categorize_biblio');
    expect(categorizeBiblioTool.description).toContain('Categorize');
    expect(categorizeBiblioTool.description).toContain('biblio');
  });
});

describe('categorizeBiblioTool — 正常系 (execute → categorize 委譲)', () => {
  it('biblioName を受けて categorize() を 1 回呼ぶ + ctx に invocationId / sessionId が伝搬する', async () => {
    categorizeMock.mockResolvedValue({
      ok: true,
      biblioName: 'wf--test',
      category: 'biblio-dev',
      reason: 'dev tooling',
    });
    const result = await categorizeBiblioTool.runAsync({
      args: { biblioName: 'wf--test' },
      toolContext: mockToolContext({ invocationId: 'inv-abc', sessionId: 'sess-xyz' }),
    });
    expect(categorizeMock).toHaveBeenCalledTimes(1);
    expect(categorizeMock).toHaveBeenCalledWith(
      { biblioName: 'wf--test' },
      { ctx: { requestId: 'inv-abc', sessionId: 'sess-xyz' } },
    );
    expect(result).toEqual({
      ok: true,
      biblioName: 'wf--test',
      category: 'biblio-dev',
      reason: 'dev tooling',
    });
  });

  it('構造化ログ event=adk.tool.categorize.invoke が 1 件出る', async () => {
    categorizeMock.mockResolvedValue({
      ok: true,
      biblioName: 'wf--test',
      category: 'biblio-art',
      reason: 'creative',
    });
    await categorizeBiblioTool.runAsync({
      args: { biblioName: 'wf--test' },
      toolContext: mockToolContext(),
    });
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining('categorize_biblio invoked'),
      expect.objectContaining({
        event: 'adk.tool.categorize.invoke',
        biblio_name: 'wf--test',
      }),
    );
  });

  it('categorize() が ok:false を返したらそのまま中継する', async () => {
    categorizeMock.mockResolvedValue({
      ok: false,
      biblioName: 'wf--test',
      reason: 'llm_error',
      detail: 'Vertex 呼び出し失敗',
    });
    const result = await categorizeBiblioTool.runAsync({
      args: { biblioName: 'wf--test' },
      toolContext: mockToolContext(),
    });
    expect(result).toMatchObject({ ok: false, reason: 'llm_error' });
  });
});

describe('categorizeBiblioTool — Zod schema 検証', () => {
  it('biblioName 欠落で Zod schema reject + categorize() は呼ばれない', async () => {
    await expect(
      categorizeBiblioTool.runAsync({
        args: {},
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow();
    expect(categorizeMock).not.toHaveBeenCalled();
  });

  it('biblioName が数値だと Zod schema reject', async () => {
    await expect(
      categorizeBiblioTool.runAsync({
        args: { biblioName: 42 as unknown as string },
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow();
    expect(categorizeMock).not.toHaveBeenCalled();
  });
});

describe('categorizeBiblioTool — BIBLIO_NAME_RE guard', () => {
  const invalidNames: Array<[string, string]> = [
    ['path traversal', '../etc/passwd'],
    ['空文字列', ''],
    ['URL scheme', 'http://malicious/repo'],
    ['絶対パス', '/etc/passwd'],
    ['単一 dash 区切り', 'owner-repo'],
  ];

  for (const [label, name] of invalidNames) {
    it(`${label}: '${name}' → ok:false + quarantine_missing + categorize() 未呼出`, async () => {
      const result = await categorizeBiblioTool.runAsync({
        args: { biblioName: name },
        toolContext: mockToolContext(),
      });
      expect(result).toMatchObject({
        ok: false,
        reason: 'quarantine_missing',
        biblioName: name,
      });
      expect(categorizeMock).not.toHaveBeenCalled();
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
        expect.stringContaining('invalid name (path-traversal guard)'),
        expect.objectContaining({
          event: 'adk.tool.categorize.schema_invalid',
          biblio_name: name,
        }),
      );
    });
  }
});

describe('categorizeBiblioTool — 異常系 (categorize throw 経路)', () => {
  it('categorize() が throw したら tool もそのまま throw する', async () => {
    categorizeMock.mockRejectedValue(new Error('unexpected LLM failure'));
    await expect(
      categorizeBiblioTool.runAsync({
        args: { biblioName: 'wf--test' },
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow(/unexpected LLM failure/);
  });
});
