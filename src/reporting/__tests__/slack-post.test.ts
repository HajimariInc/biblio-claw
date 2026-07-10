/**
 * `slack-post.ts` のユニットテスト。
 *
 * カバレッジ:
 *  - 200 成功 → { ok: true, ts, retried: false } + reporting.slack_post_succeeded emit
 *  - SLACK_BOT_TOKEN 未設定 → { ok: false, error: 'SLACK_BOT_TOKEN unset' } + error emit
 *  - 429 → 1 回 retry で 200 成功 → { ok: true, retried: true } + rate_limited warn emit
 *  - 429 → 2 回目も 429 (失敗) → { ok: false, status: 429 } + error emit
 *  - 500 単発失敗 → { ok: false, status: 500 } + error emit
 *
 * fake timers を使って 30s backoff を advance する (実 sleep を待たない)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logInfoMock, logWarnMock, logErrorMock } = vi.hoisted(() => ({
  logInfoMock: vi.fn(),
  logWarnMock: vi.fn(),
  logErrorMock: vi.fn(),
}));

vi.mock('../../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: logInfoMock,
    warn: logWarnMock,
    error: logErrorMock,
    fatal: vi.fn(),
  },
}));

const postSlackMessageMock = vi.fn();

// SlackApiError を factory 内で直接 declare するため、vi.hoisted で共有せず factory 内定義。
vi.mock('@chat-adapter/slack/api', () => {
  class SlackApiError extends Error {
    method: string;
    status?: number;
    response?: unknown;
    constructor(message: string, options: { method: string; status?: number; response?: unknown }) {
      super(message);
      this.name = 'SlackApiError';
      this.method = options.method;
      this.status = options.status;
      this.response = options.response;
    }
  }
  return {
    postSlackMessage: (opts: unknown) => postSlackMessageMock(opts),
    SlackApiError,
  };
});

import { postReport } from '../slack-post.js';
import { SlackApiError } from '@chat-adapter/slack/api';

beforeEach(() => {
  postSlackMessageMock.mockReset();
  logInfoMock.mockReset();
  logWarnMock.mockReset();
  logErrorMock.mockReset();
  process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.SLACK_BOT_TOKEN;
});

describe('postReport — 200 成功', () => {
  it('postSlackMessage が成功したら ok: true, retried: false を返す', async () => {
    postSlackMessageMock.mockResolvedValueOnce({ id: '1234.5678', raw: {} });
    const result = await postReport({ channel: 'U123', text: 'hello', blocks: [] });
    expect(result).toEqual({ ok: true, ts: '1234.5678', retried: false });
    expect(postSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(logInfoMock).toHaveBeenCalledWith(
      'reporting.slack_post_succeeded',
      expect.objectContaining({ outcome: 'success', retried: false }),
    );
  });

  it('botToken 明示指定は env より優先される (DI)', async () => {
    postSlackMessageMock.mockResolvedValueOnce({ id: '9.0', raw: {} });
    await postReport({ channel: 'U123', text: 'hi', botToken: 'xoxb-explicit', blocks: [] });
    expect(postSlackMessageMock).toHaveBeenCalledWith(expect.objectContaining({ token: 'xoxb-explicit' }));
  });
});

describe('postReport — SLACK_BOT_TOKEN 未設定', () => {
  it('token 不在なら postSlackMessage を呼ばず ok: false を返す (network 節約)', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const result = await postReport({ channel: 'U123', text: 'hello', blocks: [] });
    expect(result).toEqual({ ok: false, error: 'SLACK_BOT_TOKEN unset' });
    expect(postSlackMessageMock).not.toHaveBeenCalled();
    expect(logErrorMock).toHaveBeenCalledWith(
      'reporting.slack_post_failed',
      expect.objectContaining({ outcome: 'error', error: 'SLACK_BOT_TOKEN unset' }),
    );
  });
});

describe('postReport — 429 rate limit', () => {
  it('1 回目 429 → 30s backoff → 2 回目 200 で ok: true, retried: true', async () => {
    vi.useFakeTimers();
    postSlackMessageMock
      .mockRejectedValueOnce(new SlackApiError('rate limited', { method: 'chat.postMessage', status: 429 }))
      .mockResolvedValueOnce({ id: '5.6', raw: {} });

    const promise = postReport({ channel: 'U123', text: 'hi', blocks: [] });
    // sleep 30s を advance
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await promise;

    expect(result).toEqual({ ok: true, ts: '5.6', retried: true });
    expect(postSlackMessageMock).toHaveBeenCalledTimes(2);
    expect(logWarnMock).toHaveBeenCalledWith(
      'reporting.slack_post_rate_limited',
      expect.objectContaining({ outcome: 'retry', backoff_ms: 30_000 }),
    );
    expect(logInfoMock).toHaveBeenCalledWith(
      'reporting.slack_post_succeeded',
      expect.objectContaining({ retried: true }),
    );
  });

  it('1 回目 429 → 30s backoff → 2 回目も 429 で ok: false, status: 429', async () => {
    vi.useFakeTimers();
    postSlackMessageMock
      .mockRejectedValueOnce(new SlackApiError('rate limited 1', { method: 'chat.postMessage', status: 429 }))
      .mockRejectedValueOnce(new SlackApiError('rate limited 2', { method: 'chat.postMessage', status: 429 }));

    const promise = postReport({ channel: 'U123', text: 'hi', blocks: [] });
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await promise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
    }
    expect(postSlackMessageMock).toHaveBeenCalledTimes(2);
    expect(logErrorMock).toHaveBeenCalledWith(
      'reporting.slack_post_failed',
      expect.objectContaining({ outcome: 'error', status: 429, retried: true }),
    );
  });
});

describe('postReport — 429 以外の失敗', () => {
  it('500 は retry せず単発で ok: false, status: 500 を返す', async () => {
    postSlackMessageMock.mockRejectedValueOnce(
      new SlackApiError('server error', { method: 'chat.postMessage', status: 500 }),
    );
    const result = await postReport({ channel: 'U123', text: 'hi', blocks: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
    }
    expect(postSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock).toHaveBeenCalledWith(
      'reporting.slack_post_failed',
      expect.objectContaining({ outcome: 'error', status: 500, retried: false }),
    );
  });

  it('SlackApiError 以外の Error (network fail 等) も ok: false で返す (throw しない)', async () => {
    postSlackMessageMock.mockRejectedValueOnce(new Error('network unreachable'));
    const result = await postReport({ channel: 'U123', text: 'hi', blocks: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('network unreachable');
      expect(result.status).toBeUndefined();
    }
  });

  it('SlackApiError で status:undefined (HTTP 200 + ok:false = channel_not_found 等) は 1 回で failure', async () => {
    // 実運用で最も起こりやすい失敗 (OWNER_SLACK_USER_ID の typo、bot が DM/channel 未招待)。
    // @chat-adapter/slack@4.30.0 の assertSlackOk は HTTP 200 でも body が {ok:false, error:'channel_not_found'} 等
    // の場合に SlackApiError を投げるが、その場合 status は undefined (HTTP エラーではなく Slack API 内部エラー)。
    // 429 判定は `err.status === 429` = `undefined === 429` で false になり、無限 retry loop に落ちないこと。
    postSlackMessageMock.mockRejectedValueOnce(
      new SlackApiError('Slack chat.postMessage failed: channel_not_found', { method: 'chat.postMessage' }), // status 省略
    );
    const result = await postReport({ channel: 'U_TYPO', text: 'hi', blocks: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBeUndefined();
      expect(result.error).toContain('channel_not_found');
    }
    expect(postSlackMessageMock).toHaveBeenCalledTimes(1); // retry していない
    expect(logErrorMock).toHaveBeenCalledWith(
      'reporting.slack_post_failed',
      expect.objectContaining({ outcome: 'error', status: undefined, retried: false }),
    );
  });
});
