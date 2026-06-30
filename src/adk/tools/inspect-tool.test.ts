/**
 * inspect-tool のユニットテスト (M4-B Phase 1)。
 *
 * acquire-tool.test.ts と同流儀: `runAsync({args, toolContext})` 経由で Zod 検証 +
 * execute 委譲を 1 path で検証。
 */
import type { Context } from '@google/adk';
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

beforeEach(() => {
  inspectMock.mockReset();
  vi.mocked(log.debug).mockReset();
  vi.mocked(log.info).mockReset();
  vi.mocked(log.warn).mockReset();
  vi.mocked(log.error).mockReset();
});

function mockToolContext(opts?: { invocationId?: string; sessionId?: string }): Context {
  return {
    invocationContext: {
      invocationId: opts?.invocationId ?? 'inv-test-1',
      session: { id: opts?.sessionId ?? 'sess-test-1' },
    },
  } as unknown as Context;
}

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

  it('inspect() が HOLD / REJECT を返したらそのまま中継する (= silent failure 防止)', async () => {
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
