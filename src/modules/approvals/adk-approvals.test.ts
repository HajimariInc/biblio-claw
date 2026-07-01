/**
 * adk-approvals.ts のユニットテスト (M4-B Phase 4).
 *
 * `requestAdkApproval` の 4 経路 (正常 / approver 不在 / DM 経路不在 / deliver throw) を検証。
 * onecli-approvals.ts の pattern を継承し、DB row 作成 + adapter.deliver + fallback 通知の
 * 3 point を assert する。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  pickApproverMock,
  pickApprovalDeliveryMock,
  getDeliveryAdapterMock,
  getChannelAdapterMock,
  createPendingApprovalMock,
  deliverMock,
  fallbackDeliverMock,
} = vi.hoisted(() => ({
  pickApproverMock: vi.fn(),
  pickApprovalDeliveryMock: vi.fn(),
  getDeliveryAdapterMock: vi.fn(),
  getChannelAdapterMock: vi.fn(),
  createPendingApprovalMock: vi.fn(),
  deliverMock: vi.fn(),
  fallbackDeliverMock: vi.fn(),
}));

vi.mock('./primitive.js', () => ({
  pickApprover: (...args: unknown[]) => pickApproverMock(...args),
  pickApprovalDelivery: (...args: unknown[]) => pickApprovalDeliveryMock(...args),
}));

vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => getDeliveryAdapterMock(),
}));

vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapter: (...args: unknown[]) => getChannelAdapterMock(...args),
}));

vi.mock('../../db/sessions.js', () => ({
  createPendingApproval: (...args: unknown[]) => createPendingApprovalMock(...args),
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { requestAdkApproval, ADK_CONFIRM_ACTION, type RequestAdkApprovalOptions } from './adk-approvals.js';
import { log } from '../../log.js';

const BASE_OPTS: RequestAdkApprovalOptions = {
  agentGroupId: 'ag-1',
  channelType: 'cli',
  platformId: 'local',
  threadId: null,
  userId: 'local',
  adkSessionId: 'sess-1',
  functionCallId: 'fc-1',
  hint: '禁書: wf--test',
  action: 'enkin',
  payload: { biblioName: 'wf--test', category: 'biblio-dev', action: 'enkin' },
};

beforeEach(() => {
  pickApproverMock.mockReset();
  pickApprovalDeliveryMock.mockReset();
  getDeliveryAdapterMock.mockReset();
  getChannelAdapterMock.mockReset();
  createPendingApprovalMock.mockReset();
  deliverMock.mockReset();
  fallbackDeliverMock.mockReset();
  vi.mocked(log.info).mockReset();
  vi.mocked(log.warn).mockReset();
  vi.mocked(log.error).mockReset();
});

describe('ADK_CONFIRM_ACTION 定数', () => {
  it('response-handler.ts の分岐 key として "adk_confirm" 固定', () => {
    expect(ADK_CONFIRM_ACTION).toBe('adk_confirm');
  });
});

describe('requestAdkApproval — 正常経路', () => {
  it('approver + DM 解決 → adapter.deliver で ask_question card 配信 + createPendingApproval', async () => {
    pickApproverMock.mockReturnValue(['slack:U123']);
    pickApprovalDeliveryMock.mockResolvedValue({
      userId: 'slack:U123',
      messagingGroup: { channel_type: 'slack', platform_id: 'slack:U123-dm' },
    });
    deliverMock.mockResolvedValue('platform-msg-abc');
    getDeliveryAdapterMock.mockReturnValue({ deliver: deliverMock });

    await requestAdkApproval(BASE_OPTS);

    // ask_question card が正しい形式で配信される
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(deliverMock).toHaveBeenCalledWith('slack', 'slack:U123-dm', null, 'chat-sdk', expect.any(String));
    const cardPayload = JSON.parse(deliverMock.mock.calls[0]![4] as string);
    expect(cardPayload).toMatchObject({
      type: 'ask_question',
      title: '禁書の承認',
      question: '禁書: wf--test',
      options: [
        { label: 'Approve', value: 'approve' },
        { label: 'Reject', value: 'reject' },
      ],
    });
    expect(cardPayload.questionId).toMatch(/^adk-[a-z0-9]+$/);

    // pending_approvals row: session_id=null + action=adk_confirm + payload に session 情報
    expect(createPendingApprovalMock).toHaveBeenCalledTimes(1);
    const row = createPendingApprovalMock.mock.calls[0]![0];
    expect(row).toMatchObject({
      session_id: null,
      action: 'adk_confirm',
      agent_group_id: 'ag-1',
      channel_type: 'slack',
      platform_id: 'slack:U123-dm',
      platform_message_id: 'platform-msg-abc',
      status: 'pending',
      title: '禁書の承認',
    });
    const payload = JSON.parse(row.payload);
    expect(payload).toMatchObject({
      adkSessionId: 'sess-1',
      functionCallId: 'fc-1',
      userId: 'local',
      agentGroupId: 'ag-1',
      channelType: 'cli',
      platformId: 'local',
      threadId: null,
      innerAction: 'enkin',
      toolPayload: { biblioName: 'wf--test', category: 'biblio-dev', action: 'enkin' },
    });
  });

  it('shokyaku 経路: title は「焼却の承認」', async () => {
    pickApproverMock.mockReturnValue(['slack:U123']);
    pickApprovalDeliveryMock.mockResolvedValue({
      userId: 'slack:U123',
      messagingGroup: { channel_type: 'slack', platform_id: 'slack:U123-dm' },
    });
    deliverMock.mockResolvedValue('platform-msg-abc');
    getDeliveryAdapterMock.mockReturnValue({ deliver: deliverMock });

    await requestAdkApproval({ ...BASE_OPTS, action: 'shokyaku' });

    const cardPayload = JSON.parse(deliverMock.mock.calls[0]![4] as string);
    expect(cardPayload.title).toBe('焼却の承認');
    const row = createPendingApprovalMock.mock.calls[0]![0];
    expect(row.title).toBe('焼却の承認');
  });

  it('event=adk.approval.dispatch.enkin log が 1 件出る (verify-m4-b.sh Section 6.5 で grep される)', async () => {
    pickApproverMock.mockReturnValue(['slack:U123']);
    pickApprovalDeliveryMock.mockResolvedValue({
      userId: 'slack:U123',
      messagingGroup: { channel_type: 'slack', platform_id: 'slack:U123-dm' },
    });
    deliverMock.mockResolvedValue('platform-msg-abc');
    getDeliveryAdapterMock.mockReturnValue({ deliver: deliverMock });

    await requestAdkApproval(BASE_OPTS);

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      'ADK approval requested',
      expect.objectContaining({
        event: 'adk.approval.dispatch.enkin',
        action: 'enkin',
      }),
    );
  });
});

describe('requestAdkApproval — approver 不在', () => {
  it('pickApprover が空配列 → patron に fallback 通知 + createPendingApproval 呼ばれない', async () => {
    pickApproverMock.mockReturnValue([]);
    getChannelAdapterMock.mockReturnValue({ deliver: fallbackDeliverMock });

    await requestAdkApproval(BASE_OPTS);

    expect(pickApprovalDeliveryMock).not.toHaveBeenCalled();
    expect(fallbackDeliverMock).toHaveBeenCalledWith('local', null, {
      kind: 'chat',
      content: { text: expect.stringContaining('承認可能な admin / owner が未設定') },
    });
    expect(createPendingApprovalMock).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('no eligible approver'),
      expect.objectContaining({ event: 'adk.approval.no_approver' }),
    );
  });
});

describe('requestAdkApproval — DM 経路不在', () => {
  it('pickApprovalDelivery が null → patron に fallback 通知 + createPendingApproval 呼ばれない', async () => {
    pickApproverMock.mockReturnValue(['slack:U123']);
    pickApprovalDeliveryMock.mockResolvedValue(null);
    getChannelAdapterMock.mockReturnValue({ deliver: fallbackDeliverMock });

    await requestAdkApproval(BASE_OPTS);

    expect(fallbackDeliverMock).toHaveBeenCalledWith('local', null, {
      kind: 'chat',
      content: { text: expect.stringContaining('承認可能な approver への DM 経路がありません') },
    });
    expect(createPendingApprovalMock).not.toHaveBeenCalled();
  });
});

describe('requestAdkApproval — adapter.deliver throw', () => {
  it('card 配信失敗 → patron に fallback 通知 + createPendingApproval 呼ばれない (silent 蓄積防止)', async () => {
    pickApproverMock.mockReturnValue(['slack:U123']);
    pickApprovalDeliveryMock.mockResolvedValue({
      userId: 'slack:U123',
      messagingGroup: { channel_type: 'slack', platform_id: 'slack:U123-dm' },
    });
    deliverMock.mockRejectedValue(new Error('slack API 500'));
    getDeliveryAdapterMock.mockReturnValue({ deliver: deliverMock });
    getChannelAdapterMock.mockReturnValue({ deliver: fallbackDeliverMock });

    await requestAdkApproval(BASE_OPTS);

    expect(fallbackDeliverMock).toHaveBeenCalledWith('local', null, {
      kind: 'chat',
      content: { text: expect.stringContaining('承認カード配信に失敗') },
    });
    expect(createPendingApprovalMock).not.toHaveBeenCalled();
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.stringContaining('failed to deliver approval card'),
      expect.objectContaining({ event: 'adk.approval.deliver_failed' }),
    );
  });
});

describe('requestAdkApproval — delivery adapter 未 wire', () => {
  it('getDeliveryAdapter が null → patron に fallback 通知 + createPendingApproval 呼ばれない', async () => {
    pickApproverMock.mockReturnValue(['slack:U123']);
    pickApprovalDeliveryMock.mockResolvedValue({
      userId: 'slack:U123',
      messagingGroup: { channel_type: 'slack', platform_id: 'slack:U123-dm' },
    });
    getDeliveryAdapterMock.mockReturnValue(null);
    getChannelAdapterMock.mockReturnValue({ deliver: fallbackDeliverMock });

    await requestAdkApproval(BASE_OPTS);

    expect(fallbackDeliverMock).toHaveBeenCalledWith('local', null, {
      kind: 'chat',
      content: { text: expect.stringContaining('配信系統が未初期化') },
    });
    expect(createPendingApprovalMock).not.toHaveBeenCalled();
  });
});

describe('requestAdkApproval — fallback 通知経路の adapter 不在', () => {
  it('approver 不在 かつ getChannelAdapter も undefined → warn log で終了 (throw なし)', async () => {
    pickApproverMock.mockReturnValue([]);
    getChannelAdapterMock.mockReturnValue(undefined);

    await expect(requestAdkApproval(BASE_OPTS)).resolves.toBe(false);

    expect(fallbackDeliverMock).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('no channel adapter for patron notification'),
      expect.objectContaining({ event: 'adk.approval.fallback_no_adapter' }),
    );
  });
});
