/**
 * inspect-tool のユニットテスト (M4-B Phase 1)。
 *
 * acquire-tool.test.ts と同流儀: `runAsync({args, toolContext})` 経由で Zod 検証 +
 * execute 委譲を 1 path で検証。`mockToolContext` / `resetLogMocks` は `test-helpers.ts` 参照。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { inspectMock } = vi.hoisted(() => ({
  inspectMock: vi.fn(),
}));

vi.mock('../../biblio/inspect.js', () => ({
  inspect: (...args: unknown[]) => inspectMock(...args),
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { inspectBiblioTool } from './inspect-tool.js';
import { log } from '../../log.js';
import { mockToolContext, resetLogMocks } from './test-helpers.js';

beforeEach(() => {
  inspectMock.mockReset();
  resetLogMocks(log);
});

describe('inspectBiblioTool — name / description', () => {
  it('tool 名と description が LLM 公開向けに設定されている', () => {
    expect(inspectBiblioTool.name).toBe('inspect_biblio');
    expect(inspectBiblioTool.description).toContain('Inspect');
    expect(inspectBiblioTool.description).toContain('biblio');
  });
});

describe('inspectBiblioTool — 正常系 (execute → inspect 委譲)', () => {
  it('biblioName を受けて inspect() を 1 回呼ぶ + ctx に invocationId / sessionId が伝搬する', async () => {
    inspectMock.mockResolvedValue({ verdict: 'ACCEPT', biblioName: 'wf--test' });
    const result = await inspectBiblioTool.runAsync({
      args: { biblioName: 'wf--test' },
      toolContext: mockToolContext({ invocationId: 'inv-abc', sessionId: 'sess-xyz' }),
    });
    expect(inspectMock).toHaveBeenCalledTimes(1);
    expect(inspectMock).toHaveBeenCalledWith(
      { biblioName: 'wf--test' },
      { ctx: { requestId: 'inv-abc', sessionId: 'sess-xyz' } },
    );
    expect(result).toEqual({ verdict: 'ACCEPT', biblioName: 'wf--test' });
  });

  it('inspect() が REJECT を返したらそのまま中継する (= silent failure 防止)', async () => {
    inspectMock.mockResolvedValue({
      verdict: 'REJECT',
      biblioName: 'wf--bad',
      reason: 'dangerous_code',
      detail: 'Vertex Gemini が DANGEROUS 判定',
    });
    const result = await inspectBiblioTool.runAsync({
      args: { biblioName: 'wf--bad' },
      toolContext: mockToolContext(),
    });
    expect(result).toMatchObject({ verdict: 'REJECT', reason: 'dangerous_code' });
  });

  it('inspect() が HOLD を返したらそのまま中継する (= verdict 3 通り網羅、pr-test-analyzer S6)', async () => {
    inspectMock.mockResolvedValue({
      verdict: 'HOLD',
      biblioName: 'wf--license-unknown',
      reason: 'license_unknown',
      detail: 'plugin.json に license フィールド不在 + allow リスト外',
    });
    const result = await inspectBiblioTool.runAsync({
      args: { biblioName: 'wf--license-unknown' },
      toolContext: mockToolContext(),
    });
    expect(result).toMatchObject({ verdict: 'HOLD', reason: 'license_unknown' });
  });

  it('構造化ログ event=adk.tool.inspect.invoke が 1 件出る', async () => {
    inspectMock.mockResolvedValue({ verdict: 'ACCEPT', biblioName: 'wf--test' });
    await inspectBiblioTool.runAsync({
      args: { biblioName: 'wf--test' },
      toolContext: mockToolContext(),
    });
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining('inspect_biblio invoked'),
      expect.objectContaining({
        event: 'adk.tool.inspect.invoke',
        biblio_name: 'wf--test',
      }),
    );
  });
});

describe('inspectBiblioTool — Zod schema 検証', () => {
  it('biblioName 欠落で Zod schema reject + inspect() は呼ばれない', async () => {
    await expect(
      inspectBiblioTool.runAsync({
        args: {},
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow();
    expect(inspectMock).not.toHaveBeenCalled();
  });

  it('biblioName が数値だと Zod schema reject', async () => {
    await expect(
      inspectBiblioTool.runAsync({
        args: { biblioName: 123 as unknown as string },
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow();
    expect(inspectMock).not.toHaveBeenCalled();
  });
});

describe('inspectBiblioTool — 異常系 (inspect throw 経路)', () => {
  it('inspect() が throw したら tool もそのまま throw する', async () => {
    inspectMock.mockRejectedValue(new Error('quarantine FS failure'));
    await expect(
      inspectBiblioTool.runAsync({
        args: { biblioName: 'wf--test' },
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow(/quarantine FS failure/);
  });
});

describe('inspectBiblioTool — BIBLIO_NAME_RE guard (M4-B Phase 3)', () => {
  // Zod は string type check のみ = 内容は制約しない。BIBLIO_NAME_RE guard 側で
  // fail-closed に REJECT + schema_invalid を返し、inspect() が呼ばれないことを確認する。
  const invalidNames: Array<[string, string]> = [
    ['path traversal (../etc/passwd)', '../etc/passwd'],
    ['path traversal (owner/repo/../etc)', 'owner/repo/../etc'],
    ['空文字列', ''],
    ['null byte 混入', 'owner--repo\x00malicious'],
    ['URL scheme', 'http://malicious/repo'],
    ['絶対パス', '/etc/passwd'],
    ['単一 dash 区切り (separator 不正)', 'owner-repo'],
    ['先頭が dash', '--owner--repo'],
  ];

  for (const [label, name] of invalidNames) {
    it(`${label}: '${name}' → REJECT + schema_invalid + inspect() 未呼出`, async () => {
      const result = await inspectBiblioTool.runAsync({
        args: { biblioName: name },
        toolContext: mockToolContext({ invocationId: 'inv-guard', sessionId: 'sess-guard' }),
      });
      expect(result).toMatchObject({
        verdict: 'REJECT',
        reason: 'schema_invalid',
        biblioName: name,
      });
      expect(inspectMock).not.toHaveBeenCalled();
      // structured log で silent failure 防止 (adk.tool.inspect.schema_invalid) を確認
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
        expect.stringContaining('invalid name (path-traversal guard)'),
        expect.objectContaining({
          event: 'adk.tool.inspect.schema_invalid',
          biblio_name: name,
        }),
      );
    });
  }

  const validNames: string[] = [
    'owner--repo',
    'wf--test',
    'anthropics--claude-plugins-official--my-skill', // 3 要素 (Phase 4 個別 skill 仕入れ)
    'wf--biblio_min', // underscore 許容
    'wf--biblio.min', // dot 許容
  ];
  for (const name of validNames) {
    it(`valid biblioName regression: '${name}' → guard 通過 + inspect() 呼出`, async () => {
      inspectMock.mockResolvedValue({ verdict: 'ACCEPT', biblioName: name });
      const result = await inspectBiblioTool.runAsync({
        args: { biblioName: name },
        toolContext: mockToolContext(),
      });
      expect(inspectMock).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ verdict: 'ACCEPT', biblioName: name });
    });
  }
});
