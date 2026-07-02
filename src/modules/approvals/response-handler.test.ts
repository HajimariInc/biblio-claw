/**
 * response-handler.ts のユニットテスト (M4-B Phase 4 で新規作成).
 *
 * 3 分岐の regression:
 *   1. OneCLI credential approval — in-memory Promise resolve 経由 (resolveOneCLIApproval mock)
 *   2. ADK HITL approval — adk_confirm 分岐 → resolveAdkApproval 呼出 + delete + return true
 *   3. Module-registered approval — 既存 handler dispatch 経路
 *   4. Session_id null + non-adk action — silent drop 経路 (旧挙動温存)
 *   5. Unknown approvalId (row 不在) — return false
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  resolveOneCLIApprovalMock,
  resolveAdkApprovalMock,
  clearAdkApprovalTimerMock,
  getPendingApprovalMock,
  deletePendingApprovalMock,
  getSessionMock,
  getApprovalHandlerMock,
  wakeContainerMock,
  writeSessionMessageMock,
} = vi.hoisted(() => ({
  resolveOneCLIApprovalMock: vi.fn(),
  resolveAdkApprovalMock: vi.fn(),
  clearAdkApprovalTimerMock: vi.fn(),
  getPendingApprovalMock: vi.fn(),
  deletePendingApprovalMock: vi.fn(),
  getSessionMock: vi.fn(),
  getApprovalHandlerMock: vi.fn(),
  wakeContainerMock: vi.fn(),
  writeSessionMessageMock: vi.fn(),
}));

vi.mock('./onecli-approvals.js', () => ({
  ONECLI_ACTION: 'onecli_credential',
  resolveOneCLIApproval: (...args: unknown[]) => resolveOneCLIApprovalMock(...args),
}));

vi.mock('../../adk/approval-dispatcher.js', () => ({
  resolveAdkApproval: (...args: unknown[]) => resolveAdkApprovalMock(...args),
}));

// issue #106: response-handler.ts が `clearAdkApprovalTimer` を import するようになったため
// mock 化。`./adk-approvals.js` の実 module load を避けることで、adk-approvals.ts が dynamic
// import している `dispatcher.js` の副作用 (実 adk-js @google/adk load) を切り離す。
vi.mock('./adk-approvals.js', () => ({
  ADK_CONFIRM_ACTION: 'adk_confirm',
  clearAdkApprovalTimer: (...args: unknown[]) => clearAdkApprovalTimerMock(...args),
}));

vi.mock('../../db/sessions.js', () => ({
  getPendingApproval: (...args: unknown[]) => getPendingApprovalMock(...args),
  deletePendingApproval: (...args: unknown[]) => deletePendingApprovalMock(...args),
  getSession: (...args: unknown[]) => getSessionMock(...args),
}));

vi.mock('./primitive.js', () => ({
  getApprovalHandler: (...args: unknown[]) => getApprovalHandlerMock(...args),
}));

vi.mock('../../container-runner.js', () => ({
  wakeContainer: (...args: unknown[]) => wakeContainerMock(...args),
}));

vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...args: unknown[]) => writeSessionMessageMock(...args),
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { handleApprovalsResponse } from './response-handler.js';

const BASE_PAYLOAD = {
  questionId: 'appr-1',
  value: 'approve',
  userId: 'slack:U123',
  channelType: 'slack',
  platformId: 'slack:U123-dm',
  threadId: null,
};

beforeEach(() => {
  resolveOneCLIApprovalMock.mockReset();
  resolveOneCLIApprovalMock.mockReturnValue(false);
  resolveAdkApprovalMock.mockReset();
  resolveAdkApprovalMock.mockResolvedValue(undefined);
  clearAdkApprovalTimerMock.mockReset();
  // default: admin 応答が timer より先勝ち = true。expiry-race テストでのみ false に上書き。
  clearAdkApprovalTimerMock.mockReturnValue(true);
  getPendingApprovalMock.mockReset();
  deletePendingApprovalMock.mockReset();
  getSessionMock.mockReset();
  getApprovalHandlerMock.mockReset();
  wakeContainerMock.mockReset();
  wakeContainerMock.mockResolvedValue(undefined);
  writeSessionMessageMock.mockReset();
});

describe('handleApprovalsResponse — OneCLI 分岐 (Phase 3 まで存在)', () => {
  it('resolveOneCLIApproval が true → 即 return true (adk / module 分岐に到達しない)', async () => {
    resolveOneCLIApprovalMock.mockReturnValue(true);

    const result = await handleApprovalsResponse(BASE_PAYLOAD);

    expect(result).toBe(true);
    // getPendingApproval に到達しない (= in-memory Promise が優先)
    expect(getPendingApprovalMock).not.toHaveBeenCalled();
    expect(resolveAdkApprovalMock).not.toHaveBeenCalled();
  });
});

describe('handleApprovalsResponse — 未 register の questionId', () => {
  it('resolveOneCLIApproval が false + getPendingApproval が undefined → return false', async () => {
    resolveOneCLIApprovalMock.mockReturnValue(false);
    getPendingApprovalMock.mockReturnValue(undefined);

    const result = await handleApprovalsResponse(BASE_PAYLOAD);

    expect(result).toBe(false);
    expect(resolveAdkApprovalMock).not.toHaveBeenCalled();
  });
});

describe('handleApprovalsResponse — ONECLI_ACTION row (in-memory resolver 不在)', () => {
  it('action=onecli_credential + resolver 消失 → row 削除して return true', async () => {
    resolveOneCLIApprovalMock.mockReturnValue(false);
    getPendingApprovalMock.mockReturnValue({
      approval_id: 'appr-1',
      action: 'onecli_credential',
      payload: '{}',
    });

    const result = await handleApprovalsResponse(BASE_PAYLOAD);

    expect(result).toBe(true);
    expect(deletePendingApprovalMock).toHaveBeenCalledWith('appr-1');
    expect(resolveAdkApprovalMock).not.toHaveBeenCalled();
  });
});

describe('handleApprovalsResponse — Phase 4 ADK HITL 分岐 (adk_confirm)', () => {
  it('action=adk_confirm → clearAdkApprovalTimer → resolveAdkApproval 呼出 + row 削除 + return true', async () => {
    const adkPayload = {
      adkSessionId: 'sess-1',
      functionCallId: 'fc-1',
      userId: 'local',
      agentGroupId: 'ag-1',
      channelType: 'cli',
      platformId: 'local',
      threadId: null,
      hint: '禁書: wf--test',
      innerAction: 'enkin',
      toolPayload: { biblioName: 'wf--test' },
    };
    resolveOneCLIApprovalMock.mockReturnValue(false);
    getPendingApprovalMock.mockReturnValue({
      approval_id: 'appr-1',
      action: 'adk_confirm',
      payload: JSON.stringify(adkPayload),
    });

    const result = await handleApprovalsResponse(BASE_PAYLOAD);

    expect(result).toBe(true);
    // issue #106: clearAdkApprovalTimer が payload.questionId で呼ばれる (race 防止の要)
    expect(clearAdkApprovalTimerMock).toHaveBeenCalledWith('appr-1');
    expect(resolveAdkApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        adkSessionId: 'sess-1',
        functionCallId: 'fc-1',
        userId: 'local',
        innerAction: 'enkin',
      }),
      'approve',
    );
    expect(deletePendingApprovalMock).toHaveBeenCalledWith('appr-1');
    // module-registered handler 経路は経由しない (getApprovalHandler 呼ばれない)
    expect(getApprovalHandlerMock).not.toHaveBeenCalled();
  });

  it('clearAdkApprovalTimer が false 返却 → expire 先勝ち = resolveAdkApproval + row 削除を skip (code-review #1 対応)', async () => {
    // race scenario: timer callback が既に pending Map から entry を pop 済み
    clearAdkApprovalTimerMock.mockReturnValue(false);
    resolveOneCLIApprovalMock.mockReturnValue(false);
    getPendingApprovalMock.mockReturnValue({
      approval_id: 'appr-race',
      action: 'adk_confirm',
      payload: JSON.stringify({ adkSessionId: 's', functionCallId: 'f', userId: 'u' }),
    });

    const result = await handleApprovalsResponse({ ...BASE_PAYLOAD, questionId: 'appr-race' });

    expect(result).toBe(true);
    expect(clearAdkApprovalTimerMock).toHaveBeenCalledWith('appr-race');
    // resolveAdkApproval は skip される (二重 patron 通知防止)
    expect(resolveAdkApprovalMock).not.toHaveBeenCalled();
    // row 削除も skip (expire 経路が最終的に消すため二重 DELETE 回避)
    expect(deletePendingApprovalMock).not.toHaveBeenCalled();
  });

  it('reject 経路も同流儀: resolveAdkApproval に value=reject が渡る', async () => {
    resolveOneCLIApprovalMock.mockReturnValue(false);
    getPendingApprovalMock.mockReturnValue({
      approval_id: 'appr-1',
      action: 'adk_confirm',
      payload: JSON.stringify({ adkSessionId: 's', functionCallId: 'f', userId: 'u' }),
    });

    await handleApprovalsResponse({ ...BASE_PAYLOAD, value: 'reject' });

    expect(resolveAdkApprovalMock).toHaveBeenCalledWith(expect.any(Object), 'reject');
  });

  it('payload JSON.parse 失敗 → row 削除 + return true + log.error (silent 蓄積防止)', async () => {
    resolveOneCLIApprovalMock.mockReturnValue(false);
    getPendingApprovalMock.mockReturnValue({
      approval_id: 'appr-broken',
      action: 'adk_confirm',
      payload: 'this is not JSON',
    });

    const result = await handleApprovalsResponse(BASE_PAYLOAD);

    expect(result).toBe(true);
    expect(resolveAdkApprovalMock).not.toHaveBeenCalled();
    expect(deletePendingApprovalMock).toHaveBeenCalledWith('appr-1');
  });

  it('resolveAdkApproval が想定外に throw → catch + log.error + row 削除 + return true', async () => {
    resolveAdkApprovalMock.mockRejectedValue(new Error('internal error'));
    resolveOneCLIApprovalMock.mockReturnValue(false);
    getPendingApprovalMock.mockReturnValue({
      approval_id: 'appr-1',
      action: 'adk_confirm',
      payload: JSON.stringify({ adkSessionId: 's', functionCallId: 'f', userId: 'u' }),
    });

    const result = await handleApprovalsResponse(BASE_PAYLOAD);

    expect(result).toBe(true);
    expect(deletePendingApprovalMock).toHaveBeenCalledWith('appr-1');
  });
});

describe('handleApprovalsResponse — Module-registered approval regression', () => {
  it('session_id 有り + 別 action → handleRegisteredApproval 経路 (getApprovalHandler 呼び + delete)', async () => {
    resolveOneCLIApprovalMock.mockReturnValue(false);
    const registeredHandlerMock = vi.fn().mockResolvedValue(undefined);
    getPendingApprovalMock.mockReturnValue({
      approval_id: 'appr-mod',
      action: 'self_mod_install',
      payload: '{"pkg":"foo"}',
      session_id: 'sess-mod',
    });
    getSessionMock.mockReturnValue({ id: 'sess-mod', agent_group_id: 'ag-1' });
    getApprovalHandlerMock.mockReturnValue(registeredHandlerMock);

    const result = await handleApprovalsResponse({ ...BASE_PAYLOAD, questionId: 'appr-mod' });

    expect(result).toBe(true);
    // adk_confirm 分岐に到達しない
    expect(resolveAdkApprovalMock).not.toHaveBeenCalled();
    // module-registered handler が呼ばれる
    expect(getApprovalHandlerMock).toHaveBeenCalledWith('self_mod_install');
    expect(registeredHandlerMock).toHaveBeenCalledTimes(1);
    expect(deletePendingApprovalMock).toHaveBeenCalledWith('appr-mod');
    expect(wakeContainerMock).toHaveBeenCalled();
  });

  it('session_id null + 別 action → silent drop (旧挙動温存)', async () => {
    resolveOneCLIApprovalMock.mockReturnValue(false);
    getPendingApprovalMock.mockReturnValue({
      approval_id: 'appr-orphan',
      action: 'some_other_action',
      payload: '{}',
      session_id: null,
    });

    const result = await handleApprovalsResponse({ ...BASE_PAYLOAD, questionId: 'appr-orphan' });

    expect(result).toBe(true);
    expect(resolveAdkApprovalMock).not.toHaveBeenCalled();
    expect(deletePendingApprovalMock).toHaveBeenCalledWith('appr-orphan');
    // handler は呼ばれない (session がないので silent drop)
    expect(getApprovalHandlerMock).not.toHaveBeenCalled();
  });
});
