/**
 * enkin-tool のユニットテスト。
 *
 * HITL pause/resume 経路の 3 pattern (初回呼出 / Resume approve / Resume reject) + BIBLIO_NAME_RE
 * guard を検証。`tool_context.requestConfirmation` は関数 mock、`tool_context.toolConfirmation` は
 * 初回時 undefined / resume 時 `{confirmed, payload}` を持つ。既存 `mockToolContext` は
 * `requestConfirmation` を持たないため、test file 内で拡張 context を組む。
 */
import type { Context, ToolConfirmation } from '@google/adk';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { enkinMock, requestConfirmationMock } = vi.hoisted(() => ({
  enkinMock: vi.fn(),
  requestConfirmationMock: vi.fn(),
}));

vi.mock('../../biblio/enkin.js', () => ({
  enkin: (...args: unknown[]) => enkinMock(...args),
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { enkinBiblioTool } from './enkin-tool.js';
import { log } from '../../log.js';
import { resetLogMocks } from './test-helpers.js';

/**
 * HITL 用の拡張 mockContext。`requestConfirmation` 関数と、resume 時の `toolConfirmation`
 * オブジェクトを持つ。既存 `mockToolContext` (test-helpers.ts) と互換の shape を維持する。
 */
function mockHitlContext(opts?: {
  invocationId?: string;
  sessionId?: string;
  toolConfirmation?: ToolConfirmation;
}): Context {
  const invocationId = opts?.invocationId ?? 'inv-test-1';
  const sessionId = opts?.sessionId ?? 'sess-test-1';
  return {
    invocationId,
    sessionId,
    invocationContext: {
      invocationId,
      session: { id: sessionId },
    },
    requestConfirmation: requestConfirmationMock,
    toolConfirmation: opts?.toolConfirmation,
  } as unknown as Context;
}

beforeEach(() => {
  enkinMock.mockReset();
  requestConfirmationMock.mockReset();
  resetLogMocks(log);
});

describe('enkinBiblioTool — name / description', () => {
  it('tool 名 / description に admin approval 要求が明示されている', () => {
    expect(enkinBiblioTool.name).toBe('enkin_biblio');
    expect(enkinBiblioTool.description).toContain('Ban a biblio');
    expect(enkinBiblioTool.description).toContain('Requires admin approval');
  });
});

describe('enkinBiblioTool — 初回呼出 (requestConfirmation 発火)', () => {
  it('toolConfirmation 不在時: requestConfirmation を hint + payload 付きで 1 回呼ぶ + enkin() 未呼出', async () => {
    const result = await enkinBiblioTool.runAsync({
      args: { biblioName: 'wf--test', category: 'biblio-dev' },
      toolContext: mockHitlContext({ invocationId: 'inv-1', sessionId: 'sess-1' }),
    });
    expect(requestConfirmationMock).toHaveBeenCalledTimes(1);
    expect(requestConfirmationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining('禁書'),
        payload: expect.objectContaining({
          biblioName: 'wf--test',
          category: 'biblio-dev',
          action: 'enkin',
        }),
      }),
    );
    expect(enkinMock).not.toHaveBeenCalled();
    // pending sentinel が return される (runner 側では無視されるが型合わせ)
    expect(result).toMatchObject({ ok: false, reason: 'config_error', detail: '(承認待ち)' });
  });

  it('構造化ログ event=adk.tool.enkin.confirmation_requested が 1 件出る', async () => {
    await enkinBiblioTool.runAsync({
      args: { biblioName: 'wf--test', category: 'biblio-art' },
      toolContext: mockHitlContext(),
    });
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining('requesting confirmation'),
      expect.objectContaining({
        event: 'adk.tool.enkin.confirmation_requested',
        biblio_name: 'wf--test',
        category: 'biblio-art',
      }),
    );
  });
});

