/**
 * `action-helpers.ts` の `writeBackMessage` retry 経路ユニットテスト (PR #37 review-agents 提案 PT2)。
 *
 * 重要パスの保護:
 *  - 1 回目 SQLITE_BUSY → 2 回目に成功 → `log.error('patron notification lost')` は呼ばれない
 *  - 3 回全滅 → `log.error('patron notification lost')` が必ず呼ばれる (silent failure 防止)
 *
 * writeBackMessage は **絶対に throw しない** 契約 (= handler 側が catch しないため、
 * throw すると host を巻き込む)。本テストは throw しないことも同時に検証する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock の factory は import 前に hoist されるため、factory が値を直接参照する
// mock 関数 (= `error: logErrorMock` の形) は `vi.hoisted` で同時 hoist させる必要がある。
const { logErrorMock } = vi.hoisted(() => ({ logErrorMock: vi.fn() }));

const insertMessageMock = vi.fn();
vi.mock('../db/session-db.js', () => ({
  insertMessage: (db: unknown, msg: unknown) => insertMessageMock(db, msg),
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logErrorMock, fatal: vi.fn() },
}));

import { writeBackMessage } from './action-helpers.js';

const dummyDb: unknown = {};

beforeEach(() => {
  insertMessageMock.mockReset();
  logErrorMock.mockReset();
});

describe('writeBackMessage retry', () => {
  it('1 回目 SQLITE_BUSY で 2 回目に成功する (= patron notification lost は出さない)', async () => {
    insertMessageMock
      .mockImplementationOnce(() => {
        const err = new Error('SQLITE_BUSY');
        Object.assign(err, { code: 'SQLITE_BUSY' });
        throw err;
      })
      .mockImplementationOnce(() => {
        // 2 回目で成功
      });

    await writeBackMessage(dummyDb as never, 'hello', 'test-resp', 'test_action');

    expect(insertMessageMock).toHaveBeenCalledTimes(2);
    // 1 回目失敗の log.error (= attempt 詳細) は出るが、'patron notification lost' は出ない
    const lostCalls = logErrorMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('patron notification lost'),
    );
    expect(lostCalls).toHaveLength(0);
  });

  it('3 回全滅で log.error("patron notification lost") を必ず残す (silent failure 防止)', async () => {
    insertMessageMock.mockImplementation(() => {
      throw new Error('SQLITE_BUSY persistent');
    });

    await expect(writeBackMessage(dummyDb as never, 'hello', 'test-resp', 'test_action')).resolves.toBeUndefined(); // throw しないことを同時に検証

    // 1 回 + 2 retries = 3 attempts
    expect(insertMessageMock).toHaveBeenCalledTimes(3);
    const lostCalls = logErrorMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('patron notification lost'),
    );
    expect(lostCalls.length).toBeGreaterThan(0);
    // textPreview に本文の先頭が乗っていることも確認 (= デバッグ可能性)
    const lostCall = lostCalls.at(-1);
    expect(lostCall?.[1]).toMatchObject({ retries: 3, textPreview: expect.stringContaining('hello') });
  });
});
