/**
 * dispatcher.ts のユニットテスト (M4-B Phase 3 + Phase 4 HITL 統合).
 *
 * Phase 4 で `runEphemeral` → `sessionService.createSession + runner.runAsync` に切替。
 * mock 対象:
 *   - `@google/adk` の `isFinalResponse` / `InMemoryRunner` / `InMemorySessionService`
 *   - `./root-agent.js` の `buildRootAgent`
 *   - `./runner.js` の `buildRunner` (runAsync + sessionService.{createSession, deleteSession} を fake)
 *   - `../channels/channel-registry.js` の `getChannelAdapter`
 *   - `../modules/approvals/adk-approvals.js` の `requestAdkApproval` (pending 経路検証用)
 *   - `../log.js`
 *
 * 各 case は `_resetSharedRunnerForTest()` で module-scope singleton を初期化する。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  runAsyncMock,
  createSessionMock,
  deleteSessionMock,
  deliverMock,
  getChannelAdapterMock,
  isFinalResponseMock,
  requestAdkApprovalMock,
} = vi.hoisted(() => ({
  runAsyncMock: vi.fn(),
  createSessionMock: vi.fn(),
  deleteSessionMock: vi.fn(),
  deliverMock: vi.fn(),
  getChannelAdapterMock: vi.fn(),
  isFinalResponseMock: vi.fn(),
  requestAdkApprovalMock: vi.fn(),
}));

vi.mock('@google/adk', () => ({
  isFinalResponse: (...args: unknown[]) => isFinalResponseMock(...args),
  InMemoryRunner: class {},
  InMemorySessionService: class {},
}));

vi.mock('./root-agent.js', () => ({
  buildRootAgent: vi.fn(() => ({})),
}));

vi.mock('./runner.js', () => ({
  buildRunner: vi.fn(() => ({
    runner: {
      runAsync: (...args: unknown[]) => runAsyncMock(...args),
    },
    sessionService: {
      createSession: (...args: unknown[]) => createSessionMock(...args),
      deleteSession: (...args: unknown[]) => deleteSessionMock(...args),
      getSession: vi.fn(),
    },
  })),
  BIBLIO_M4B_APP_NAME: 'biblio_m4b',
}));

vi.mock('../channels/channel-registry.js', () => ({
  getChannelAdapter: (...args: unknown[]) => getChannelAdapterMock(...args),
}));

vi.mock('../modules/approvals/adk-approvals.js', () => ({
  requestAdkApproval: (...args: unknown[]) => requestAdkApprovalMock(...args),
  ADK_CONFIRM_ACTION: 'adk_confirm',
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
  runAsyncMock.mockReset();
  createSessionMock.mockReset();
  createSessionMock.mockResolvedValue({ id: 'sess-mock-1' });
  deleteSessionMock.mockReset();
  deleteSessionMock.mockResolvedValue(undefined);
  deliverMock.mockReset();
  getChannelAdapterMock.mockReset();
  isFinalResponseMock.mockReset();
  requestAdkApprovalMock.mockReset();
  vi.mocked(log.info).mockReset();
  vi.mocked(log.warn).mockReset();
  vi.mocked(log.error).mockReset();
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

  it('戻り値は { runner, sessionService } の形 (Phase 4 拡張)', () => {
    const ctx = getSharedRunner();
    expect(ctx).toHaveProperty('runner');
    expect(ctx).toHaveProperty('sessionService');
  });
});

describe('dispatchToAdk — 通常経路 (isFinalResponse + createSession + deleteSession)', () => {
  it('isFinalResponse 検知 → finalText で adapter.deliver + createSession/deleteSession の両方呼出', async () => {
    const events = [
      { content: { parts: [{ text: 'thinking...' }] } },
      { content: { parts: [{ text: '仕入れ完了です!📦' }] } },
    ];
    runAsyncMock.mockReturnValue(asyncGen(events));
    isFinalResponseMock.mockImplementation((e: unknown) => {
      const ev = e as { content?: { parts?: { text?: string }[] } };
      return ev.content?.parts?.[0]?.text === '仕入れ完了です!📦';
    });
    deliverMock.mockResolvedValue('delivery-abc-123');
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock, channelType: 'cli' });

    await dispatchToAdk({ ...BASE_PARAMS });

    expect(createSessionMock).toHaveBeenCalledWith({ appName: 'biblio_m4b', userId: 'local' });
    expect(runAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'local',
        sessionId: 'sess-mock-1',
        newMessage: { role: 'user', parts: [{ text: '@bot 仕入れて wf/x' }] },
      }),
    );
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(deliverMock).toHaveBeenCalledWith('local', null, {
      kind: 'chat',
      content: { text: '仕入れ完了です!📦' },
    });
    // 通常経路: deleteSession が呼ばれる
    expect(deleteSessionMock).toHaveBeenCalledWith({
      appName: 'biblio_m4b',
      userId: 'local',
      sessionId: 'sess-mock-1',
    });
    // pending 経路経由は呼ばれない
    expect(requestAdkApprovalMock).not.toHaveBeenCalled();
  });

  it('adapter が undefined 返却時 → not_delivered warn ログ (silent 化防止、C1 対処)', async () => {
    runAsyncMock.mockReturnValue(asyncGen([{ content: { parts: [{ text: 'ok' }] } }]));
    isFinalResponseMock.mockReturnValue(true);
    deliverMock.mockResolvedValue(undefined);
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock, channelType: 'cli' });

    await dispatchToAdk({ ...BASE_PARAMS });

    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('adapter returned undefined'),
      expect.objectContaining({ event: 'adk.dispatcher.not_delivered' }),
    );
    expect(vi.mocked(log.info)).not.toHaveBeenCalledWith('ADK dispatcher: delivered', expect.anything());
  });

  it('userId 明示指定時は platformId ではなく userId を採用 (createSession + runAsync 両方に伝搬)', async () => {
    runAsyncMock.mockReturnValue(asyncGen([{ content: { parts: [{ text: 'ok' }] } }]));
    isFinalResponseMock.mockReturnValue(true);
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock, channelType: 'cli' });

    await dispatchToAdk({ ...BASE_PARAMS, userId: 'slack:U0X' });

    expect(createSessionMock).toHaveBeenCalledWith({ appName: 'biblio_m4b', userId: 'slack:U0X' });
    expect(runAsyncMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'slack:U0X' }));
  });
});

describe('dispatchToAdk — Phase 4 HITL pending 経路 (実 API 形状)', () => {
  // adk-js@1.3.0 実装 (`agents/functions.js:129-170` `generateRequestConfirmationEvent`) に基づく
  // 実際の event 形状: `event.content.parts` に `{functionCall: {name: 'adk_request_confirmation',
  // args: {originalFunctionCall, toolConfirmation}, id: <wrapper_id>}}` が入り、
  // `event.longRunningToolIds: [<wrapper_id>]` が populate される。
  // wrapper_id は元 tool call id とは別 namespace の新規 UUID (= Phase 4 review C1)。
  function makeRequestConfirmationEvent(opts: {
    wrapperId: string;
    hint: string;
    payload: { biblioName: string; category: string; action: string };
  }): unknown {
    return {
      content: {
        parts: [
          {
            functionCall: {
              name: 'adk_request_confirmation',
              id: opts.wrapperId,
              args: {
                originalFunctionCall: {
                  name: opts.payload.action === 'enkin' ? 'enkin_biblio' : 'shokyaku_biblio',
                  id: 'original-fc-id-not-used-by-dispatcher',
                  args: {},
                },
                toolConfirmation: {
                  hint: opts.hint,
                  confirmed: false,
                  payload: opts.payload,
                },
              },
            },
          },
        ],
      },
      longRunningToolIds: [opts.wrapperId],
    };
  }

  it('enkin 経路: wrapper function call から payload 取得 + requestAdkApproval + 中間応答 + session 保持', async () => {
    const pendingEvent = makeRequestConfirmationEvent({
      wrapperId: 'wrapper-enkin-1',
      hint: '禁書: wf--test (biblio-dev) を棚から除去します。承認しますか?',
      payload: { biblioName: 'wf--test', category: 'biblio-dev', action: 'enkin' },
    });
    runAsyncMock.mockReturnValue(asyncGen([pendingEvent]));
    isFinalResponseMock.mockReturnValue(false);
    deliverMock.mockResolvedValue('delivery-pending-notice');
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock, channelType: 'cli' });
    requestAdkApprovalMock.mockResolvedValue(true); // Phase 4 C3: boolean 契約

    await dispatchToAdk({ ...BASE_PARAMS });

    expect(requestAdkApprovalMock).toHaveBeenCalledTimes(1);
    expect(requestAdkApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentGroupId: 'ag-1',
        channelType: 'cli',
        platformId: 'local',
        threadId: null,
        userId: 'local',
        adkSessionId: 'sess-mock-1',
        // Phase 4 C1: functionCallId は wrapper id (元 tool call id ではない)
        functionCallId: 'wrapper-enkin-1',
        hint: expect.stringContaining('禁書'),
        action: 'enkin',
        payload: expect.objectContaining({ biblioName: 'wf--test', category: 'biblio-dev', action: 'enkin' }),
      }),
    );
    // 中間応答
    expect(deliverMock).toHaveBeenCalledWith('local', null, {
      kind: 'chat',
      content: { text: expect.stringContaining('承認を admin にお願いしました') },
    });
    // session 保持 (deleteSession skip)
    expect(deleteSessionMock).not.toHaveBeenCalled();
  });

  it('shokyaku 経路も同流儀 (action=shokyaku)', async () => {
    const pendingEvent = makeRequestConfirmationEvent({
      wrapperId: 'wrapper-shokyaku-1',
      hint: '焼却: wf--test (biblio-dev) を棚から除去し、装備源も物理削除します',
      payload: { biblioName: 'wf--test', category: 'biblio-dev', action: 'shokyaku' },
    });
    runAsyncMock.mockReturnValue(asyncGen([pendingEvent]));
    isFinalResponseMock.mockReturnValue(false);
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock, channelType: 'cli' });
    requestAdkApprovalMock.mockResolvedValue(true);

    await dispatchToAdk({ ...BASE_PARAMS });

    expect(requestAdkApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'shokyaku', functionCallId: 'wrapper-shokyaku-1' }),
    );
    expect(deleteSessionMock).not.toHaveBeenCalled();
  });

  it('Phase 4 C3: requestAdkApproval が false 返却 → 中間応答送らず deleteSession + finalText fallback', async () => {
    // 内部 fallback (approver 不在 等) で false を返した場合、dispatcher は「承認申請しました」
    // 中間応答を送らず、通常経路に落として最終応答 (空応答時は "(応答が空でした。)") を deliver、
    // session も deleteSession する。
    const pendingEvent = makeRequestConfirmationEvent({
      wrapperId: 'wrapper-enkin-fail',
      hint: 'x',
      payload: { biblioName: 'wf--test', category: 'biblio-dev', action: 'enkin' },
    });
    runAsyncMock.mockReturnValue(asyncGen([pendingEvent]));
    isFinalResponseMock.mockReturnValue(false);
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock, channelType: 'cli' });
    requestAdkApprovalMock.mockResolvedValue(false); // 内部 fallback で false

    await dispatchToAdk({ ...BASE_PARAMS });

    expect(requestAdkApprovalMock).toHaveBeenCalledTimes(1);
    // 中間応答は送らない (dispatched === 0 で通常経路 fallback)
    expect(deliverMock).not.toHaveBeenCalledWith(
      'local',
      null,
      expect.objectContaining({ content: { text: expect.stringContaining('承認を admin にお願いしました') } }),
    );
    // 通常経路: session 削除 + 空応答 fallback
    expect(deleteSessionMock).toHaveBeenCalled();
    expect(deliverMock).toHaveBeenCalledWith('local', null, {
      kind: 'chat',
      content: { text: '(応答が空でした。)' },
    });
  });

  it('unknown action の payload → skip + log.warn + requestAdkApproval 未呼出 + 通常経路継続', async () => {
    // pending event が入るが、payload.action が不明 (= enkin/shokyaku 以外) の場合、
    // pending 経路として cancel されて通常経路に fall-through する契約。
    const unknownEvent = makeRequestConfirmationEvent({
      wrapperId: 'wrapper-unknown',
      hint: 'x',
      payload: { biblioName: 'wf--test', category: 'biblio-dev', action: 'delete_user_data' },
    });
    const events: unknown[] = [unknownEvent, { content: { parts: [{ text: 'fallback final' }] } }];
    runAsyncMock.mockReturnValue(asyncGen(events));
    isFinalResponseMock.mockImplementation((e: unknown) => {
      const ev = e as { content?: { parts?: { text?: string }[] } };
      // fallback event は parts[0].text 有 (text-only part)、pending event は parts[0].functionCall 有
      return ev.content?.parts?.[0]?.text === 'fallback final';
    });
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock, channelType: 'cli' });

    await dispatchToAdk({ ...BASE_PARAMS });

    expect(requestAdkApprovalMock).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('unknown confirmation action'),
      expect.objectContaining({ event: 'adk.dispatcher.pending_unknown_action' }),
    );
    // pending 経路は成立せず、通常経路として finalText で deliver + deleteSession
    expect(deleteSessionMock).toHaveBeenCalled();
    expect(deliverMock).toHaveBeenCalledWith('local', null, {
      kind: 'chat',
      content: { text: 'fallback final' },
    });
  });

  it('longRunningToolIds 存在するが content.parts に adk_request_confirmation 不在 → skip', async () => {
    // 万一 longRunningToolIds が populate されているが対応する adk_request_confirmation function
    // call が parts に不在の場合 (adk-js のバージョン差異等)、skip して通常経路に fall-through。
    const pendingEvent = {
      content: {
        parts: [{ functionCall: { name: 'some_other_call', id: 'other-1', args: {} } }],
      },
      longRunningToolIds: ['orphan-wrapper-id'],
    };
    runAsyncMock.mockReturnValue(asyncGen([pendingEvent]));
    isFinalResponseMock.mockReturnValue(false);
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock, channelType: 'cli' });

    await dispatchToAdk({ ...BASE_PARAMS });

    expect(requestAdkApprovalMock).not.toHaveBeenCalled();
    // dispatched === 0 → pending=false → 通常経路 → deleteSession
    expect(deleteSessionMock).toHaveBeenCalled();
  });

  it('requestAdkApproval が unexpected throw → catch + log.error + created=false 扱いで通常経路', async () => {
    // requestAdkApproval は throw しない契約だが、防御的 catch (Phase 4 review C2 継承)
    const pendingEvent = makeRequestConfirmationEvent({
      wrapperId: 'wrapper-enkin-throw',
      hint: 'x',
      payload: { biblioName: 'wf--test', category: 'biblio-dev', action: 'enkin' },
    });
    runAsyncMock.mockReturnValue(asyncGen([pendingEvent]));
    isFinalResponseMock.mockReturnValue(false);
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock, channelType: 'cli' });
    requestAdkApprovalMock.mockRejectedValue(new Error('DB error'));

    await dispatchToAdk({ ...BASE_PARAMS });

    // catch されて log.error + created=false → 通常経路 fall-through
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.stringContaining('requestAdkApproval unexpectedly threw'),
      expect.objectContaining({ event: 'adk.dispatcher.request_approval_error' }),
    );
    // session は削除 (通常経路)
    expect(deleteSessionMock).toHaveBeenCalled();
  });
});

describe('dispatchToAdk — ADK error event', () => {
  it('errorCode 付き event → patron 向けエラー text で deliver + error log + deleteSession', async () => {
    runAsyncMock.mockReturnValue(asyncGen([{ errorCode: 'PROVIDER_ERROR', errorMessage: 'Vertex 401' }]));
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
    expect(deleteSessionMock).toHaveBeenCalled();
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      'ADK dispatcher: error event',
      expect.objectContaining({ event: 'adk.dispatcher.error_event' }),
    );
  });
});

describe('dispatchToAdk — no adapter', () => {
  it('getChannelAdapter が undefined → warn log + deliver 呼ばず + throw なし', async () => {
    runAsyncMock.mockReturnValue(asyncGen([{ content: { parts: [{ text: 'ok' }] } }]));
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
  it('空文字列 / whitespace のみ → runAsync + createSession は呼ばず patron に「認識できませんでした」応答', async () => {
    deliverMock.mockResolvedValue('delivery-empty-fallback');
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock, channelType: 'cli' });

    await dispatchToAdk({ ...BASE_PARAMS, patronText: '   ' });

    expect(createSessionMock).not.toHaveBeenCalled();
    expect(runAsyncMock).not.toHaveBeenCalled();
    expect(deliverMock).toHaveBeenCalledWith('local', null, {
      kind: 'chat',
      content: { text: expect.stringContaining('メッセージを認識できませんでした') },
    });
  });
});

describe('dispatchToAdk — runner init failure', () => {
  it('getSharedRunner が throw → patron に system error fallback を送る', async () => {
    const rootAgentMod = await import('./root-agent.js');
    vi.mocked(rootAgentMod.buildRootAgent).mockImplementationOnce(() => {
      throw new Error('LLMRegistry: no model registered for pattern claude-*');
    });
    deliverMock.mockResolvedValue('delivery-init-fail-fallback');
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock, channelType: 'cli' });

    await expect(dispatchToAdk({ ...BASE_PARAMS })).resolves.toBeUndefined();

    expect(createSessionMock).not.toHaveBeenCalled();
    expect(runAsyncMock).not.toHaveBeenCalled();
    expect(deliverMock).toHaveBeenCalledWith('local', null, {
      kind: 'chat',
      content: { text: expect.stringContaining('システム初期化に失敗') },
    });
  });
});

describe('dispatchToAdk — createSession 失敗', () => {
  it('sessionService.createSession が throw → fallback text で deliver + runAsync 呼ばず', async () => {
    createSessionMock.mockRejectedValueOnce(new Error('session service unavailable'));
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock, channelType: 'cli' });

    await dispatchToAdk({ ...BASE_PARAMS });

    expect(runAsyncMock).not.toHaveBeenCalled();
    expect(deliverMock).toHaveBeenCalledWith('local', null, {
      kind: 'chat',
      content: { text: expect.stringContaining('会話セッションの作成に失敗') },
    });
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      'ADK dispatcher: createSession failed',
      expect.objectContaining({ event: 'adk.dispatcher.create_session_failed' }),
    );
  });
});

describe('dispatchToAdk — runAsync throw', () => {
  it('event stream 内例外 → 日本語 fallback text で deliver + deleteSession は依然実行', async () => {
    runAsyncMock.mockImplementation(() => ({
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(new Error('vertex timeout')) };
      },
    }));
    getChannelAdapterMock.mockReturnValue({ deliver: deliverMock, channelType: 'cli' });

    await dispatchToAdk({ ...BASE_PARAMS });

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const call = deliverMock.mock.calls[0]!;
    expect(call[2].content.text).toContain('エラー');
    expect(call[2].content.text).toContain('LLM 呼び出しに失敗');
    expect(deleteSessionMock).toHaveBeenCalled();
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      'ADK dispatcher: unexpected throw',
      expect.objectContaining({ event: 'adk.dispatcher.unexpected_error' }),
    );
  });
});

describe('dispatchToAdk — 空応答', () => {
  it('final event の text が空 → "(応答が空でした。)" fallback', async () => {
    runAsyncMock.mockReturnValue(asyncGen([{ content: { parts: [{ text: '' }] } }]));
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
    runAsyncMock.mockReturnValue(asyncGen([{ content: { parts: [{ text: 'ok' }] } }]));
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
