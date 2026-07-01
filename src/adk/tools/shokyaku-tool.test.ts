/**
 * shokyaku-tool のユニットテスト (M4-B Phase 4)。
 *
 * enkin-tool.test.ts と同流儀 (HITL pause/resume 経路)。追加で `cleanupWarning` の log.warn 経路
 * (= 装備源物理削除失敗を patron に伝える差分点) を検証。
 */
import type { Context, ToolConfirmation } from '@google/adk';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { shokyakuMock, requestConfirmationMock } = vi.hoisted(() => ({
  shokyakuMock: vi.fn(),
  requestConfirmationMock: vi.fn(),
}));

vi.mock('../../biblio/shokyaku.js', () => ({
  shokyaku: (...args: unknown[]) => shokyakuMock(...args),
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { shokyakuBiblioTool } from './shokyaku-tool.js';
import { log } from '../../log.js';
import { resetLogMocks } from './test-helpers.js';

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
  shokyakuMock.mockReset();
  requestConfirmationMock.mockReset();
  resetLogMocks(log);
});

describe('shokyakuBiblioTool — name / description', () => {
  it('tool 名 / description に destructive + admin approval が明示されている', () => {
    expect(shokyakuBiblioTool.name).toBe('shokyaku_biblio');
    expect(shokyakuBiblioTool.description).toContain('Burn a biblio');
    expect(shokyakuBiblioTool.description).toContain('destructive');
    expect(shokyakuBiblioTool.description).toContain('Requires admin approval');
  });
});

describe('shokyakuBiblioTool — 初回呼出 (requestConfirmation 発火)', () => {
  it('toolConfirmation 不在時: requestConfirmation を「物理削除 = 再装備不可」明示 hint 付きで呼ぶ', async () => {
    const result = await shokyakuBiblioTool.runAsync({
      args: { biblioName: 'wf--test', category: 'biblio-dev' },
      toolContext: mockHitlContext(),
    });
    expect(requestConfirmationMock).toHaveBeenCalledTimes(1);
    expect(requestConfirmationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining('焼却'),
        payload: expect.objectContaining({
          biblioName: 'wf--test',
          category: 'biblio-dev',
          action: 'shokyaku',
        }),
      }),
    );
    // hint は「物理削除 = 再装備不可」を含む (= 禁書との違いを admin が判断可能に、Task 7 GOTCHA 1)
    const call = requestConfirmationMock.mock.calls[0][0];
    expect(call.hint).toContain('再装備不可');
    expect(shokyakuMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, reason: 'config_error', detail: '(承認待ち)' });
  });
});

describe('shokyakuBiblioTool — Resume approve', () => {
  it('confirmed=true 時: shokyaku() を実呼出 + cleanupWarning なしなら log.warn 未発火', async () => {
    shokyakuMock.mockResolvedValue({
      ok: true,
      biblioName: 'wf--test',
      category: 'biblio-dev',
      prUrl: 'https://github.com/HajimariInc/biblio-shelf/pull/400',
      prNumber: 400,
      branchName: 'shokyaku/biblio-dev--wf--test',
    });
    const result = await shokyakuBiblioTool.runAsync({
      args: { biblioName: 'wf--test', category: 'biblio-dev' },
      toolContext: mockHitlContext({
        toolConfirmation: { hint: 'x', confirmed: true, payload: {} } as ToolConfirmation,
      }),
    });
    expect(shokyakuMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, prNumber: 400 });
    expect(vi.mocked(log.warn)).not.toHaveBeenCalledWith(expect.stringContaining('cleanup warning'), expect.anything());
  });

  it('cleanupWarning ありの結果 → log.warn (event=adk.tool.shokyaku.cleanup_warning) を 1 件残す', async () => {
    shokyakuMock.mockResolvedValue({
      ok: true,
      biblioName: 'wf--test',
      category: 'biblio-dev',
      prUrl: 'x',
      prNumber: 1,
      branchName: 'x',
      cleanupWarning: '装備源 dir の物理削除に失敗 (EACCES)',
    });
    const result = await shokyakuBiblioTool.runAsync({
      args: { biblioName: 'wf--test', category: 'biblio-dev' },
      toolContext: mockHitlContext({
        toolConfirmation: { hint: 'x', confirmed: true, payload: {} } as ToolConfirmation,
      }),
    });
    expect(result).toMatchObject({
      ok: true,
      cleanupWarning: expect.stringContaining('装備源 dir'),
    });
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('cleanup warning'),
      expect.objectContaining({
        event: 'adk.tool.shokyaku.cleanup_warning',
        cleanup_warning: '装備源 dir の物理削除に失敗 (EACCES)',
      }),
    );
  });
});

describe('shokyakuBiblioTool — Resume reject', () => {
  it('confirmed=false 時: shokyaku() 未呼出 + 拒否 detail を return', async () => {
    const result = await shokyakuBiblioTool.runAsync({
      args: { biblioName: 'wf--test', category: 'biblio-dev' },
      toolContext: mockHitlContext({
        toolConfirmation: { hint: 'x', confirmed: false, payload: {} } as ToolConfirmation,
      }),
    });
    expect(shokyakuMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      reason: 'config_error',
      detail: expect.stringContaining('admin によって焼却が拒否'),
    });
  });
});

describe('shokyakuBiblioTool — BIBLIO_NAME_RE guard', () => {
  it('不正 biblioName → 即 fail + requestConfirmation + shokyaku() 未呼出', async () => {
    const result = await shokyakuBiblioTool.runAsync({
      args: { biblioName: '../etc/passwd', category: 'biblio-dev' },
      toolContext: mockHitlContext(),
    });
    expect(result).toMatchObject({ ok: false, reason: 'config_error' });
    expect(requestConfirmationMock).not.toHaveBeenCalled();
    expect(shokyakuMock).not.toHaveBeenCalled();
  });
});

describe('shokyakuBiblioTool — Resume 後の異常系', () => {
  it('confirmed=true 経由で shokyaku() が throw したら tool もそのまま throw', async () => {
    shokyakuMock.mockRejectedValue(new Error('unshelve failed'));
    await expect(
      shokyakuBiblioTool.runAsync({
        args: { biblioName: 'wf--test', category: 'biblio-dev' },
        toolContext: mockHitlContext({
          toolConfirmation: { hint: 'x', confirmed: true, payload: {} } as ToolConfirmation,
        }),
      }),
    ).rejects.toThrow(/unshelve failed/);
  });
});

describe('shokyakuBiblioTool — Phase 4 review I2: requestConfirmation throw の防御', () => {
  it('初回呼出で requestConfirmation() が throw → fail-closed で config_error 返却 + shokyaku() 未呼出', async () => {
    requestConfirmationMock.mockImplementation(() => {
      throw new Error('ADK internal: confirmation channel closed');
    });
    const result = await shokyakuBiblioTool.runAsync({
      args: { biblioName: 'wf--test', category: 'biblio-dev' },
      toolContext: mockHitlContext(),
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'config_error',
      detail: expect.stringContaining('requestConfirmation'),
    });
    expect(shokyakuMock).not.toHaveBeenCalled();
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.stringContaining('requestConfirmation threw'),
      expect.objectContaining({ event: 'adk.tool.shokyaku.request_confirmation_error' }),
    );
  });
});
