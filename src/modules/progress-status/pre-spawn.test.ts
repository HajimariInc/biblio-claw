/**
 * pre-spawn (`emitPreSpawnStatus` + `emitAdkToolStatus` +
 * `clearAdkTargetStatus`) の unit test。
 *
 * 従来これらは専用 test を持たず、dispatcher.test.ts + router.gate.test.ts でも
 * 呼出引数の assertion がなく、ADK 経路の唯一の入口 (`emitAdkToolStatus`) の
 * 分岐 (skip 条件 / rate-limit ガード / throw fail-safe) が unit test で未検証だった。
 *
 * カバー範囲:
 *   - emitPreSpawnStatus: adapter 未登録 / setTyping 未実装 / 正常呼出 / throw 時 warn 化
 *   - emitAdkToolStatus: mapper 委譲 / 変化時のみ発火 (rate-limit) / target 別独立
 *   - clearAdkTargetStatus: state 解放後に再発火が通る
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapter: vi.fn(),
}));
vi.mock('../../log.js', () => ({
  log: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import type { ChannelAdapter } from '../../channels/adapter.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { log } from '../../log.js';

import {
  _resetAdkTargetStatusForTest,
  clearAdkTargetStatus,
  emitAdkToolStatus,
  emitPreSpawnStatus,
} from './pre-spawn.js';

// mock ChannelAdapter (setTyping 中心)。vi.fn() の Mock 型を ChannelAdapter の
// signature に合わせるため `as unknown as ChannelAdapter` で cast する。
function mkAdapter(overrides: Partial<{ setTyping: ReturnType<typeof vi.fn> }> = {}): ChannelAdapter {
  return {
    name: 'slack',
    channelType: 'slack',
    supportsThreads: true,
    setup: vi.fn(),
    teardown: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    deliver: vi.fn(),
    setTyping: overrides.setTyping ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as ChannelAdapter;
}

describe('emitPreSpawnStatus', () => {
  beforeEach(() => {
    _resetAdkTargetStatusForTest();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('silent skip (debug) when adapter is not registered', async () => {
    vi.mocked(getChannelAdapter).mockReturnValue(undefined);
    await emitPreSpawnStatus('slack', 'U1', 'T1', '分類中');
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining('no setTyping'),
      expect.objectContaining({ event: 'progress.status.pre_spawn.no_adapter' }),
    );
  });

  it('silent skip when adapter has no setTyping (CLI / Fugue)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getChannelAdapter).mockReturnValue({ setTyping: undefined } as any);
    await emitPreSpawnStatus('cli', 'op-user', null, '分類中');
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining('no setTyping'),
      expect.objectContaining({ event: 'progress.status.pre_spawn.no_adapter', channel_type: 'cli' }),
    );
  });

  it('calls adapter.setTyping with (platformId, threadId, status)', async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getChannelAdapter).mockReturnValue(mkAdapter({ setTyping }));
    await emitPreSpawnStatus('slack', 'U1', 'T1', '分類中');
    expect(setTyping).toHaveBeenCalledWith('U1', 'T1', '分類中');
  });

  it('warn (best-effort) when adapter.setTyping throws (routing / dispatch を殺さない)', async () => {
    const setTyping = vi.fn().mockRejectedValue(new Error('429 rate limited'));
    vi.mocked(getChannelAdapter).mockReturnValue(mkAdapter({ setTyping }));
    await expect(emitPreSpawnStatus('slack', 'U1', 'T1', '分類中')).resolves.not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
      expect.objectContaining({ event: 'progress.status.pre_spawn.failed', channel_type: 'slack' }),
    );
  });
});

describe('emitAdkToolStatus (rate-limit ガード)', () => {
  beforeEach(() => {
    _resetAdkTargetStatusForTest();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('maps ADK biblio tool to Japanese and forwards', async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getChannelAdapter).mockReturnValue(mkAdapter({ setTyping }));
    await emitAdkToolStatus('slack', 'U1', 'T1', 'acquire_biblio');
    expect(setTyping).toHaveBeenCalledWith('U1', 'T1', '仕入れ中');
  });

  it('generic fallback for unknown tool (silent 化しない)', async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getChannelAdapter).mockReturnValue(mkAdapter({ setTyping }));
    await emitAdkToolStatus('slack', 'U1', 'T1', 'FutureUnmappedTool');
    expect(setTyping).toHaveBeenCalledWith('U1', 'T1', '作業中 (FutureUnmappedTool)');
  });

  it('rate-limit ガード: 同一 target + 同一 tool 連続呼出は 1 回のみ発火', async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getChannelAdapter).mockReturnValue(mkAdapter({ setTyping }));
    await emitAdkToolStatus('slack', 'U1', 'T1', 'acquire_biblio');
    await emitAdkToolStatus('slack', 'U1', 'T1', 'acquire_biblio');
    await emitAdkToolStatus('slack', 'U1', 'T1', 'acquire_biblio');
    expect(setTyping).toHaveBeenCalledTimes(1);
  });

  it('rate-limit ガード: 別 tool への遷移は発火する', async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getChannelAdapter).mockReturnValue(mkAdapter({ setTyping }));
    await emitAdkToolStatus('slack', 'U1', 'T1', 'acquire_biblio');
    await emitAdkToolStatus('slack', 'U1', 'T1', 'inspect_biblio');
    expect(setTyping).toHaveBeenCalledTimes(2);
    expect(setTyping).toHaveBeenNthCalledWith(1, 'U1', 'T1', '仕入れ中');
    expect(setTyping).toHaveBeenNthCalledWith(2, 'U1', 'T1', '検品中');
  });

  it('rate-limit ガード: 別 target (別 threadId) は独立 key で発火する', async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getChannelAdapter).mockReturnValue(mkAdapter({ setTyping }));
    await emitAdkToolStatus('slack', 'U1', 'T1', 'acquire_biblio');
    await emitAdkToolStatus('slack', 'U1', 'T2', 'acquire_biblio');
    expect(setTyping).toHaveBeenCalledTimes(2);
  });

  it('rate-limit ガード: 別 platformId でも独立 key で発火する', async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getChannelAdapter).mockReturnValue(mkAdapter({ setTyping }));
    await emitAdkToolStatus('slack', 'U1', null, 'acquire_biblio');
    await emitAdkToolStatus('slack', 'U2', null, 'acquire_biblio');
    expect(setTyping).toHaveBeenCalledTimes(2);
  });
});

// `progress.status.transition` structured log emit を検証。emitPreSpawnStatus
// の 3 outcome (no_adapter / triggered / failed) と emitAdkToolStatus の遷移時 emit + tool_name
// 保持を assert。成功パス log を補完した実装を直接テスト。
describe('progress.status.transition emit', () => {
  beforeEach(() => {
    _resetAdkTargetStatusForTest();
    vi.clearAllMocks();
  });

  it('emitPreSpawnStatus: no_adapter 分岐で outcome=no_adapter を emit', async () => {
    vi.mocked(getChannelAdapter).mockReturnValue(undefined);
    await emitPreSpawnStatus('slack', 'U1', 'T1', '分類中');
    expect(log.info).toHaveBeenCalledWith(
      'progress.status.transition',
      expect.objectContaining({
        source: 'emitPreSpawnStatus',
        outcome: 'no_adapter',
        channel_type: 'slack',
        platform_id: 'U1',
        thread_id: 'T1',
        status: '分類中',
        adapter_supports_typing: false,
      }),
    );
  });

  it('emitPreSpawnStatus: 成功時 outcome=triggered を emit', async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getChannelAdapter).mockReturnValue(mkAdapter({ setTyping }));
    await emitPreSpawnStatus('slack', 'U1', 'T1', '分類中');
    expect(log.info).toHaveBeenCalledWith(
      'progress.status.transition',
      expect.objectContaining({
        source: 'emitPreSpawnStatus',
        outcome: 'triggered',
        adapter_supports_typing: true,
      }),
    );
  });

  it('emitPreSpawnStatus: setTyping throw 時 outcome=failed を emit', async () => {
    const setTyping = vi.fn().mockRejectedValue(new Error('rate limited'));
    vi.mocked(getChannelAdapter).mockReturnValue(mkAdapter({ setTyping }));
    await emitPreSpawnStatus('slack', 'U1', 'T1', '分類中');
    expect(log.info).toHaveBeenCalledWith(
      'progress.status.transition',
      expect.objectContaining({
        source: 'emitPreSpawnStatus',
        outcome: 'failed',
        adapter_supports_typing: true,
      }),
    );
  });

  it('emitAdkToolStatus: 遷移時 source=emitAdkToolStatus + tool_name + previous_status を emit', async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getChannelAdapter).mockReturnValue(mkAdapter({ setTyping }));
    await emitAdkToolStatus('slack', 'U1', 'T1', 'acquire_biblio');
    expect(log.info).toHaveBeenCalledWith(
      'progress.status.transition',
      expect.objectContaining({
        source: 'emitAdkToolStatus',
        outcome: 'transition',
        tool_name: 'acquire_biblio',
        status: '仕入れ中',
        previous_status: null,
      }),
    );
  });

  it('emitAdkToolStatus: 同 tool 再送では source=emitAdkToolStatus emit されない (rate 抑止)', async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getChannelAdapter).mockReturnValue(mkAdapter({ setTyping }));
    await emitAdkToolStatus('slack', 'U1', 'T1', 'acquire_biblio');
    vi.mocked(log.info).mockClear();
    await emitAdkToolStatus('slack', 'U1', 'T1', 'acquire_biblio');

    const adkCalls = vi
      .mocked(log.info)
      .mock.calls.filter(
        (c) =>
          typeof c[1] === 'object' && c[1] !== null && (c[1] as { source?: string }).source === 'emitAdkToolStatus',
      );
    expect(adkCalls).toHaveLength(0);
  });
});

describe('clearAdkTargetStatus', () => {
  beforeEach(() => {
    _resetAdkTargetStatusForTest();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('clears the per-target state so the next emit fires again', async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getChannelAdapter).mockReturnValue(mkAdapter({ setTyping }));

    await emitAdkToolStatus('slack', 'U1', 'T1', 'acquire_biblio');
    // 1 回目 = 発火、2 回目は rate-limit ガードで skip
    await emitAdkToolStatus('slack', 'U1', 'T1', 'acquire_biblio');
    expect(setTyping).toHaveBeenCalledTimes(1);

    // clear すると次の同 tool 呼出しが再度発火する (= invocation 単位の解放契約)
    clearAdkTargetStatus('slack', 'U1', 'T1');
    await emitAdkToolStatus('slack', 'U1', 'T1', 'acquire_biblio');
    expect(setTyping).toHaveBeenCalledTimes(2);
  });

  it('clearing an unknown target is a no-op (never throws)', () => {
    expect(() => clearAdkTargetStatus('slack', 'unknown', null)).not.toThrow();
  });
});
