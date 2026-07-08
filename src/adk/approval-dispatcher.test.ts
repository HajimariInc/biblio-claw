/**
 * approval-dispatcher.ts のユニットテスト.
 *
 * `resolveAdkApproval` の 4 経路 (approve resume / reject resume / session not found /
 * runAsync throw) を mock 経由で検証。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  runAsyncMock,
  getSessionMock,
  deleteSessionMock,
  deliverMock,
  getChannelAdapterMock,
  isFinalResponseMock,
  getSharedRunnerMock,
} = vi.hoisted(() => ({
  runAsyncMock: vi.fn(),
  getSessionMock: vi.fn(),
  deleteSessionMock: vi.fn(),
  deliverMock: vi.fn(),
  getChannelAdapterMock: vi.fn(),
  isFinalResponseMock: vi.fn(),
  getSharedRunnerMock: vi.fn(),
}));

vi.mock('@google/adk', () => ({
  isFinalResponse: (...args: unknown[]) => isFinalResponseMock(...args),
}));

// dispatcher.js の getSharedRunner を mock (= runner + sessionService を返す factory 差替)
vi.mock('./dispatcher.js', () => ({
  getSharedRunner: () => getSharedRunnerMock(),
}));

vi.mock('../channels/channel-registry.js', () => ({
  getChannelAdapter: (...args: unknown[]) => getChannelAdapterMock(...args),
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { resolveAdkApproval, type AdkApprovalPayload } from './approval-dispatcher.js';
import { log } from '../log.js';

async function* asyncGen<T>(events: T[]): AsyncGenerator<T> {
  for (const e of events) yield e;
}

const BASE_PAYLOAD: AdkApprovalPayload = {
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
};

beforeEach(() => {
  runAsyncMock.mockReset();
  getSessionMock.mockReset();
  deleteSessionMock.mockReset();
  deleteSessionMock.mockResolvedValue(undefined);
  deliverMock.mockReset();
  deliverMock.mockResolvedValue('delivery-abc');
  getChannelAdapterMock.mockReset();
  getChannelAdapterMock.mockReturnValue({ deliver: deliverMock });
  isFinalResponseMock.mockReset();
  getSharedRunnerMock.mockReset();
  getSharedRunnerMock.mockReturnValue({
    runner: { runAsync: (...args: unknown[]) => runAsyncMock(...args) },
    sessionService: {
      getSession: (...args: unknown[]) => getSessionMock(...args),
      deleteSession: (...args: unknown[]) => deleteSessionMock(...args),
    },
  });
  vi.mocked(log.info).mockReset();
  vi.mocked(log.warn).mockReset();
  vi.mocked(log.error).mockReset();
});

describe('resolveAdkApproval — approve resume', () => {
  it('session found + approve → runAsync に functionResponse.confirmed=true 送信 + adapter.deliver + deleteSession', async () => {
    getSessionMock.mockResolvedValue({ id: 'sess-1' });
    runAsyncMock.mockReturnValue(asyncGen([{ content: { parts: [{ text: '禁書 PR を作成しました。' }] } }]));
    isFinalResponseMock.mockReturnValue(true);

    await resolveAdkApproval(BASE_PAYLOAD, 'approve');

    expect(getSessionMock).toHaveBeenCalledWith({
      appName: 'biblio_m4b',
      userId: 'local',
      sessionId: 'sess-1',
    });
    expect(runAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'local',
        sessionId: 'sess-1',
        newMessage: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'fc-1',
                name: 'adk_request_confirmation',
                response: { confirmed: true },
              },
            },
          ],
        },
      }),
    );
    expect(deliverMock).toHaveBeenCalledWith('local', null, {
      kind: 'chat',
      content: { text: '禁書 PR を作成しました。' },
    });
    expect(deleteSessionMock).toHaveBeenCalledWith({
      appName: 'biblio_m4b',
      userId: 'local',
      sessionId: 'sess-1',
    });
  });
});

describe('resolveAdkApproval — reject resume', () => {
  it('session found + reject → functionResponse.confirmed=false 送信 + adapter.deliver + deleteSession', async () => {
    getSessionMock.mockResolvedValue({ id: 'sess-1' });
    runAsyncMock.mockReturnValue(asyncGen([{ content: { parts: [{ text: 'admin によって拒否されました。' }] } }]));
    isFinalResponseMock.mockReturnValue(true);

    await resolveAdkApproval(BASE_PAYLOAD, 'reject');

    expect(runAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        newMessage: expect.objectContaining({
          parts: [
            expect.objectContaining({
              functionResponse: expect.objectContaining({
                response: { confirmed: false },
              }),
            }),
          ],
        }),
      }),
    );
    expect(deleteSessionMock).toHaveBeenCalled();
  });
});

describe('resolveAdkApproval — session not found (Pod 再起動対応)', () => {
  it('getSession が undefined → runAsync 呼ばず + patron に「失効」通知 deliver', async () => {
    getSessionMock.mockResolvedValue(undefined);

    await resolveAdkApproval(BASE_PAYLOAD, 'approve');

    expect(runAsyncMock).not.toHaveBeenCalled();
    expect(deliverMock).toHaveBeenCalledWith('local', null, {
      kind: 'chat',
      content: { text: expect.stringContaining('Pod 再起動により承認セッションが失効') },
    });
    // session が無いので deleteSession も呼ぶ必要なし
    expect(deleteSessionMock).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('session not found'),
      expect.objectContaining({ event: 'adk.approval.session_lost' }),
    );
  });
});

describe('resolveAdkApproval — runAsync throw', () => {
  it('event stream 内例外 → 「承認後の処理に失敗」fallback text deliver + deleteSession は依然実行', async () => {
    getSessionMock.mockResolvedValue({ id: 'sess-1' });
    runAsyncMock.mockImplementation(() => ({
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(new Error('runner internal error')) };
      },
    }));

    await resolveAdkApproval(BASE_PAYLOAD, 'approve');

    expect(deliverMock).toHaveBeenCalledWith('local', null, {
      kind: 'chat',
      content: { text: expect.stringContaining('承認後の処理に失敗') },
    });
    expect(deleteSessionMock).toHaveBeenCalled();
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.stringContaining('runAsync threw'),
      expect.objectContaining({ event: 'adk.approval.resume_error' }),
    );
  });
});

describe('resolveAdkApproval — ADK error event', () => {
  it('errorCode 付き event → エラー text で deliver + deleteSession', async () => {
    getSessionMock.mockResolvedValue({ id: 'sess-1' });
    runAsyncMock.mockReturnValue(asyncGen([{ errorCode: 'RESUME_FAILURE', errorMessage: 'internal state corrupt' }]));
    isFinalResponseMock.mockReturnValue(false);

    await resolveAdkApproval(BASE_PAYLOAD, 'approve');

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const call = deliverMock.mock.calls[0]!;
    expect(call[2].content.text).toContain('RESUME_FAILURE');
    expect(deleteSessionMock).toHaveBeenCalled();
  });
});

describe('resolveAdkApproval — runner init failure', () => {
  it('getSharedRunner が throw → patron に system error fallback', async () => {
    getSharedRunnerMock.mockImplementationOnce(() => {
      throw new Error('LLMRegistry misconfigured');
    });

    await resolveAdkApproval(BASE_PAYLOAD, 'approve');

    expect(runAsyncMock).not.toHaveBeenCalled();
    expect(deliverMock).toHaveBeenCalledWith('local', null, {
      kind: 'chat',
      content: { text: expect.stringContaining('システム初期化に失敗') },
    });
  });
});

describe('resolveAdkApproval — adapter unavailable', () => {
  it('getChannelAdapter が undefined → warn log + throw なし', async () => {
    getSessionMock.mockResolvedValue({ id: 'sess-1' });
    runAsyncMock.mockReturnValue(asyncGen([{ content: { parts: [{ text: 'ok' }] } }]));
    isFinalResponseMock.mockReturnValue(true);
    getChannelAdapterMock.mockReturnValue(undefined);

    await expect(resolveAdkApproval(BASE_PAYLOAD, 'approve')).resolves.toBeUndefined();

    expect(deliverMock).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('no channel adapter'),
      expect.objectContaining({ event: 'adk.approval.no_adapter' }),
    );
  });
});