describe('enkinBiblioTool — Resume approve (承認済)', () => {
  it('toolConfirmation.confirmed=true 時: enkin() を実呼出 + 結果を中継', async () => {
    enkinMock.mockResolvedValue({
      ok: true,
      biblioName: 'wf--test',
      category: 'biblio-dev',
      prUrl: 'https://github.com/HajimariInc/biblio-shelf/pull/300',
      prNumber: 300,
      branchName: 'enkin/biblio-dev--wf--test',
    });
    const result = await enkinBiblioTool.runAsync({
      args: { biblioName: 'wf--test', category: 'biblio-dev' },
      toolContext: mockHitlContext({
        toolConfirmation: {
          hint: '禁書: wf--test',
          confirmed: true,
          payload: { biblioName: 'wf--test', category: 'biblio-dev', action: 'enkin' },
        } as ToolConfirmation,
      }),
    });
    expect(enkinMock).toHaveBeenCalledTimes(1);
    expect(enkinMock).toHaveBeenCalledWith(
      { biblioName: 'wf--test', category: 'biblio-dev' },
      { ctx: { requestId: 'inv-test-1', sessionId: 'sess-test-1' } },
    );
    expect(requestConfirmationMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, prNumber: 300 });
  });

  it('構造化ログ event=adk.tool.enkin.resumed (confirmed=true) が 1 件出る', async () => {
    enkinMock.mockResolvedValue({
      ok: true,
      biblioName: 'wf--test',
      category: 'biblio-dev',
      prUrl: 'x',
      prNumber: 1,
      branchName: 'x',
    });
    await enkinBiblioTool.runAsync({
      args: { biblioName: 'wf--test', category: 'biblio-dev' },
      toolContext: mockHitlContext({
        toolConfirmation: { hint: 'x', confirmed: true, payload: {} } as ToolConfirmation,
      }),
    });
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining('resumed from approval'),
      expect.objectContaining({
        event: 'adk.tool.enkin.resumed',
        confirmed: true,
      }),
    );
  });
});

describe('enkinBiblioTool — Resume reject (拒否)', () => {
  it('toolConfirmation.confirmed=false 時: enkin() 未呼出 + config_error + 拒否 detail を return', async () => {
    const result = await enkinBiblioTool.runAsync({
      args: { biblioName: 'wf--test', category: 'biblio-dev' },
      toolContext: mockHitlContext({
        toolConfirmation: {
          hint: 'x',
          confirmed: false,
          payload: {},
        } as ToolConfirmation,
      }),
    });
    expect(enkinMock).not.toHaveBeenCalled();
    expect(requestConfirmationMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      reason: 'config_error',
      detail: expect.stringContaining('admin によって禁書が拒否'),
    });
  });
});

describe('enkinBiblioTool — BIBLIO_NAME_RE guard', () => {
  const invalidNames: Array<[string, string]> = [
    ['path traversal', '../etc/passwd'],
    ['空文字列', ''],
    ['URL scheme', 'http://x/y'],
    ['絶対パス', '/etc/passwd'],
  ];

  for (const [label, name] of invalidNames) {
    it(`${label}: '${name}' → ok:false + config_error + requestConfirmation + enkin() 未呼出`, async () => {
      const result = await enkinBiblioTool.runAsync({
        args: { biblioName: name, category: 'biblio-dev' },
        toolContext: mockHitlContext(),
      });
      expect(result).toMatchObject({
        ok: false,
        reason: 'config_error',
        biblioName: name,
      });
      expect(requestConfirmationMock).not.toHaveBeenCalled();
      expect(enkinMock).not.toHaveBeenCalled();
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
        expect.stringContaining('invalid name (path-traversal guard)'),
        expect.objectContaining({
          event: 'adk.tool.enkin.schema_invalid',
        }),
      );
    });
  }
});

describe('enkinBiblioTool — Resume 後の異常系 (enkin throw 経路)', () => {
  it('confirmed=true 経由で enkin() が throw したら tool もそのまま throw', async () => {
    enkinMock.mockRejectedValue(new Error('GH API 503'));
    await expect(
      enkinBiblioTool.runAsync({
        args: { biblioName: 'wf--test', category: 'biblio-dev' },
        toolContext: mockHitlContext({
          toolConfirmation: { hint: 'x', confirmed: true, payload: {} } as ToolConfirmation,
        }),
      }),
    ).rejects.toThrow(/GH API 503/);
  });
});

describe('enkinBiblioTool — Phase 4 review I2: requestConfirmation throw の防御', () => {
  it('初回呼出で requestConfirmation() が throw → fail-closed で config_error 返却 + enkin() 未呼出', async () => {
    requestConfirmationMock.mockImplementation(() => {
      throw new Error('ADK internal: confirmation channel closed');
    });
    const result = await enkinBiblioTool.runAsync({
      args: { biblioName: 'wf--test', category: 'biblio-dev' },
      toolContext: mockHitlContext(),
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'config_error',
      detail: expect.stringContaining('requestConfirmation'),
    });
    expect(enkinMock).not.toHaveBeenCalled();
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.stringContaining('requestConfirmation threw'),
      expect.objectContaining({ event: 'adk.tool.enkin.request_confirmation_error' }),
    );
  });
});
