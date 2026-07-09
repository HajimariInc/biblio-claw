/**
 * `scripts/reporting-cronjob.ts` から export された pure fn のユニットテスト
 * (I3 修正、review 対応で新設)。
 *
 * カバレッジ:
 *  - `validateReportingEnv`: 3 段 guard の順序 (project_id → channel → window) が
 *    invalid 検出時に discriminated union で正しい reason を返すこと
 *  - `safeRunQuery`: SQL 失敗時に QueryOutcome<false> + log.error 集約 (二重 log 撲滅)
 *  - `safeRunQuery`: 成功時に QueryOutcome<true> で rows 伝搬
 *
 * 対象は entrypoint の副作用 (process.exit / shutdownOtel) を含まない pure fn のみ。
 * main() の統合テストは Task 12 (Prod 手動 trigger、HITL) に委譲。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { logErrorMock } = vi.hoisted(() => ({
  logErrorMock: vi.fn(),
}));

vi.mock('../../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: logErrorMock,
    fatal: vi.fn(),
  },
}));

// bq-client を mock、cronjob-lib からの import 経路を差し込む
const runQueryMock = vi.fn();
vi.mock('../bq-client.js', () => ({
  runQuery: (sql: unknown, params?: unknown, opts?: unknown) => runQueryMock(sql, params, opts),
}));

// cronjob-lib は pure fn 集約 module (R5 で scripts/reporting-cronjob.ts から抽出)
const { safeRunQuery, validateReportingEnv, DEFAULT_DATASET_ID, DEFAULT_WINDOW_DAYS } =
  await import('../cronjob-lib.js');

beforeEach(() => {
  runQueryMock.mockReset();
  logErrorMock.mockReset();
});

describe('validateReportingEnv — 3 段 guard 順序', () => {
  it('GCP_PROJECT_ID 未設定 → no_project_id (channel/window より先に検出)', () => {
    const result = validateReportingEnv({}); // 全 env 未設定
    expect(result).toEqual({ ok: false, reason: 'no_project_id' });
  });

  it('GCP_PROJECT_ID あり + channel 未設定 → no_channel', () => {
    const result = validateReportingEnv({ GCP_PROJECT_ID: 'p1' });
    expect(result).toEqual({ ok: false, reason: 'no_channel' });
  });

  it('OWNER_SLACK_USER_ID があれば channel 判定通過', () => {
    const result = validateReportingEnv({ GCP_PROJECT_ID: 'p1', OWNER_SLACK_USER_ID: 'U1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.channel).toBe('U1');
      expect(result.windowDays).toBe(DEFAULT_WINDOW_DAYS);
      expect(result.datasetId).toBe(DEFAULT_DATASET_ID);
    }
  });

  it('REPORTING_CHANNEL_ID は OWNER_SLACK_USER_ID より優先される', () => {
    const result = validateReportingEnv({
      GCP_PROJECT_ID: 'p1',
      REPORTING_CHANNEL_ID: 'C_CHANNEL',
      OWNER_SLACK_USER_ID: 'U_FALLBACK',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.channel).toBe('C_CHANNEL');
  });

  it('REPORTING_WINDOW_DAYS が非数値 → invalid_window (raw 保持)', () => {
    const result = validateReportingEnv({
      GCP_PROJECT_ID: 'p1',
      OWNER_SLACK_USER_ID: 'U1',
      REPORTING_WINDOW_DAYS: 'not-a-number',
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_window', raw: 'not-a-number' });
  });

  it('REPORTING_WINDOW_DAYS が 0 → invalid_window', () => {
    const result = validateReportingEnv({
      GCP_PROJECT_ID: 'p1',
      OWNER_SLACK_USER_ID: 'U1',
      REPORTING_WINDOW_DAYS: '0',
    });
    expect(result.ok).toBe(false);
  });

  it('REPORTING_WINDOW_DAYS が負数 → invalid_window', () => {
    const result = validateReportingEnv({
      GCP_PROJECT_ID: 'p1',
      OWNER_SLACK_USER_ID: 'U1',
      REPORTING_WINDOW_DAYS: '-7',
    });
    expect(result.ok).toBe(false);
  });

  it('BQ_DATASET_ID 明示指定は default を上書き', () => {
    const result = validateReportingEnv({
      GCP_PROJECT_ID: 'p1',
      OWNER_SLACK_USER_ID: 'U1',
      BQ_DATASET_ID: 'custom_dataset',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.datasetId).toBe('custom_dataset');
  });
});

describe('safeRunQuery — QueryOutcome discriminated union', () => {
  it('成功時は {ok: true, rows} を返す', async () => {
    runQueryMock.mockResolvedValueOnce([{ a: 1 }, { a: 2 }]);
    const outcome = await safeRunQuery('biblio-usage', 'SELECT 1', {}, 'req-1');
    expect(outcome).toEqual({ ok: true, rows: [{ a: 1 }, { a: 2 }] });
  });

  it('失敗時は {ok: false} を返し、log.error を kind 別 event 名で 1 回発火', async () => {
    runQueryMock.mockRejectedValueOnce(new Error('boom'));
    const outcome = await safeRunQuery('biblio-usage', 'SELECT 1', {}, 'req-2');
    expect(outcome).toEqual({ ok: false });
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock).toHaveBeenCalledWith(
      'reporting.biblio-usage_failed',
      expect.objectContaining({ outcome: 'error', request_id: 'req-2', report_kind: 'biblio-usage' }),
    );
  });

  it('1 kind の失敗は他 kind の実行を止めない (Promise.all 用途)', async () => {
    runQueryMock
      .mockRejectedValueOnce(new Error('boom')) // biblio-usage
      .mockResolvedValueOnce([{ x: 1 }]) // inspect
      .mockResolvedValueOnce([]) // error-trend (empty)
      .mockResolvedValueOnce([{ y: 1 }]); // llm-cost

    const results = await Promise.all([
      safeRunQuery('biblio-usage', 'SQL', {}, 'r1'),
      safeRunQuery('inspect-distribution', 'SQL', {}, 'r1'),
      safeRunQuery('error-trend', 'SQL', {}, 'r1'),
      safeRunQuery('llm-cost', 'SQL', {}, 'r1'),
    ]);
    expect(results[0]).toEqual({ ok: false });
    expect(results[1]).toEqual({ ok: true, rows: [{ x: 1 }] });
    expect(results[2]).toEqual({ ok: true, rows: [] });
    expect(results[3]).toEqual({ ok: true, rows: [{ y: 1 }] });
  });
});
