/**
 * M4-F Phase 4: typing module の updateTypingStatus + currentStatus forward の unit test。
 *
 * refresh loop (4s tick + heartbeat) 本体の挙動は既存 code から無変更なので、Phase 4 で
 * 追加した status 関連の判定 (未起動 no-op / 初回 forward / 同値 no-op / null 遷移 /
 * 4s tick が currentStatus を forward) を集中的にカバーする。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { log } from '../../log.js';

import {
  pauseTypingRefreshAfterDelivery,
  setTypingAdapter,
  startTypingRefresh,
  stopTypingRefresh,
  updateTypingStatus,
} from './index.js';

interface Call {
  channelType: string;
  platformId: string;
  threadId: string | null;
  status: string | null | undefined;
}

let calls: Call[];

beforeEach(() => {
  calls = [];
  setTypingAdapter({
    setTyping: async (channelType, platformId, threadId, status) => {
      calls.push({ channelType, platformId, threadId, status });
    },
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  // 全 sessionId の refresh loop を掃除 (test 間で leak しないように)
  stopTypingRefresh('sess-1');
  stopTypingRefresh('sess-2');
});

describe('updateTypingStatus (M4-F Phase 4)', () => {
  it('is a no-op if no refresh is active for the session', () => {
    updateTypingStatus('nonexistent-session', 'Web 検索中');
    expect(calls.length).toBe(0);
  });

  it('immediately forwards status change on the first update', async () => {
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'U1', 'T1');
    // 初回 startTypingRefresh の immediate tick (status=null) を待つ
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    updateTypingStatus('sess-1', 'Web 検索中');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toMatchObject({
      channelType: 'slack',
      platformId: 'U1',
      threadId: 'T1',
      status: 'Web 検索中',
    });
  });

  it('is a no-op if status is unchanged (rate limit guard)', async () => {
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'U1', 'T1');
    updateTypingStatus('sess-1', 'Web 検索中');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    updateTypingStatus('sess-1', 'Web 検索中'); // 同値
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(0);
  });

  it('re-forwards on transition null -> non-null', async () => {
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'U1', 'T1');
    updateTypingStatus('sess-1', null);
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    updateTypingStatus('sess-1', 'ファイル参照中');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]?.status).toBe('ファイル参照中');
  });

  it('re-forwards on transition non-null -> null (作業終了 signal)', async () => {
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'U1', 'T1');
    updateTypingStatus('sess-1', 'Web 検索中');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    updateTypingStatus('sess-1', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // null -> undefined 正規化: vendor 側 default 文言 fallback
    expect(calls[0]?.status).toBeUndefined();
  });

  it('re-forwards on transition A -> B', async () => {
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'U1', 'T1');
    updateTypingStatus('sess-1', '分類中');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    updateTypingStatus('sess-1', '仕入れ中');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]?.status).toBe('仕入れ中');
  });

  it('per-session isolation: updating sess-1 does not touch sess-2', async () => {
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'U1', 'T1');
    startTypingRefresh('sess-2', 'ag-2', 'slack', 'U2', 'T2');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    updateTypingStatus('sess-1', 'Web 検索中');
    await vi.advanceTimersByTimeAsync(0);
    // sess-1 のみが発火 = sess-2 side effects なし
    expect(calls.every((c) => c.platformId === 'U1')).toBe(true);
  });
});

describe('refresh loop forwards currentStatus (M4-F Phase 4)', () => {
  it('immediate tick on startTypingRefresh uses status=null (vendor default) when initialStatus is omitted', async () => {
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'U1', 'T1');
    await vi.advanceTimersByTimeAsync(0);
    // 初回 immediate tick は currentStatus=null で発火 = vendor 側で undefined 相当 = default
    expect(calls[0]).toMatchObject({ status: undefined });
  });

  it('re-inbound while already refreshing preserves currentStatus (not reset to null)', async () => {
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'U1', 'T1');
    updateTypingStatus('sess-1', 'Web 検索中');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // 同じ sessionId で再 inbound = existing 分岐 → currentStatus を維持したまま refresh 再開
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'U1', 'T1');
    await vi.advanceTimersByTimeAsync(0);
    // 直近 status = 'Web 検索中' を forward していること
    expect(calls[0]?.status).toBe('Web 検索中');
  });
});

// PR #145 実機で発見: startTypingRefresh(null) + updateTypingStatus('container 起動中')
// の 2 発 fire-and-forget が Slack API 到達順で「Typing...」が後勝ちする経路あり。
// initialStatus 引数で immediate tick を最初から目的の status で発火することで race 撲滅。
describe('startTypingRefresh initialStatus (M4-F Phase 4 status race 解消)', () => {
  it('immediate tick uses initialStatus when provided (Slack race 撲滅)', async () => {
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'U1', 'T1', 'container 起動中');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]?.status).toBe('container 起動中');
  });

  it('initialStatus sets currentStatus so subsequent updateTypingStatus(same value) is no-op', async () => {
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'U1', 'T1', 'container 起動中');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;
    // 同値 update は rate limit ガードで no-op
    updateTypingStatus('sess-1', 'container 起動中');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(0);
  });

  it('initialStatus 経路後の updateTypingStatus は変化検知で発火する (tool 発火時の遷移)', async () => {
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'U1', 'T1', 'container 起動中');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;
    updateTypingStatus('sess-1', 'Web 検索中');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]?.status).toBe('Web 検索中');
  });

  it('initialStatus=null (default) は既存挙動 = vendor default', async () => {
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'U1', 'T1', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]?.status).toBeUndefined();
  });
});

// S2: 4 秒周期 tick が currentStatus を実発火で forward することを検証。
// 既存 case は advanceTimersByTimeAsync(0) のみで tick 側の triggerTyping (line 146) を
// 素通りしていた = PRD 中核契約「Slack 2 分自動クリア回避のため 4 秒毎の強制再送」の
// 実効検証が欠落していた。fake heartbeat 経路は必要なし = grace window (15s) 内で発火する。
describe('4s tick 実発火で currentStatus を強制再送 (M4-F Phase 4 中核契約)', () => {
  it('grace window 内は 4s tick 毎に currentStatus を forward', async () => {
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'U1', 'T1', 'container 起動中');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // 4s 進める = 1 周目 tick 発火 (grace 内なので heartbeat 不要)
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls.some((c) => c.status === 'container 起動中')).toBe(true);

    calls.length = 0;
    // さらに 4s = 2 周目 tick も同 status を再送
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls.some((c) => c.status === 'container 起動中')).toBe(true);
  });

  it('updateTypingStatus 後の 4s tick は新 status を forward', async () => {
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'U1', 'T1', 'container 起動中');
    await vi.advanceTimersByTimeAsync(0);
    updateTypingStatus('sess-1', 'Web 検索中');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    await vi.advanceTimersByTimeAsync(4000);
    // tick 発火は「Web 検索中」で forward される (currentStatus が新 status に更新済)
    expect(calls.some((c) => c.status === 'Web 検索中')).toBe(true);
    expect(calls.some((c) => c.status === 'container 起動中')).toBe(false);
  });
});

// PR #145 review pr-test-analyzer IM-7 対応: Wave 2 C2 で triggerTyping の empty
// catch を log.warn 化した「見える化」を検証する。setTyping adapter が throw する
// ときに構造化ログ (event: 'progress.status.set_typing_failed') が発火し、かつ
// throw が triggerTyping の外に伝播しない (best-effort 契約) ことを assert する。
describe('triggerTyping catch 見える化 (M4-F Phase 4 C2)', () => {
  beforeEach(() => {
    vi.mocked(log.warn).mockClear();
  });

  it('setTyping throw で log.warn を event 付きで発火し routing 継続 (best-effort)', async () => {
    setTypingAdapter({
      setTyping: async () => {
        throw new Error('rate limited (429)');
      },
    });
    // startTypingRefresh の immediate tick は throw を吸収する契約
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'U1', 'T1', 'container 起動中');
    await vi.advanceTimersByTimeAsync(0);

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('setTyping failed'),
      expect.objectContaining({
        event: 'progress.status.set_typing_failed',
        channel_type: 'slack',
      }),
    );
  });

  it('setTyping throw が updateTypingStatus の外に漏れない (best-effort、状態更新は成功)', async () => {
    setTypingAdapter({
      setTyping: async () => {
        throw new Error('boom');
      },
    });
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'U1', 'T1');
    await vi.advanceTimersByTimeAsync(0);

    // updateTypingStatus 自身は throw しない = 呼出元 (poller / router) の catch は
    // 不要 (だが .catch() は保険として残す設計)。同期呼出後の状態変更は成功する。
    expect(() => updateTypingStatus('sess-1', 'Web 検索中')).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    // 内部状態は更新されているため、同値 update は依然として no-op になる
    updateTypingStatus('sess-1', 'Web 検索中');
    // (assert: 内部状態が currentStatus='Web 検索中' に遷移したことは、pause 経路の
    //  test 側で間接的に確認する = ここでは throw not-thrown 契約のみ検証)
    expect(log.warn).toHaveBeenCalled();
  });
});

// PR #145 review code-reviewer IM-2 対応: updateTypingStatus が pausedUntil を
// 尊重するように修正した race fix を検証。post-delivery pause 中に status 変化が
// 起きても即発火せず、状態のみ更新して次 pause 明け tick が forward する。
describe('updateTypingStatus pausedUntil 尊重 (M4-F Phase 4 IM-2)', () => {
  it('pause 中の status 変化は即発火しない (状態は更新される)', async () => {
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'U1', 'T1', 'container 起動中');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // pause 開始 (10 秒間 pausedUntil 有効)
    pauseTypingRefreshAfterDelivery('sess-1');

    // pause 中に status 変化 → 即発火は skip されるはず
    updateTypingStatus('sess-1', 'Web 検索中');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(0);
  });

  it('pause 明け後の 4s tick は更新済 status を forward する', async () => {
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'U1', 'T1', 'container 起動中');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    pauseTypingRefreshAfterDelivery('sess-1');
    updateTypingStatus('sess-1', 'Web 検索中');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(0); // pause 中は skip

    // pause (10 秒) を過ぎた後の 4s tick まで進める (~12s = 3 周目 tick、grace 15s 内なので
    // isHeartbeatFresh 不要で発火する)
    await vi.advanceTimersByTimeAsync(12_000);
    // pause 明け tick が新 status を forward していること
    expect(calls.some((c) => c.status === 'Web 検索中')).toBe(true);
  });

  it('pause 外 (通常時) は変化検知で即発火する (regression: IM-2 fix が過剰 skip しない)', async () => {
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'U1', 'T1', 'container 起動中');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // pause しないで status 変化 = 即発火する契約は不変 (rate-limit ガードは同値時のみ)
    updateTypingStatus('sess-1', 'Web 検索中');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.some((c) => c.status === 'Web 検索中')).toBe(true);
  });
});
