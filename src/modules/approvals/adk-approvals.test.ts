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
  deletePendingApprovalMock,
  getPendingApprovalMock,
  getPendingApprovalsByActionMock,
  updatePendingApprovalStatusMock,
  getSharedRunnerMock,
  deleteSessionMock,
  deliverMock,
  fallbackDeliverMock,
} = vi.hoisted(() => ({
  pickApproverMock: vi.fn(),
  pickApprovalDeliveryMock: vi.fn(),
  getDeliveryAdapterMock: vi.fn(),
  getChannelAdapterMock: vi.fn(),
  createPendingApprovalMock: vi.fn(),
  deletePendingApprovalMock: vi.fn(),
  getPendingApprovalMock: vi.fn(),
  getPendingApprovalsByActionMock: vi.fn(),
  updatePendingApprovalStatusMock: vi.fn(),
  getSharedRunnerMock: vi.fn(),
  deleteSessionMock: vi.fn(),
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
  deletePendingApproval: (...args: unknown[]) => deletePendingApprovalMock(...args),
  getPendingApproval: (...args: unknown[]) => getPendingApprovalMock(...args),
  getPendingApprovalsByAction: (...args: unknown[]) => getPendingApprovalsByActionMock(...args),
  updatePendingApprovalStatus: (...args: unknown[]) => updatePendingApprovalStatusMock(...args),
}));

// issue #106: adk-approvals.ts が `getSharedRunner` (dispatcher.ts) と `BIBLIO_M4B_APP_NAME`
// (runner.ts) を import するようになったため mock 化。dispatcher.js を素で import すると adk-js
// (`@google/adk`) の実 module load が走り test 環境が重くなる (= mock で切り離す)。
vi.mock('../../adk/dispatcher.js', () => ({
  getSharedRunner: () => getSharedRunnerMock(),
}));

