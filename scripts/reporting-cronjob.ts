/**
 * M4-C Phase 1: 週次 reporting CronJob entrypoint。
 *
 * 起動:
 *   pnpm exec tsx --import ./src/instrumentation.ts scripts/reporting-cronjob.ts
 *
 * 実行フロー:
 *   1. env guard (`validateReportingEnv`) で必須 env を pre-flight 検証、欠落は fail-fast
 *   2. 4 種レポート SQL を並列実行 (biblio-usage / inspect-distribution / error-trend / llm-cost)
 *      - Phase 1 では biblio-usage と llm-cost が完成版、他 2 種は雛形 (empty)
 *      - 各 SQL の失敗は独立、他 SQL の実行を止めない (`safeRunQuery` が QueryOutcome で伝搬)
 *      - R4 修正: 空返し正規化を止め、`{ok:false}` で SQL 失敗と真の empty を区別
 *   3. formatBiblioUsageSummary で 1 つの Slack DM 本文に整形 (plain text、Phase 1 スコープ)
 *   4. postReport で Slack owner DM (REPORTING_CHANNEL_ID or OWNER_SLACK_USER_ID) に投稿
 *   5. shutdownOtel で BatchSpanProcessor flush 強制 (Cloud Trace 到達保証)
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
 *
 * pure fn 抽出:
 *   env guard / safeRunQuery / loadSql / 定数は `src/reporting/cronjob-lib.ts` に集約
 *   (I3 修正、review 対応で unit test 可能に)。
 */
import { randomUUID } from 'node:crypto';

import {
  REPORT_KINDS,
  loadSql,
  safeRunQuery,
  validateReportingEnv,
} from '../src/reporting/cronjob-lib.js';
import { postReport } from '../src/reporting/slack-post.js';
import { formatBiblioUsageSummary } from '../src/reporting/formatter.js';
import { shutdownOtel } from '../src/observability/index.js';
import { log } from '../src/log.js';

// C7 修正: shutdownOtel の失敗を silent 化せず log 化 (src/index.ts:308-312 pattern と統一)。
async function safeShutdownOtel(requestId: string): Promise<void> {
  try {
    await shutdownOtel();
  } catch (err) {
    log.warn('reporting.cronjob.otel_shutdown_failed', {
      event: 'reporting.cronjob.otel_shutdown_failed',
      outcome: 'error',
      request_id: requestId,
      err,
    });
  }
}

async function main(): Promise<void> {
  const requestId = randomUUID();
  const startAt = Date.now();

  const validation = validateReportingEnv();
  if (!validation.ok) {
    const eventName =
      validation.reason === 'no_project_id'
        ? 'reporting.cronjob.no_project_id'
        : validation.reason === 'no_channel'
          ? 'reporting.cronjob.no_channel'
          : 'reporting.cronjob.invalid_window';
    log.error(eventName, {
      event: eventName,
      outcome: 'error',
      request_id: requestId,
      error:
        validation.reason === 'no_project_id'
          ? 'GCP_PROJECT_ID env unset'
          : validation.reason === 'no_channel'
            ? 'REPORTING_CHANNEL_ID / OWNER_SLACK_USER_ID both unset'
            : 'REPORTING_WINDOW_DAYS is not a positive number',
      raw: validation.reason === 'invalid_window' ? validation.raw : undefined,
    });
    await safeShutdownOtel(requestId);
    process.exit(1);
  }

  const { projectId, datasetId, windowDays, channel } = validation;

  log.info('reporting.cronjob.started', {
    event: 'reporting.cronjob.started',
    outcome: 'success',
    request_id: requestId,
    window_days: windowDays,
    dataset_id: datasetId,
  });

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
    await safeShutdownOtel(requestId);
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
    await safeShutdownOtel(requestId);
    process.exit(1);
  }
}

main().catch(async (err) => {
  log.fatal('reporting.cronjob.fatal', {
    event: 'reporting.cronjob.fatal',
    outcome: 'error',
    err,
  });
  await safeShutdownOtel('fatal').catch(() => {
    // safeShutdownOtel 自体が throw することは通常ないが、二重防護
  });
  process.exit(1);
});
