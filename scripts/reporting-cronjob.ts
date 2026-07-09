/**
 * M4-C Phase 1: 週次 reporting CronJob entrypoint。
 *
 * 起動:
 *   pnpm exec tsx --import ./src/instrumentation.ts scripts/reporting-cronjob.ts
 *
 * 実行フロー:
 *   1. 4 種レポート SQL を並列実行 (biblio-usage / inspect-distribution / error-trend / llm-cost)
 *      - Phase 1 では biblio-usage と llm-cost が完成版、他 2 種は雛形 (empty)
 *      - 各 SQL の失敗は独立、他 SQL の実行を止めない (`.catch(() => [])` で空返し正規化)
 *   2. formatBiblioUsageSummary で 1 つの Slack DM 本文に整形 (plain text、Phase 1 スコープ)
 *   3. postReport で Slack owner DM (REPORTING_CHANNEL_ID or OWNER_SLACK_USER_ID) に投稿
 *   4. shutdownOtel で BatchSpanProcessor flush 強制 (Cloud Trace 到達保証)
 *
 * 環境変数:
 *   GCP_PROJECT_ID          BigQuery projectId (SQL <PROJECT_ID> placeholder に置換)
 *   BQ_DATASET_ID           BQ dataset 名 (SQL <DATASET_ID> placeholder、default "llm_observability")
 *   REPORTING_WINDOW_DAYS   集計対象日数 (default 7)
 *   REPORTING_CHANNEL_ID    投稿先 channel/user ID (default = OWNER_SLACK_USER_ID)
 *   OWNER_SLACK_USER_ID     patron (owner) の Slack user ID (`U...`)、REPORTING_CHANNEL_ID 未設定時の fallback
 *   SLACK_BOT_TOKEN         Slack Bot token (biblio-slack-tokens Secret 経由)
 *
 * OneCLI proxy 非経由:
 *   CronJob Pod は orchestrator 相当の host 権限で BQ / Slack に直接到達する (agent container の
 *   OneCLI 経由 MCP tool 経路とは別トポロジ)。initHostProxy は呼出不要。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { runQuery } from '../src/reporting/bq-client.js';
import { postReport } from '../src/reporting/slack-post.js';
import { formatBiblioUsageSummary } from '../src/reporting/formatter.js';
import { shutdownOtel } from '../src/observability/index.js';
import { log } from '../src/log.js';

const REPORT_KINDS = ['biblio-usage', 'inspect-distribution', 'error-trend', 'llm-cost'] as const;
type ReportKind = (typeof REPORT_KINDS)[number];

const DEFAULT_DATASET_ID = 'llm_observability';
const DEFAULT_WINDOW_DAYS = 7;

function loadSql(kind: ReportKind, projectId: string, datasetId: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, '..', 'src', 'reporting', 'sql', `${kind}.sql`);
  const raw = readFileSync(path, 'utf-8');
  return raw.replace(/<PROJECT_ID>/g, projectId).replace(/<DATASET_ID>/g, datasetId);
}

async function safeRunQuery(
  kind: ReportKind,
  sql: string,
  params: Record<string, unknown>,
  requestId: string,
): Promise<unknown[]> {
  try {
    return await runQuery(sql, params, { requestId });
  } catch (err) {
    log.warn(`reporting.${kind}_failed`, {
      event: `reporting.${kind}_failed`,
      outcome: 'error',
      request_id: requestId,
      report_kind: kind,
      err,
    });
    return [];
  }
}

async function main(): Promise<void> {
  const requestId = randomUUID();
  const startAt = Date.now();
  const projectId = process.env.GCP_PROJECT_ID;
  const datasetId = process.env.BQ_DATASET_ID ?? DEFAULT_DATASET_ID;
  const windowDays = Number(process.env.REPORTING_WINDOW_DAYS ?? DEFAULT_WINDOW_DAYS);
  const channel = process.env.REPORTING_CHANNEL_ID || process.env.OWNER_SLACK_USER_ID;

  log.info('reporting.cronjob.started', {
    event: 'reporting.cronjob.started',
    outcome: 'success',
    request_id: requestId,
    window_days: windowDays,
    dataset_id: datasetId,
  });

  if (!projectId) {
    log.error('reporting.cronjob.no_project_id', {
      event: 'reporting.cronjob.no_project_id',
      outcome: 'error',
      request_id: requestId,
      error: 'GCP_PROJECT_ID env unset',
    });
    await shutdownOtel().catch(() => {});
    process.exit(1);
  }

  if (!channel) {
    log.error('reporting.cronjob.no_channel', {
      event: 'reporting.cronjob.no_channel',
      outcome: 'error',
      request_id: requestId,
      error: 'REPORTING_CHANNEL_ID / OWNER_SLACK_USER_ID both unset',
    });
    await shutdownOtel().catch(() => {});
    process.exit(1);
  }

  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    log.error('reporting.cronjob.invalid_window', {
      event: 'reporting.cronjob.invalid_window',
      outcome: 'error',
      request_id: requestId,
      raw: process.env.REPORTING_WINDOW_DAYS,
    });
    await shutdownOtel().catch(() => {});
    process.exit(1);
  }

  const params = { window_days: windowDays };
  const [biblio, inspect, errorTrend, llmCost] = await Promise.all(
    REPORT_KINDS.map((kind) =>
      safeRunQuery(kind, loadSql(kind, projectId, datasetId), params, requestId),
    ),
  );

  const text = formatBiblioUsageSummary({ windowDays, biblio, inspect, errorTrend, llmCost });
  const result = await postReport({ channel, text, requestId });

  const durationMs = Date.now() - startAt;
  if (result.ok) {
    log.info('reporting.cronjob.completed', {
      event: 'reporting.cronjob.completed',
      outcome: 'success',
      request_id: requestId,
      duration_ms: durationMs,
      slack_ts: result.ts,
      retried: result.retried,
    });
    await shutdownOtel();
    process.exit(0);
  } else {
    log.error('reporting.cronjob.failed', {
      event: 'reporting.cronjob.failed',
      outcome: 'error',
      request_id: requestId,
      duration_ms: durationMs,
      error: result.error,
      status: result.status,
    });
    await shutdownOtel();
    process.exit(1);
  }
}

main().catch(async (err) => {
  log.fatal('reporting.cronjob.fatal', {
    event: 'reporting.cronjob.fatal',
    outcome: 'error',
    err,
  });
  await shutdownOtel().catch(() => {});
  process.exit(1);
});
