/**
 * dispatcher.ts のユニットテスト (M4-B Phase 3)。
 *
 * mock 対象:
 *   - `@google/adk` の `isFinalResponse` / `InMemoryRunner`
 *   - `./root-agent.js` の `buildRootAgent`
 *   - `./runner.js` の `buildRunner` (runEphemeral を fake async generator に差替)
 *   - `../channels/channel-registry.js` の `getChannelAdapter`
 *   - `../log.js`
 *
 * 各 case は `_resetSharedRunnerForTest()` で module-scope singleton を初期化する。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { runEphemeralMock, deliverMock, getChannelAdapterMock, isFinalResponseMock } = vi.hoisted(() => ({
  runEphemeralMock: vi.fn(),
  deliverMock: vi.fn(),
  getChannelAdapterMock: vi.fn(),
  isFinalResponseMock: vi.fn(),
}));

vi.mock('@google/adk', () => ({
  isFinalResponse: (...args: unknown[]) => isFinalResponseMock(...args),
  // dispatcher.ts は import type でしか InMemoryRunner を参照しないが、runner.ts が
  // 実 import している経路も mock 対象なので stub class を提供する。
  InMemoryRunner: class {},
}));

vi.mock('./root-agent.js', () => ({
  buildRootAgent: vi.fn(() => ({})),
}));

vi.mock('./runner.js', () => ({
  buildRunner: vi.fn(() => ({
    runEphemeral: (...args: unknown[]) => runEphemeralMock(...args),
  })),
  BIBLIO_M4B_APP_NAME: 'biblio_m4b',
}));

vi.mock('../channels/channel-registry.js', () => ({
  getChannelAdapter: (...args: unknown[]) => getChannelAdapterMock(...args),
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { dispatchToAdk, _resetSharedRunnerForTest, getSharedRunner } from './dispatcher.js';
import { log } from '../log.js';

/** yield 済 event 配列を async iterable に包む helper。 */
async function* asyncGen<T>(events: T[]): AsyncGenerator<T> {
  for (const e of events) yield e;
}

const BASE_PARAMS = {
  agentGroupId: 'ag-1',
  messagingGroupId: 'mg-1',
  channelType: 'cli',
  platformId: 'local',
  threadId: null,
  userId: null,
  patronText: '@bot 仕入れて wf/x',
  requestId: 'req-1',
};

beforeEach(async () => {
  _resetSharedRunnerForTest();
  runEphemeralMock.mockReset();
  deliverMock.mockReset();
  getChannelAdapterMock.mockReset();
  isFinalResponseMock.mockReset();
  vi.mocked(log.info).mockReset();
  vi.mocked(log.warn).mockReset();
  vi.mocked(log.error).mockReset();
  // buildRunner / buildRootAgent 経由の call count は module-scope の vi.fn() が持ち越すため、
  // 各 test 独立に検証するには beforeEach でクリアする。
  const runnerMod = await import('./runner.js');
  vi.mocked(runnerMod.buildRunner).mockClear();
  const rootAgentMod = await import('./root-agent.js');
  vi.mocked(rootAgentMod.buildRootAgent).mockClear();
});

describe('getSharedRunner — module-level singleton', () => {
  it('複数回呼出で同じ instance を返す + 1 度だけ buildRunner が発火', async () => {
    const r1 = getSharedRunner();
    const r2 = getSharedRunner();
    expect(r1).toBe(r2);
    // buildRunner 呼出回数の直接検証は import mock 内 vi.fn() で担保 (= vi.mocked).
    const runnerMod = await import('./runner.js');
    expect(vi.mocked(runnerMod.buildRunner)).toHaveBeenCalledTimes(1);
  });

  it('_resetSharedRunnerForTest 後に呼び直すと新規生成される', async () => {
    getSharedRunner();
    _resetSharedRunnerForTest();
    getSharedRunner();
    const runnerMod = await import('./runner.js');
    expect(vi.mocked(runnerMod.buildRunner)).toHaveBeenCalledTimes(2);
  });
});

describe('dispatchToAdk — happy path', () => {
  it('isFinalResponse 検知 → finalText で adapter.deliver を呼ぶ', async () => {
    const events = [
      { content: { parts: [{ text: 'thinking...' }] } },
      { content: { parts: [{ text: '仕入れ完了です!📦' }] } },
    ];
    runEphemeralMock.mockReturnValue(asyncGen(events));
    isFinalResponseMock.mockImplementation((e: unknown) => {
      const ev = e as { content?: { parts?: { text?: string }[] } };
      return ev.content?.parts?.[0]?.text === '仕入れ完了です!📦';
    });
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock, channelType: 'cli' });

    await dispatchToAdk({ ...BASE_PARAMS });

    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(deliverMock).toHaveBeenCalledWith('local', null, {
      kind: 'chat',
      content: { text: '仕入れ完了です!📦' },
    });
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      'ADK dispatcher: delivered',
      expect.objectContaining({ event: 'adk.dispatcher.delivered' }),
    );
  });

  it('userId 明示指定時は platformId ではなく userId を採用', async () => {
    runEphemeralMock.mockReturnValue(asyncGen([{ content: { parts: [{ text: 'ok' }] } }]));
    isFinalResponseMock.mockReturnValue(true);
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock, channelType: 'cli' });

    await dispatchToAdk({ ...BASE_PARAMS, userId: 'slack:U0X' });

    // runEphemeral の第 1 引数の userId を検査
    expect(runEphemeralMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'slack:U0X' }));
  });
});