vi.mock('../../adk/runner.js', () => ({
  BIBLIO_M4B_APP_NAME: 'biblio_m4b',
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  requestAdkApproval,
  ADK_CONFIRM_ACTION,
  ADK_APPROVAL_TIMEOUT_MS,
  DEFAULT_ADK_APPROVAL_TIMEOUT_MS,
  clearAdkApprovalTimer,
  parseAdkApprovalTimeoutMs,
  startAdkApprovalHandler,
  stopAdkApprovalHandler,
  type RequestAdkApprovalOptions,
} from './adk-approvals.js';
import { log } from '../../log.js';
import type { PendingApproval } from '../../types.js';

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
  deletePendingApprovalMock.mockReset();
  getPendingApprovalMock.mockReset();
  getPendingApprovalsByActionMock.mockReset();
  updatePendingApprovalStatusMock.mockReset();
  getSharedRunnerMock.mockReset();
  deleteSessionMock.mockReset();
  deliverMock.mockReset();
  fallbackDeliverMock.mockReset();
  vi.mocked(log.info).mockReset();
  vi.mocked(log.warn).mockReset();
  vi.mocked(log.error).mockReset();
  // issue #106: module state (pending Map / adapterRef / started) を各 test 前に reset。
  // stopAdkApprovalHandler は idempotent なので startAdkApprovalHandler 未呼出の状態でも安全。
  stopAdkApprovalHandler();
  vi.useRealTimers();
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

// ── issue #106: timeout config / Layer 1 (expires_at) / Layer 2 (setTimeout expiry) /
//              Layer 3 (startAdkApprovalHandler + sweepStaleAdkApprovals) ──

describe('parseAdkApprovalTimeoutMs — env 数値化', () => {
  it('undefined → null', () => {
    expect(parseAdkApprovalTimeoutMs(undefined)).toBeNull();
  });
  it('empty string → null', () => {
    expect(parseAdkApprovalTimeoutMs('')).toBeNull();
  });
  it('負値 → null', () => {
    expect(parseAdkApprovalTimeoutMs('-1')).toBeNull();
  });
  it('0 → null (0 は timeout として無意味)', () => {
    expect(parseAdkApprovalTimeoutMs('0')).toBeNull();
  });
  it('non-numeric → null', () => {
    expect(parseAdkApprovalTimeoutMs('abc')).toBeNull();
  });
  it('正の数値 → number', () => {
    expect(parseAdkApprovalTimeoutMs('60000')).toBe(60000);
  });
});

describe('ADK_APPROVAL_TIMEOUT_MS — default', () => {
  it('DEFAULT は 30 min (1800000 ms)', () => {
    expect(DEFAULT_ADK_APPROVAL_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });
  it('module load 時に env 未設定なら DEFAULT に一致 (本 test の実行 env 前提)', () => {
    // vitest の実行環境で ADK_APPROVAL_TIMEOUT_MS を明示的に設定していない前提。
    // 設定されている場合は本 case が fail するので、CI 側で unset するか test-env で分岐する。
    if (process.env.ADK_APPROVAL_TIMEOUT_MS === undefined) {
      expect(ADK_APPROVAL_TIMEOUT_MS).toBe(DEFAULT_ADK_APPROVAL_TIMEOUT_MS);
    }
  });
});

describe('requestAdkApproval — Layer 1: expires_at 設定', () => {
  it('正常経路で createPendingApproval に expires_at (= now + ADK_APPROVAL_TIMEOUT_MS) が渡る', async () => {
    pickApproverMock.mockReturnValue(['slack:U123']);
    pickApprovalDeliveryMock.mockResolvedValue({
      userId: 'slack:U123',
      messagingGroup: { channel_type: 'slack', platform_id: 'slack:U123-dm' },
    });
    deliverMock.mockResolvedValue('platform-msg-abc');
    getDeliveryAdapterMock.mockReturnValue({ deliver: deliverMock });

    const beforeMs = Date.now();
    await requestAdkApproval(BASE_OPTS);
    const afterMs = Date.now();

    expect(createPendingApprovalMock).toHaveBeenCalledTimes(1);
    const row = createPendingApprovalMock.mock.calls[0]![0];
    expect(row.expires_at).toEqual(expect.any(String));
    const expiresAtMs = new Date(row.expires_at).getTime();
    const createdAtMs = new Date(row.created_at).getTime();
    // created_at と expires_at の差は ADK_APPROVAL_TIMEOUT_MS ちょうど (単一 nowMs から派生)
    expect(expiresAtMs - createdAtMs).toBe(ADK_APPROVAL_TIMEOUT_MS);
    // expires_at は (beforeMs + timeout) 以上 (afterMs + timeout) 以下
    expect(expiresAtMs).toBeGreaterThanOrEqual(beforeMs + ADK_APPROVAL_TIMEOUT_MS);
    expect(expiresAtMs).toBeLessThanOrEqual(afterMs + ADK_APPROVAL_TIMEOUT_MS);
  });
});

describe('requestAdkApproval — Layer 2: setTimeout expiry', () => {
  const setupHappyMocks = (): void => {
    pickApproverMock.mockReturnValue(['slack:U123']);
    pickApprovalDeliveryMock.mockResolvedValue({
      userId: 'slack:U123',
      messagingGroup: { channel_type: 'slack', platform_id: 'slack:U123-dm' },
    });
    deliverMock.mockResolvedValue('platform-msg-abc');
    getDeliveryAdapterMock.mockReturnValue({ deliver: deliverMock });
    getSharedRunnerMock.mockReturnValue({ sessionService: { deleteSession: deleteSessionMock } });
    deleteSessionMock.mockResolvedValue(undefined);
  };

  const makeRow = (approvalId: string): PendingApproval =>
    ({
      approval_id: approvalId,
      session_id: null,
      request_id: approvalId,
      action: ADK_CONFIRM_ACTION,
      payload: JSON.stringify({
        adkSessionId: 'sess-1',
        functionCallId: 'fc-1',
        userId: 'local',
        agentGroupId: 'ag-1',
        channelType: 'cli',
        platformId: 'local',
        threadId: null,
        hint: '禁書: wf--test',
        innerAction: 'enkin',
        toolPayload: { biblioName: 'wf--test', category: 'biblio-dev', action: 'enkin' },
      }),
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + ADK_APPROVAL_TIMEOUT_MS).toISOString(),
      agent_group_id: 'ag-1',
      channel_type: 'slack',
      platform_id: 'slack:U123-dm',
      platform_message_id: 'platform-msg-abc',
      status: 'pending',
      title: '禁書の承認',
      options_json: '[]',
    }) as unknown as PendingApproval;

  it('admin 未応答で timer 発火 → status=expired + card edit + patron notify + deleteSession + row delete', async () => {
    vi.useFakeTimers();
    setupHappyMocks();

    // adapterRef を set するために startAdkApprovalHandler を呼ぶ (sweep は空を返す)
    getPendingApprovalsByActionMock.mockReturnValue([]);
    startAdkApprovalHandler({ deliver: deliverMock } as never);
    // startAdkApprovalHandler が内部で sweep を .catch(...) の Promise chain 経由で await せずに
    // 発火するため、microtask を 1 tick 進めて sweep の同期部分を完遂させる。
    await vi.advanceTimersByTimeAsync(0);

    await requestAdkApproval(BASE_OPTS);

    // ここまでで pending Map に entry が入っている。timer をトリガ:
    const approvalId = createPendingApprovalMock.mock.calls[0]![0].approval_id as string;
    getPendingApprovalMock.mockReturnValue(makeRow(approvalId));
    getChannelAdapterMock.mockReturnValue({ deliver: fallbackDeliverMock });
    fallbackDeliverMock.mockResolvedValue('patron-delivery-id');

    await vi.advanceTimersByTimeAsync(ADK_APPROVAL_TIMEOUT_MS + 100);

    // (1) status='expired' 更新
    expect(updatePendingApprovalStatusMock).toHaveBeenCalledWith(approvalId, 'expired');
    // (2) Slack card edit (adapterRef 経由 = deliverMock、5 引数 shape)
    const editCall = deliverMock.mock.calls.find(
      (c) => typeof c[4] === 'string' && (c[4] as string).includes('Expired (no response)'),
    );
    expect(editCall).toBeDefined();
    // (3) patron 通知 (raw ChannelAdapter 経由 = fallbackDeliverMock、3 引数 shape)
    expect(fallbackDeliverMock).toHaveBeenCalledWith('local', null, {
      kind: 'chat',
      content: { text: expect.stringContaining('承認がタイムアウト') },
    });
    // (4) sessionService.deleteSession 呼出 (Pod 生存中の expiry なので実行)
    expect(deleteSessionMock).toHaveBeenCalledWith({
      appName: 'biblio_m4b',
      userId: 'local',
      sessionId: 'sess-1',
    });
    // (5) row 削除
    expect(deletePendingApprovalMock).toHaveBeenCalledWith(approvalId);
  });

  it('admin が timeout 前に応答 → clearAdkApprovalTimer で timer clear → advance しても expire 発火せず', async () => {
    vi.useFakeTimers();
    setupHappyMocks();
    getPendingApprovalsByActionMock.mockReturnValue([]);
    startAdkApprovalHandler({ deliver: deliverMock } as never);
    await vi.advanceTimersByTimeAsync(0);

    await requestAdkApproval(BASE_OPTS);
    const approvalId = createPendingApprovalMock.mock.calls[0]![0].approval_id as string;

    // 通常応答経路の代用: clearAdkApprovalTimer を明示呼出
    clearAdkApprovalTimer(approvalId);

    // deliverMock / updatePendingApprovalStatus 呼び出し回数を timer 発火時と比較するため
    // clear 直前で snapshot 化
    const deliverCallsBefore = deliverMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(ADK_APPROVAL_TIMEOUT_MS + 100);

    // clear 後は expire フローが動かない = row 削除 / status 更新 / patron notify / deleteSession
    // が発火しない
    expect(updatePendingApprovalStatusMock).not.toHaveBeenCalled();
    expect(deletePendingApprovalMock).not.toHaveBeenCalled();
    expect(deleteSessionMock).not.toHaveBeenCalled();
    // fallbackDeliverMock (= raw channel adapter 経路) も呼ばれない
    expect(fallbackDeliverMock).not.toHaveBeenCalled();
    // adapterRef 経由の card edit も追加で発火しない
    expect(deliverMock.mock.calls.length).toBe(deliverCallsBefore);
  });

  it('clearAdkApprovalTimer — 未登録 approval_id は false 返却 (no-op、throw なし)', () => {
    // 事前に何も register していない状態でも安全に呼べる
    expect(clearAdkApprovalTimer('adk-nonexistent')).toBe(false);
  });

  it('clearAdkApprovalTimer — 登録済 approval_id は true 返却 (= admin 応答が先勝ちを claim)', async () => {
    vi.useFakeTimers();
    setupHappyMocks();
    getPendingApprovalsByActionMock.mockReturnValue([]);
    startAdkApprovalHandler({ deliver: deliverMock } as never);
    await vi.advanceTimersByTimeAsync(0);
    await requestAdkApproval(BASE_OPTS);
    const approvalId = createPendingApprovalMock.mock.calls[0]![0].approval_id as string;

    // 初回 clear は true (admin 応答が timer 発火前)
    expect(clearAdkApprovalTimer(approvalId)).toBe(true);
    // 2 回目は false (pending Map から既に pop 済)
    expect(clearAdkApprovalTimer(approvalId)).toBe(false);
  });

  it('deleteSession throw → warn only、card edit + patron notify + row delete は完遂', async () => {
    vi.useFakeTimers();
    setupHappyMocks();
    // sessionService.deleteSession は throw
    deleteSessionMock.mockRejectedValue(new Error('adk session gone'));

    getPendingApprovalsByActionMock.mockReturnValue([]);
    startAdkApprovalHandler({ deliver: deliverMock } as never);
    await vi.advanceTimersByTimeAsync(0);
    await requestAdkApproval(BASE_OPTS);
    const approvalId = createPendingApprovalMock.mock.calls[0]![0].approval_id as string;
    getPendingApprovalMock.mockReturnValue(makeRow(approvalId));
    getChannelAdapterMock.mockReturnValue({ deliver: fallbackDeliverMock });
    fallbackDeliverMock.mockResolvedValue('patron-delivery-id');

    await vi.advanceTimersByTimeAsync(ADK_APPROVAL_TIMEOUT_MS + 100);

    // deleteSession は throw したが row 削除は必ず完遂
    expect(deletePendingApprovalMock).toHaveBeenCalledWith(approvalId);
    // card edit + patron notify も完遂
    expect(fallbackDeliverMock).toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('deleteSession failed'),
      expect.objectContaining({ event: 'adk.approval.expire_delete_session_failed' }),
    );
  });

  it('card edit throw → warn only、patron notify + row delete + deleteSession は完遂', async () => {
    vi.useFakeTimers();
    setupHappyMocks();
    // deliverMock を mockImplementation で上書き (count 観測 + Expired card edit のみ throw)。
    // 順序: setupHappyMocks の mockResolvedValue → 本 mockImplementation の順で後勝ち。
    // requestAdkApproval の**前**に set する必要がある (= ask_question 配信も count に含めるため)。
    let deliverCallCount = 0;
    deliverMock.mockImplementation(async (...args: unknown[]) => {
      deliverCallCount++;
      // 5 引数 shape の 5 番目 (payload) に "Expired" を含めば edit 経路
      const payload = args[4];
      if (typeof payload === 'string' && payload.includes('Expired')) {
        throw new Error('slack rate limit');
      }
      return 'platform-msg-abc';
    });

    getPendingApprovalsByActionMock.mockReturnValue([]);
    startAdkApprovalHandler({ deliver: deliverMock } as never);
    await vi.advanceTimersByTimeAsync(0);
    await requestAdkApproval(BASE_OPTS); // ここで count = 1 (ask_question 配信)
    const approvalId = createPendingApprovalMock.mock.calls[0]![0].approval_id as string;
    getPendingApprovalMock.mockReturnValue(makeRow(approvalId));
    getChannelAdapterMock.mockReturnValue({ deliver: fallbackDeliverMock });
    fallbackDeliverMock.mockResolvedValue('patron-delivery-id');

    await vi.advanceTimersByTimeAsync(ADK_APPROVAL_TIMEOUT_MS + 100);

    expect(deletePendingApprovalMock).toHaveBeenCalledWith(approvalId);
    expect(deleteSessionMock).toHaveBeenCalled();
    expect(fallbackDeliverMock).toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('Failed to edit expired ADK approval card'),
      expect.objectContaining({ event: 'adk.approval.card_edit_failed' }),
    );
    // count = 2 (ask_question 配信 + Expired card edit の 2 回、後者で throw)
    expect(deliverCallCount).toBe(2);
  });
});

