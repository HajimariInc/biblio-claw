/**
 * M4-C 週次 reporting CronJob entrypoint (Phase 1+2 集約完了状態)。
 *
 * 起動:
 *   pnpm exec tsx --import ./src/instrumentation.ts scripts/reporting-cronjob.ts
 *
 * 実行フロー:
 *   1. env guard (`validateReportingEnv`) で必須 env を pre-flight 検証、欠落は fail-fast
 *   2. 4 種レポート SQL を並列実行 (biblio-usage / inspect-distribution / error-trend / llm-cost)
 *      - 4 種全て完成版 SQL (Phase 2 で inspect-distribution / error-trend も雛形から実装済)
 *      - 各 SQL の失敗は独立、他 SQL の実行を止めない (`safeRunQuery` が QueryOutcome で伝搬)
 *      - 空返し正規化を止め、`{ok:false}` で SQL 失敗と真の empty を区別
 *   3. formatBiblioUsageSummary で `{text, blocks}` の 2 shape を生成 (Phase 2 で Data Table Block 化)
 *   4. postReport で Slack owner DM (REPORTING_CHANNEL_ID) に text + blocks 両方投稿
 *   5. shutdownOtel で BatchSpanProcessor flush 強制 (Cloud Trace 到達保証)
 *
 * 環境変数:
 *   GCP_PROJECT_ID          BigQuery projectId (SQL <PROJECT_ID> placeholder に置換)
 *   BQ_DATASET_ID           BQ dataset 名 (SQL <DATASET_ID> placeholder、default "llm_observability")
 *   REPORTING_WINDOW_DAYS   集計対象日数 (default 7)
 *   REPORTING_CHANNEL_ID    投稿先 channel/user/DM channel ID (`C...` / `U...` / `D...`)。
 *                           Prod は DM channel ID (`D...`) 直接指定 (user ID 経由の auto DM
 *                           open は Slack bot scope 依存で `channel_not_found` を返すため)。
 *   OWNER_SLACK_USER_ID     patron (owner) の Slack user ID (`U...`)、REPORTING_CHANNEL_ID 未設定時の fallback
 *   CLOUD_ML_REGION         Vertex 呼出 region 表示 (`resolveVertexPremium()` の分岐 key、
 *                           Prod は `global` 明示 = premium 1.0、未設定 fallback は 1.10 で
 *                           cost 過大計上リスク = k8s manifest env で必ず明示する)
 *   SLACK_BOT_TOKEN         Slack Bot token (biblio-slack-tokens Secret 経由)
 *
 * OneCLI proxy 非経由:
 *   CronJob Pod は orchestrator 相当の host 権限で BQ / Slack に直接到達する (agent container の
 *   OneCLI 経由 MCP tool 経路とは別トポロジ)。initHostProxy は呼出不要。
 *
 * pure fn 抽出:
 *   env guard / safeRunQuery / loadSql / 定数は `src/reporting/cronjob-lib.ts` に集約
 *   (main() の 3 段 guard を pure fn に抽出し unit test 可能に)。
 */
import { randomUUID } from 'node:crypto';

import {
  REPORT_KINDS,
  loadSql,
  reasonToEventName,
  safeRunQuery,
  validateReportingEnv,
} from '../src/reporting/cronjob-lib.js';
import { postReport } from '../src/reporting/slack-post.js';
import { formatBiblioUsageSummary } from '../src/reporting/formatter.js';
import { shutdownOtel } from '../src/observability/index.js';
import { log } from '../src/log.js';

// shutdownOtel の失敗を silent 化せず log 化 (src/index.ts:308-312 pattern と統一)。
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
    // reason → event 名の写像は pure fn (cronjob-lib.ts:reasonToEventName) に切り出し、
    // 新 reason 追加時に exhaustive switch の never アサーションで compile 検知する。
    const eventName = reasonToEventName(validation.reason);
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

  const { text, blocks } = formatBiblioUsageSummary({ windowDays, biblio, inspect, errorTrend, llmCost });
  const result = await postReport({ channel, text, blocks, requestId });

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
  await safeShutdownOtel('fatal').catch((shutdownErr: unknown) => {
    // 空 catch は biblio-claw 全域で禁止 (silent failure 撲滅原則)。log 系自体が
    // 壊れている可能性を考慮し console.error で最終防衛。
    console.error(
      'reporting.cronjob.fatal: safeShutdownOtel unexpectedly rejected',
      shutdownErr,
    );
  });
  process.exit(1);
});