describe('dispatchToAdk — ADK error event', () => {
  it('errorCode 付き event → patron 向けエラー text で deliver + error log', async () => {
    runEphemeralMock.mockReturnValue(asyncGen([{ errorCode: 'PROVIDER_ERROR', errorMessage: 'Vertex 401' }]));
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock, channelType: 'slack' });

    await dispatchToAdk({
      ...BASE_PARAMS,
      channelType: 'slack',
      platformId: 'C0X',
      threadId: 't-1',
      requestId: 'req-err',
    });

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const call = deliverMock.mock.calls[0]!;
    expect(call[0]).toBe('C0X');
    expect(call[1]).toBe('t-1');
    expect(call[2].content.text).toContain('PROVIDER_ERROR');
    expect(call[2].content.text).toContain('Vertex 401');
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      'ADK dispatcher: error event',
      expect.objectContaining({ event: 'adk.dispatcher.error_event' }),
    );
  });
});

describe('dispatchToAdk — no adapter', () => {
  it('getChannelAdapter が undefined → warn log + deliver 呼ばず + throw なし', async () => {
    runEphemeralMock.mockReturnValue(asyncGen([{ content: { parts: [{ text: 'ok' }] } }]));
    isFinalResponseMock.mockReturnValue(true);
    getChannelAdapterMock.mockReturnValue(undefined);

    await expect(dispatchToAdk({ ...BASE_PARAMS, channelType: 'unknown' })).resolves.toBeUndefined();

    expect(deliverMock).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'ADK dispatcher: no adapter for channel type',
      expect.objectContaining({ event: 'adk.dispatcher.no_adapter', channel_type: 'unknown' }),
    );
  });
});

describe('dispatchToAdk — 空 patronText', () => {
  it('空文字列 / whitespace のみは early return + warn', async () => {
    await dispatchToAdk({ ...BASE_PARAMS, patronText: '   ' });
    expect(runEphemeralMock).not.toHaveBeenCalled();
    expect(getChannelAdapterMock).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'ADK dispatcher: empty patronText, skipping',
      expect.objectContaining({ event: 'adk.dispatcher.empty_input' }),
    );
  });
});

describe('dispatchToAdk — runEphemeral throw', () => {
  it('event stream 内例外 → 日本語 fallback text で deliver', async () => {
    runEphemeralMock.mockImplementation(() => {
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () => Promise.reject(new Error('vertex timeout')),
          };
        },
      };
    });
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock, channelType: 'cli' });

    await dispatchToAdk({ ...BASE_PARAMS });

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const call = deliverMock.mock.calls[0]!;
    expect(call[2].content.text).toContain('エラー');
    expect(call[2].content.text).toContain('LLM 呼び出しに失敗');
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      'ADK dispatcher: unexpected throw',
      expect.objectContaining({ event: 'adk.dispatcher.unexpected_error' }),
    );
  });
});

describe('dispatchToAdk — 空応答', () => {
  it('final event の text が空 → "(応答が空でした。)" fallback', async () => {
    runEphemeralMock.mockReturnValue(asyncGen([{ content: { parts: [{ text: '' }] } }]));
    isFinalResponseMock.mockReturnValue(true);
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock, channelType: 'cli' });

    await dispatchToAdk({ ...BASE_PARAMS });

    expect(deliverMock).toHaveBeenCalledWith('local', null, {
      kind: 'chat',
      content: { text: '(応答が空でした。)' },
    });
  });
});

describe('dispatchToAdk — adapter.deliver throw', () => {
  it('deliver 失敗は catch + error log、throw しない', async () => {
    runEphemeralMock.mockReturnValue(asyncGen([{ content: { parts: [{ text: 'ok' }] } }]));
    isFinalResponseMock.mockReturnValue(true);
    deliverMock.mockRejectedValue(new Error('slack API 500'));
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock, channelType: 'slack' });

    await expect(dispatchToAdk({ ...BASE_PARAMS, channelType: 'slack' })).resolves.toBeUndefined();

    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      'ADK dispatcher: deliver failed',
      expect.objectContaining({ event: 'adk.dispatcher.deliver_failed' }),
    );
  });
});