describe('startAdkApprovalHandler + sweepStaleAdkApprovals — Layer 3', () => {
  it('起動時に既存 pending_approvals row (adk_confirm) を 2 件 sweep → card edit + patron notify + row delete', async () => {
    const row1 = {
      approval_id: 'adk-aaaa1111',
      session_id: null,
      request_id: 'adk-aaaa1111',
      action: ADK_CONFIRM_ACTION,
      payload: JSON.stringify({
        adkSessionId: 'sess-1',
        functionCallId: 'fc-1',
        userId: 'local',
        agentGroupId: 'ag-1',
        channelType: 'cli',
        platformId: 'local',
        threadId: null,
        hint: '',
        innerAction: 'enkin',
        toolPayload: { biblioName: 'wf--test-a', category: 'biblio-dev', action: 'enkin' },
      }),
      created_at: new Date().toISOString(),
      expires_at: null,
      agent_group_id: 'ag-1',
      channel_type: 'slack',
      platform_id: 'slack:U123-dm',
      platform_message_id: 'platform-msg-a',
      status: 'pending',
      title: '禁書の承認',
      options_json: '[]',
    } as unknown as PendingApproval;
    const row2 = {
      ...row1,
      approval_id: 'adk-bbbb2222',
      request_id: 'adk-bbbb2222',
      platform_message_id: 'platform-msg-b',
    } as PendingApproval;

    getPendingApprovalsByActionMock.mockReturnValue([row1, row2]);
    // sweep 経路も expireAdkApproval を通るため getPendingApproval は各 approval_id で row を返す
    getPendingApprovalMock.mockImplementation((id: string) => (id === row1.approval_id ? row1 : row2));
    getChannelAdapterMock.mockReturnValue({ deliver: fallbackDeliverMock });
    fallbackDeliverMock.mockResolvedValue('patron-delivery-id');
    deliverMock.mockResolvedValue('edit-ok');

    startAdkApprovalHandler({ deliver: deliverMock } as never);

    // sweep は .catch() で await されないため microtask を進めて完了させる
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // 2 row 分の status=expired 更新
    expect(updatePendingApprovalStatusMock).toHaveBeenCalledWith(row1.approval_id, 'expired');
    expect(updatePendingApprovalStatusMock).toHaveBeenCalledWith(row2.approval_id, 'expired');
    // 2 row 分の card edit (adapterRef 経由の 'Expired (host restarted)')
    const editCalls = deliverMock.mock.calls.filter(
      (c) => typeof c[4] === 'string' && (c[4] as string).includes('Expired (host restarted)'),
    );
    expect(editCalls.length).toBe(2);
    // patron notify は raw channel adapter 経由で 2 回、reason='host restarted' の日本語
    const patronCalls = fallbackDeliverMock.mock.calls.filter(
      (c) =>
        typeof c[2] === 'object' &&
        c[2] !== null &&
        (c[2] as { content?: { text?: string } }).content?.text?.includes('Pod 再起動'),
    );
    expect(patronCalls.length).toBe(2);
    // 2 row 分の row 削除
    expect(deletePendingApprovalMock).toHaveBeenCalledWith(row1.approval_id);
    expect(deletePendingApprovalMock).toHaveBeenCalledWith(row2.approval_id);
    // Pod 再起動経路 (reason='host restarted') なので sessionService.deleteSession は skip
    expect(deleteSessionMock).not.toHaveBeenCalled();
  });

  it('sweep 対象 row 0 件でも start は成功 (idempotent 初期状態)', async () => {
    getPendingApprovalsByActionMock.mockReturnValue([]);
    startAdkApprovalHandler({ deliver: deliverMock } as never);
    await new Promise((resolve) => setImmediate(resolve));
    expect(updatePendingApprovalStatusMock).not.toHaveBeenCalled();
    expect(deletePendingApprovalMock).not.toHaveBeenCalled();
    // handler_started event は log される
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining('ADK approval handler started'),
      expect.objectContaining({ event: 'adk.approval.handler_started' }),
    );
  });

  it('startAdkApprovalHandler を 2 回連続呼出 → sweep は 1 回のみ (idempotent)', async () => {
    getPendingApprovalsByActionMock.mockReturnValue([]);
    startAdkApprovalHandler({ deliver: deliverMock } as never);
    startAdkApprovalHandler({ deliver: deliverMock } as never);
    await new Promise((resolve) => setImmediate(resolve));
    // getPendingApprovalsByAction は 1 回だけ呼ばれる (sweep が 2 回目 skip される)
    expect(getPendingApprovalsByActionMock).toHaveBeenCalledTimes(1);
  });

  it('1 row の cleanup が throw しても残り row の sweep は継続 (code-review #3 対応)', async () => {
    const makeStaleRow = (id: string) =>
      ({
        approval_id: id,
        session_id: null,
        request_id: id,
        action: ADK_CONFIRM_ACTION,
        payload: JSON.stringify({
          adkSessionId: 'sess-' + id,
          functionCallId: 'fc-' + id,
          userId: 'local',
          agentGroupId: 'ag-1',
          channelType: 'cli',
          platformId: 'local',
          threadId: null,
          hint: '',
          innerAction: 'enkin',
          toolPayload: { biblioName: 'wf--test-' + id, category: 'biblio-dev', action: 'enkin' },
        }),
        created_at: new Date().toISOString(),
        expires_at: null,
        agent_group_id: 'ag-1',
        channel_type: 'slack',
        platform_id: 'slack:U123-dm',
        platform_message_id: 'platform-msg-' + id,
        status: 'pending',
        title: '禁書の承認',
        options_json: '[]',
      }) as unknown as PendingApproval;
    const row1 = makeStaleRow('aaaa1111');
    const row2 = makeStaleRow('bbbb2222');

    getPendingApprovalsByActionMock.mockReturnValue([row1, row2]);
    getPendingApprovalMock.mockImplementation((id: string) => (id === row1.approval_id ? row1 : row2));
    // row1 の updatePendingApprovalStatus で throw、row2 は成功
    updatePendingApprovalStatusMock.mockImplementation((id: string) => {
      if (id === row1.approval_id) throw new Error('db locked');
    });
    getChannelAdapterMock.mockReturnValue({ deliver: fallbackDeliverMock });
    fallbackDeliverMock.mockResolvedValue('patron-delivery-id');
    deliverMock.mockResolvedValue('edit-ok');

    startAdkApprovalHandler({ deliver: deliverMock } as never);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // row1 の cleanup は throw で中断 = row 削除に到達しない
    expect(deletePendingApprovalMock).not.toHaveBeenCalledWith(row1.approval_id);
    // row2 は無事完遂 = row 削除される
    expect(deletePendingApprovalMock).toHaveBeenCalledWith(row2.approval_id);
    // per-row error は log.error される
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.stringContaining('sweep: row cleanup failed'),
      expect.objectContaining({ event: 'adk.approval.sweep_row_failed', approval_id: row1.approval_id }),
    );
    // sweep_done log の failed count が 1
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining('Swept stale ADK approvals'),
      expect.objectContaining({ event: 'adk.approval.sweep_done', count: 2, failed: 1 }),
    );
  });
});

