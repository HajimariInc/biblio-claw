/**
 * acquire-tool のユニットテスト (M4-B Phase 1)。
 *
 * `FunctionTool.execute` は private のため、`tool.runAsync({ args, toolContext })` 経由で
 * 起動して Zod 検証 + execute の両方を 1 path で検証する (= adk-js 公式 API、`function_tool.d.ts`
 * `runAsync` JSDoc 「Validates the model-provided arguments against the parameter schema and
 * invokes the user-defined execute function」と一致)。
 *
 * mock パターンは Phase 0 `AnthropicVertexLlm.test.ts` 流儀: `vi.hoisted` で fn を上げる +
 * `vi.mock` で SDK / 既存関数 / log を mock + 静的 import。
 */
import type { Context } from '@google/adk';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { acquireMock } = vi.hoisted(() => ({
  acquireMock: vi.fn(),
}));

vi.mock('../../biblio/acquire.js', () => ({
  acquire: (...args: unknown[]) => acquireMock(...args),
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { acquireBiblioTool } from './acquire-tool.js';
import { log } from '../../log.js';

beforeEach(() => {
  acquireMock.mockReset();
  vi.mocked(log.debug).mockReset();
  vi.mocked(log.info).mockReset();
  vi.mocked(log.warn).mockReset();
  vi.mocked(log.error).mockReset();
});

/** Context の最小 structural mock。`invocationContext.{invocationId, session.id}` のみ持つ。 */
function mockToolContext(opts?: { invocationId?: string; sessionId?: string }): Context {
  return {
    invocationContext: {
      invocationId: opts?.invocationId ?? 'inv-test-1',
      session: { id: opts?.sessionId ?? 'sess-test-1' },
    },
  } as unknown as Context;
}

describe('acquireBiblioTool — name / description', () => {
  it('tool 名と description が LLM 公開向けに設定されている', () => {
    expect(acquireBiblioTool.name).toBe('acquire_biblio');
    expect(acquireBiblioTool.description).toContain('Acquire');
    expect(acquireBiblioTool.description).toContain('biblio');
  });
});

describe('acquireBiblioTool — 正常系 (execute → acquire 委譲)', () => {
  it('repo を受けて acquire() を 1 回呼ぶ + ctx に invocationId / sessionId が伝搬する', async () => {
    acquireMock.mockResolvedValue({
      ok: true,
      biblioName: 'wf--test',
      quarantinePath: '/data/quarantine/wf--test',
    });
    const result = await acquireBiblioTool.runAsync({
      args: { repo: 'wf/test' },
      toolContext: mockToolContext({ invocationId: 'inv-abc', sessionId: 'sess-xyz' }),
    });
    expect(acquireMock).toHaveBeenCalledTimes(1);
    expect(acquireMock).toHaveBeenCalledWith(
      { repo: 'wf/test' },
      { ctx: { requestId: 'inv-abc', sessionId: 'sess-xyz' } },
    );
    expect(result).toEqual({
      ok: true,
      biblioName: 'wf--test',
      quarantinePath: '/data/quarantine/wf--test',
    });
  });

  it('構造化ログ event=adk.tool.acquire.invoke が 1 件出る', async () => {
    acquireMock.mockResolvedValue({ ok: true, biblioName: 'wf--test', quarantinePath: '/q/wf--test' });
    await acquireBiblioTool.runAsync({
      args: { repo: 'wf/test' },
      toolContext: mockToolContext(),
    });
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining('acquire_biblio invoked'),
      expect.objectContaining({
        event: 'adk.tool.acquire.invoke',
        request_id: 'inv-test-1',
        session_id: 'sess-test-1',
        repo: 'wf/test',
      }),
    );
  });

  it('acquire() が ok:false を返したらそのまま中継する (= silent failure 防止、tool は AcquireResult をそのまま yield)', async () => {
    acquireMock.mockResolvedValue({
      ok: false,
      reason: 'not_found',
      detail: 'repo が見つかりません: wf/missing',
    });
    const result = await acquireBiblioTool.runAsync({
      args: { repo: 'wf/missing' },
      toolContext: mockToolContext(),
    });
    expect(result).toEqual({
      ok: false,
      reason: 'not_found',
      detail: 'repo が見つかりません: wf/missing',
    });
  });
});

describe('acquireBiblioTool — Zod schema 検証', () => {
  it('repo が string でない (= 数値) と Zod schema reject で throw + acquire() は呼ばれない', async () => {
    await expect(
      acquireBiblioTool.runAsync({
        args: { repo: 42 as unknown as string },
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow();
    expect(acquireMock).not.toHaveBeenCalled();
  });

  it('repo フィールド欠落でも Zod schema reject + acquire() は呼ばれない', async () => {
    await expect(
      acquireBiblioTool.runAsync({
        args: {},
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow();
    expect(acquireMock).not.toHaveBeenCalled();
  });
});

describe('acquireBiblioTool — 異常系 (acquire throw 経路)', () => {
  it('acquire() が throw したら tool もそのまま throw する (= ADK の tool error event yield に委ねる)', async () => {
    acquireMock.mockRejectedValue(new Error('unexpected git failure'));
    await expect(
      acquireBiblioTool.runAsync({
        args: { repo: 'wf/test' },
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow(/unexpected git failure/);
  });
});
