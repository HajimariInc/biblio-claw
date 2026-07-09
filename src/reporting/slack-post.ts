import { postSlackMessage, SlackApiError } from '@chat-adapter/slack/api';
import { log } from '../log.js';

// @chat-adapter/slack@4.30.0 の SlackApiError は HTTP status を持つが、Retry-After header は
// SlackApiError に露出しない (adapter が Response headers を payload に落とさない実装)。
// 週次 1 通で実害ないため、固定 backoff 30s の 1 回 retry を実装 (silent failure 撲滅の
// 明示コード = ラッパを持たない状態と比較して「rate limit 到達を検知した」情報を event emit で残す)。
const RATE_LIMIT_BACKOFF_MS = 30_000;

export interface PostReportOptions {
  channel: string;
  text: string;
  blocks?: unknown[];
  requestId?: string;
  // 明示指定用 (test 経路の DI)、default は process.env.SLACK_BOT_TOKEN
  botToken?: string;
}

export type PostReportResult =
  { ok: true; ts: string; retried: boolean } | { ok: false; error: string; status?: number };

export async function postReport(opts: PostReportOptions): Promise<PostReportResult> {
  const token = opts.botToken ?? process.env.SLACK_BOT_TOKEN;
  if (!token) {
    const error = 'SLACK_BOT_TOKEN unset';
    log.error('reporting.slack_post_failed', {
      event: 'reporting.slack_post_failed',
      outcome: 'error',
      request_id: opts.requestId,
      error,
    });
    return { ok: false, error };
  }
  let retried = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const posted = await postSlackMessage({
        token,
        channel: opts.channel,
        text: opts.text,
        blocks: opts.blocks,
      });
      log.info('reporting.slack_post_succeeded', {
        event: 'reporting.slack_post_succeeded',
        outcome: 'success',
        request_id: opts.requestId,
        retried,
      });
      return { ok: true, ts: posted.id, retried };
    } catch (err) {
      if (err instanceof SlackApiError && err.status === 429 && attempt === 1) {
        log.warn('reporting.slack_post_rate_limited', {
          event: 'reporting.slack_post_rate_limited',
          outcome: 'retry',
          request_id: opts.requestId,
          backoff_ms: RATE_LIMIT_BACKOFF_MS,
        });
        retried = true;
        await sleep(RATE_LIMIT_BACKOFF_MS);
        continue;
      }
      const error = err instanceof Error ? err.message : String(err);
      const status = err instanceof SlackApiError ? err.status : undefined;
      log.error('reporting.slack_post_failed', {
        event: 'reporting.slack_post_failed',
        outcome: 'error',
        request_id: opts.requestId,
        error,
        status,
        retried,
      });
      return { ok: false, error, status };
    }
  }
  // 到達不能な defensive fallback (for ループ内で全経路 return するため、現状の retry policy では
  // ここに到達しない)。将来 retry 回数 or 分岐が変更されて到達可能になった際に silent failure
  // 化しないよう、log.error を必ず出す (S4 修正、silent-failure-hunter 指摘)。
  log.error('reporting.slack_post_failed', {
    event: 'reporting.slack_post_failed',
    outcome: 'error',
    request_id: opts.requestId,
    error: 'exhausted retries (unreachable in current retry policy, defensive fallback)',
    retried,
  });
  return { ok: false, error: 'exhausted retries' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