describe('stopAdkApprovalHandler — 全 timer clear', () => {
  it('pending timer 2 件があっても stop 後は advance しても発火しない', async () => {
    vi.useFakeTimers();
    pickApproverMock.mockReturnValue(['slack:U123']);
    pickApprovalDeliveryMock.mockResolvedValue({
      userId: 'slack:U123',
      messagingGroup: { channel_type: 'slack', platform_id: 'slack:U123-dm' },
    });
    deliverMock.mockResolvedValue('platform-msg-abc');
    getDeliveryAdapterMock.mockReturnValue({ deliver: deliverMock });
    getPendingApprovalsByActionMock.mockReturnValue([]);

    startAdkApprovalHandler({ deliver: deliverMock } as never);
    await vi.advanceTimersByTimeAsync(0);

    await requestAdkApproval(BASE_OPTS);
    await requestAdkApproval({ ...BASE_OPTS, functionCallId: 'fc-2' });

    // 2 件の pending timer 登録済。stop で全 clear。
    stopAdkApprovalHandler();

    const snapBefore = {
      updateStatus: updatePendingApprovalStatusMock.mock.calls.length,
      del: deletePendingApprovalMock.mock.calls.length,
    };
    await vi.advanceTimersByTimeAsync(ADK_APPROVAL_TIMEOUT_MS + 100);
    // stop で全 timer clear + Map クリアしたので expire フローが動かない
    expect(updatePendingApprovalStatusMock.mock.calls.length).toBe(snapBefore.updateStatus);
    expect(deletePendingApprovalMock.mock.calls.length).toBe(snapBefore.del);
  });
});
