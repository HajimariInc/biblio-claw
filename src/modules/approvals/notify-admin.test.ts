/**
 * notify-admin (notify-only admin DM) の unit test。
 *
 * 5 case: (1) admin 不在 → no_approver / (2) DM 経路不在 → no_delivery / (3) 正常送信 → sent /
 * (4) debounce 内再送 → debounced / (5) adapter throw → deliver_failed (log 発火 assert)。
 *
 * primitive.ts / channel-registry を vi.mock で置換。debounce map は `_resetDebounceMap`
 * で beforeEach clear (module scope state 汚染防止)。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { pickApproverMock, pickApprovalDeliveryMock, getChannelAdapterMock } = vi.hoisted(() => ({
  pickApproverMock: vi.fn(),
  pickApprovalDeliveryMock: vi.fn(),
  getChannelAdapterMock: vi.fn(),
}));

vi.mock('./primitive.js', () => ({
  pickApprover: (...args: unknown[]) => pickApproverMock(...args),
  pickApprovalDelivery: (...args: unknown[]) => pickApprovalDeliveryMock(...args),
}));

vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapter: (...args: unknown[]) => getChannelAdapterMock(...args),
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { notifyAdmin, _resetDebounceMap } from './notify-admin.js';
import { log } from '../../log.js';

beforeEach(() => {
  pickApproverMock.mockReset();
  pickApprovalDeliveryMock.mockReset();
  getChannelAdapterMock.mockReset();
  vi.mocked(log.info).mockReset();
  vi.mocked(log.warn).mockReset();
  vi.mocked(log.debug).mockReset();
  _resetDebounceMap();
});

describe('notifyAdmin - happy path + debounce', () => {
  it('正常送信 → sent + adapter.deliver 1 回発火', async () => {
    pickApproverMock.mockReturnValue(['slack:U_ADMIN']);
    pickApprovalDeliveryMock.mockResolvedValue({
      userId: 'slack:U_ADMIN',
      messagingGroup: {
        channel_type: 'slack',
        platform_id: 'slack:D_ADMIN_DM',
        id: 'mg-admin',
      },
    });
    const deliverMock = vi.fn().mockResolvedValue('platform-msg-1');
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock });

    const result = await notifyAdmin({
      channelType: 'slack',
      agentGroupId: 'ag-1',
      subject: 'gate.blocked',
      body: 'Injection 疑い発話',
    });

    expect(result).toBe('sent');
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(deliverMock).toHaveBeenCalledWith('slack:D_ADMIN_DM', null, {
      kind: 'chat',
      content: { text: '[gate.blocked]\nInjection 疑い発話' },
    });
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining('sent'),
      expect.objectContaining({ event: 'notify.admin.sent' }),
    );
  });

  it('debounce window 内の 2 回目呼出 → debounced', async () => {
    pickApproverMock.mockReturnValue(['slack:U_ADMIN']);
    pickApprovalDeliveryMock.mockResolvedValue({
      userId: 'slack:U_ADMIN',
      messagingGroup: { channel_type: 'slack', platform_id: 'slack:D_DM', id: 'mg-admin' },
    });
    const deliverMock = vi.fn().mockResolvedValue('ok');
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock });

    const result1 = await notifyAdmin({
      channelType: 'slack',
      agentGroupId: null,
      subject: 'gate.blocked',
      body: 'attempt 1',
    });
    const result2 = await notifyAdmin({
      channelType: 'slack',
      agentGroupId: null,
      subject: 'gate.blocked',
      body: 'attempt 2',
    });

    expect(result1).toBe('sent');
    expect(result2).toBe('debounced');
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.debug)).toHaveBeenCalledWith(
      expect.stringContaining('debounced'),
      expect.objectContaining({ event: 'notify.admin.debounced' }),
    );
  });

  it('別 userId は debounce に引っかからない (Map key=userId)', async () => {
    pickApproverMock.mockReturnValue(['slack:U_ADMIN']);
    pickApprovalDeliveryMock
      .mockResolvedValueOnce({
        userId: 'slack:U_ADMIN_A',
        messagingGroup: { channel_type: 'slack', platform_id: 'slack:D_A', id: 'mg-a' },
      })
      .mockResolvedValueOnce({
        userId: 'slack:U_ADMIN_B',
        messagingGroup: { channel_type: 'slack', platform_id: 'slack:D_B', id: 'mg-b' },
      });
    const deliverMock = vi.fn().mockResolvedValue('ok');
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock });

    const r1 = await notifyAdmin({ channelType: 'slack', agentGroupId: null, subject: 's', body: 'b' });
    const r2 = await notifyAdmin({ channelType: 'slack', agentGroupId: null, subject: 's', body: 'b' });

    expect(r1).toBe('sent');
    expect(r2).toBe('sent');
    expect(deliverMock).toHaveBeenCalledTimes(2);
  });
});

describe('notifyAdmin - failure paths (throw しない契約)', () => {
  it('approvers 空 → no_approver + warn 発火', async () => {
    pickApproverMock.mockReturnValue([]);
    const result = await notifyAdmin({
      channelType: 'slack',
      agentGroupId: 'ag-1',
      subject: 'gate.blocked',
      body: 'x',
    });
    expect(result).toBe('no_approver');
    expect(pickApprovalDeliveryMock).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('no eligible approver'),
      expect.objectContaining({ event: 'notify.admin.no_approver' }),
    );
  });

  it('pickApprovalDelivery が null → no_delivery + warn 発火', async () => {
    pickApproverMock.mockReturnValue(['slack:U_ADMIN']);
    pickApprovalDeliveryMock.mockResolvedValue(null);
    const result = await notifyAdmin({
      channelType: 'slack',
      agentGroupId: null,
      subject: 'gate.blocked',
      body: 'x',
    });
    expect(result).toBe('no_delivery');
    expect(getChannelAdapterMock).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('no DM channel'),
      expect.objectContaining({ event: 'notify.admin.no_delivery' }),
    );
  });

  it('getChannelAdapter が undefined → deliver_failed + warn 発火', async () => {
    pickApproverMock.mockReturnValue(['slack:U_ADMIN']);
    pickApprovalDeliveryMock.mockResolvedValue({
      userId: 'slack:U_ADMIN',
      messagingGroup: { channel_type: 'slack', platform_id: 'slack:D_DM', id: 'mg-admin' },
    });
    getChannelAdapterMock.mockReturnValue(undefined);
    const result = await notifyAdmin({
      channelType: 'slack',
      agentGroupId: null,
      subject: 'gate.blocked',
      body: 'x',
    });
    expect(result).toBe('deliver_failed');
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('no channel adapter'),
      expect.objectContaining({ event: 'notify.admin.no_adapter' }),
    );
  });

  it('adapter.deliver が throw → deliver_failed + warn 発火 (throw しない contract 保護)', async () => {
    pickApproverMock.mockReturnValue(['slack:U_ADMIN']);
    pickApprovalDeliveryMock.mockResolvedValue({
      userId: 'slack:U_ADMIN',
      messagingGroup: { channel_type: 'slack', platform_id: 'slack:D_DM', id: 'mg-admin' },
    });
    const deliverMock = vi.fn().mockRejectedValue(new Error('network error'));
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock });

    const result = await notifyAdmin({
      channelType: 'slack',
      agentGroupId: null,
      subject: 'gate.blocked',
      body: 'x',
    });
    expect(result).toBe('deliver_failed');
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('deliver failed'),
      expect.objectContaining({ event: 'notify.admin.deliver_failed' }),
    );
  });

  it('I3: deliver failure 後は debounce に記録せず、次の legitimate 通知が握りつぶされない', async () => {
    // 1 回目: deliver throw → deliver_failed (debounce に記録されない)
    pickApproverMock.mockReturnValue(['slack:U_ADMIN']);
    pickApprovalDeliveryMock.mockResolvedValue({
      userId: 'slack:U_ADMIN',
      messagingGroup: { channel_type: 'slack', platform_id: 'slack:D_DM', id: 'mg-admin' },
    });
    const deliverMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient network')) // 1 回目失敗
      .mockResolvedValueOnce('ok'); // 2 回目成功
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock });

    const r1 = await notifyAdmin({
      channelType: 'slack',
      agentGroupId: null,
      subject: 'gate.blocked',
      body: 'attempt 1',
    });
    // 直後 (debounce window 内) に 2 回目通知 → 失敗が debounce に記録されていないため sent 到達
    const r2 = await notifyAdmin({
      channelType: 'slack',
      agentGroupId: null,
      subject: 'gate.blocked',
      body: 'attempt 2',
    });

    expect(r1).toBe('deliver_failed');
    expect(r2).toBe('sent');
    expect(deliverMock).toHaveBeenCalledTimes(2);
  });

  it('I15: pickApprover が throw → deliver_failed + unexpected_throw event 発火 (contract 実装で保証)', async () => {
    pickApproverMock.mockImplementation(() => {
      throw new Error('DB down');
    });
    const result = await notifyAdmin({
      channelType: 'slack',
      agentGroupId: null,
      subject: 'gate.blocked',
      body: 'x',
    });
    expect(result).toBe('deliver_failed');
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('unexpected throw'),
      expect.objectContaining({ event: 'notify.admin.unexpected_throw' }),
    );
  });

  it('I15: pickApprovalDelivery が reject → deliver_failed + unexpected_throw event 発火', async () => {
    pickApproverMock.mockReturnValue(['slack:U_ADMIN']);
    pickApprovalDeliveryMock.mockRejectedValue(new Error('openDM API failure'));
    const result = await notifyAdmin({
      channelType: 'slack',
      agentGroupId: null,
      subject: 'gate.blocked',
      body: 'x',
    });
    expect(result).toBe('deliver_failed');
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('unexpected throw'),
      expect.objectContaining({ event: 'notify.admin.unexpected_throw' }),
    );
  });
});
