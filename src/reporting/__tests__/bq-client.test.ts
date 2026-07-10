/**
 * `bq-client.ts` のユニットテスト。
 *
 * カバレッジ:
 *  - runQuery は location: 'asia-northeast1' を BigQuery.query に必ず渡す
 *    (SDK デフォルト "US" 依存を排除する契約の regression 保護)
 *  - BQ query が reject したら握り潰さず rethrow する (silent failure 撲滅)
 *  - 成功時に reporting.bq_query_succeeded event を log.info で emit
 *  - client は singleton (2 回目以降 new BigQuery を呼ばない)
 *
 * bq-client.ts は catch を削除 (呼出側の safeRunQuery が log 集約) しているため、
 * ここでは「rethrow のみ、log なし」を assert。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logInfoMock, logErrorMock } = vi.hoisted(() => ({
  logInfoMock: vi.fn(),
  logErrorMock: vi.fn(),
}));

vi.mock('../../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: logInfoMock,
    warn: vi.fn(),
    error: logErrorMock,
    fatal: vi.fn(),
  },
}));

const queryMock = vi.fn();
const bigQueryCtorMock = vi.fn();

class MockBigQuery {
  query = queryMock;
  constructor(...args: unknown[]) {
    bigQueryCtorMock(...args);
  }
}

vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: MockBigQuery,
}));

// import は mock 定義後
const { runQuery } = await import('../bq-client.js');

beforeEach(() => {
  queryMock.mockReset();
  bigQueryCtorMock.mockClear();
  logInfoMock.mockReset();
  logErrorMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runQuery — location 明示 (asia-northeast1 固定)', () => {
  it('BigQuery.query に location: "asia-northeast1" を必ず渡す', async () => {
    queryMock.mockResolvedValueOnce([[{ a: 1 }]]);
    await runQuery('SELECT 1');
    expect(queryMock).toHaveBeenCalledWith(expect.objectContaining({ query: 'SELECT 1', location: 'asia-northeast1' }));
  });

  it('params を渡した場合も location は上書きされない', async () => {
    queryMock.mockResolvedValueOnce([[]]);
    await runQuery('SELECT @x AS x', { x: 1 });
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'SELECT @x AS x',
        location: 'asia-northeast1',
        params: { x: 1 },
      }),
    );
  });
});

describe('runQuery — success emit', () => {
  it('成功時に reporting.bq_query_succeeded を row_count 付きで log.info', async () => {
    queryMock.mockResolvedValueOnce([[{ a: 1 }, { a: 2 }, { a: 3 }]]);
    const rows = await runQuery('SELECT 1', undefined, { requestId: 'req-42' });
    expect(rows).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(logInfoMock).toHaveBeenCalledWith(
      'reporting.bq_query_succeeded',
      expect.objectContaining({
        outcome: 'success',
        request_id: 'req-42',
        row_count: 3,
      }),
    );
  });
});

describe('runQuery — 失敗時は log なし rethrow (呼出側集約契約)', () => {
  it('BQ query が reject したら握り潰さず throw (silent failure 撲滅)', async () => {
    queryMock.mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(runQuery('SELECT 1')).rejects.toThrow('quota exceeded');
  });

  it('失敗時に log.error は emit しない (呼出側 safeRunQuery が集約する契約)', async () => {
    queryMock.mockRejectedValueOnce(new Error('permission denied'));
    await expect(runQuery('SELECT 1')).rejects.toThrow();
    expect(logErrorMock).not.toHaveBeenCalled();
  });
});

describe('runQuery — client singleton', () => {
  it('複数回呼んでも BigQuery constructor は 1 回のみ (module-level cache)', async () => {
    queryMock.mockResolvedValue([[]]);
    await runQuery('SELECT 1');
    await runQuery('SELECT 2');
    await runQuery('SELECT 3');
    // 本 test 内で 1 回 + (他 test で cache が warm な可能性を吸収する = 少なくとも 1 回、超えない)
    expect(bigQueryCtorMock.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
