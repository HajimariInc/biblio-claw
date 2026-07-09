/**
 * scripts/reporting-cronjob.ts の pure fn を抽出した library module。
 *
 * scripts/*.ts は import 時に main() を実行するため、テストで import しようとすると
 * process.exit や external network 呼出まで走る。R5 (2026-07-09 review 反映) で pure 部分を
 * ここに切り出し、scripts/reporting-cronjob.ts は本 module から import する薄い entrypoint に。
 *
 * ここに置くもの:
 *   - validateReportingEnv (3 段 guard、discriminated union で返す pure fn)
 *   - safeRunQuery (QueryOutcome<T> を返す、log.error 集約点)
 *   - loadSql (SQL file 読込 + placeholder 置換)
 *   - REPORT_KINDS / DEFAULT_DATASET_ID / DEFAULT_WINDOW_DAYS 定数
 *
 * ここに置かないもの:
 *   - main() (entrypoint、process.exit / shutdownOtel を含む副作用経路)
 *   - Slack post / OTel init (entrypoint 側で組み合わせる)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runQuery } from './bq-client.js';
import { log } from '../log.js';
import type { QueryOutcome } from './formatter.js';

export const REPORT_KINDS = ['biblio-usage', 'inspect-distribution', 'error-trend', 'llm-cost'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const DEFAULT_DATASET_ID = 'llm_observability';
export const DEFAULT_WINDOW_DAYS = 7;

// pure fn: env validation。I3 修正で main() の 3 段 guard を抽出し unit test 可能にする。
// discriminated union で返す = throw しない契約 (silent failure 撲滅)。
export type ValidateReportingEnvResult =
  | {
      ok: true;
      projectId: string;
      datasetId: string;
      windowDays: number;
      channel: string;
    }
  | { ok: false; reason: 'no_project_id' | 'no_channel' | 'invalid_window'; raw?: string };

export function validateReportingEnv(env: NodeJS.ProcessEnv = process.env): ValidateReportingEnvResult {
  const projectId = env.GCP_PROJECT_ID;
  if (!projectId) return { ok: false, reason: 'no_project_id' };

  const channel = env.REPORTING_CHANNEL_ID || env.OWNER_SLACK_USER_ID;
  if (!channel) return { ok: false, reason: 'no_channel' };

  const rawWindow = env.REPORTING_WINDOW_DAYS ?? String(DEFAULT_WINDOW_DAYS);
  const windowDays = Number(rawWindow);
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    return { ok: false, reason: 'invalid_window', raw: rawWindow };
  }

  const datasetId = env.BQ_DATASET_ID ?? DEFAULT_DATASET_ID;
  return { ok: true, projectId, datasetId, windowDays, channel };
}

export function loadSql(kind: ReportKind, projectId: string, datasetId: string): string {
  // `src/reporting/cronjob-lib.ts` から見た SQL の相対位置 = `./sql/<kind>.sql`
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, 'sql', `${kind}.sql`);
  const raw = readFileSync(path, 'utf-8');
  return raw.replace(/<PROJECT_ID>/g, projectId).replace(/<DATASET_ID>/g, datasetId);
}

// R4 修正: safeRunQuery は QueryOutcome<T> を返し、SQL 失敗と真の empty を型で区別する。
// log 集約点: bq-client.ts は throw のみ、本関数が呼出側として severity error + err 詳細で emit。
// これで同一失敗が bq-client (error) + safeRunQuery (warn) の二重 log になる問題を撲滅
// (S6 統合、review 対応)。
export async function safeRunQuery<T = unknown>(
  kind: ReportKind,
  sql: string,
  params: Record<string, unknown>,
  requestId: string,
): Promise<QueryOutcome<T>> {
  try {
    const rows = await runQuery<T>(sql, params, { requestId });
    return { ok: true, rows };
  } catch (err) {
    log.error(`reporting.${kind}_failed`, {
      event: `reporting.${kind}_failed`,
      outcome: 'error',
      request_id: requestId,
      report_kind: kind,
      err,
    });
    return { ok: false };
  }
}
