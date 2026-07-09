import { BigQuery } from '@google-cloud/bigquery';
import { log } from '../log.js';

// biblio-claw の BQ dataset は asia-northeast1 に固定 (terraform/m4-a-observability/variables.tf:12-16 の region default)。
// QueryOptions.location のデフォルトは "US" のため明示指定必須 (不一致で "Dataset was not found" が返る)。
const BQ_LOCATION = 'asia-northeast1';

let cachedClient: BigQuery | null = null;

function getClient(): BigQuery {
  if (cachedClient) return cachedClient;
  cachedClient = new BigQuery({ projectId: process.env.GCP_PROJECT_ID });
  return cachedClient;
}

export interface RunQueryOptions {
  requestId?: string;
}

// generic BQ query wrapper。
// - ADC 経由 (GCP_PROJECT_ID env 必須、GOOGLE_APPLICATION_CREDENTIALS 不要)
// - location: 'asia-northeast1' を毎回明示 (SDK デフォルト "US" 依存を排除)
// - SDK が rate limit / backend error に対して指数バックオフで自動 retry (default 最大 3 回)。
//   CronJob 側で二重 retry ループを書かない (呼出側が silent multiplier を持たない契約)。
// - **失敗時は log を出さず throw のみ**。呼出側 (`safeRunQuery` in reporting-cronjob.ts) が
//   1 箇所で severity 判断 + err payload 込みで `log.error` 集約する契約 (R4 修正、二重 severity log 撲滅)。
export async function runQuery<T = Record<string, unknown>>(
  sql: string,
  params?: Record<string, unknown>,
  opts: RunQueryOptions = {},
): Promise<T[]> {
  const startAt = Date.now();
  const requestId = opts.requestId;
  const bigquery = getClient();
  const [rows] = await bigquery.query({
    query: sql,
    location: BQ_LOCATION,
    params,
  });
  log.info('reporting.bq_query_succeeded', {
    event: 'reporting.bq_query_succeeded',
    outcome: 'success',
    request_id: requestId,
    row_count: rows.length,
    duration_ms: Date.now() - startAt,
  });
  return rows as T[];
}
