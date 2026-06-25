/**
 * `action-helpers.ts` のユニットテスト。
 *
 * 2 系統のカバレッジを 1 ファイルに併設:
 *
 *  - **BIBLIO_NAME_RE** (= Phase 4 で 3 要素対応に拡張、regression 固定)
 *    関数本体 (writeBackMessage / safeNotify / validateBiblioInput) のカバレッジは
 *    4 つの action handler test (= shelve / categorize / enkin / shokyaku) で網羅済みのため、
 *    本ブロックは regex の入出力に集中する。
 *
 *  - **writeBackMessage retry 経路** (PR #37 review-agents 提案 PT2、silent failure 防止)
 *    1 回目 SQLITE_BUSY → 2 回目に成功 → `log.error('patron notification lost')` は呼ばれない
 *    3 回全滅 → `log.error('patron notification lost')` が必ず呼ばれる
 *    writeBackMessage は **絶対に throw しない** 契約 (= handler 側が catch しないため、
 *    throw すると host を巻き込む)。本テストは throw しないことも同時に検証する。
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

import { BIBLIO_NAME_RE, writeBackMessage } from './action-helpers.js';

const dummyDb: unknown = {};

beforeEach(() => {
  insertMessageMock.mockReset();
  logErrorMock.mockReset();
});

describe('BIBLIO_NAME_RE', () => {
  describe('2 要素 (M2 全体仕入れ経路) — 受理', () => {
    it.each([
      ['owner--repo'],
      ['HajimariInc--biblio-shelf'],
      ['anthropics--claude-code-skills'],
      ['a1--b2'],
      ['Vendor.Name--my_repo'],
      ['x-y--p_q.r'],
    ])('"%s" を受理する', (input) => {
      expect(BIBLIO_NAME_RE.test(input)).toBe(true);
    });
  });

  describe('3 要素 (Phase 3 individual-acquire 経路) — 受理', () => {
    it.each([
      ['owner--repo--skill'],
      ['anthropics--claude-code-skills--fire-marker'],
      ['HajimariInc--biblio-shelf--biblio-dev'],
      ['a1--b2--c3'],
      ['owner--repo--skill-with-dashes'],
      ['owner--repo--skill_underscores'],
      ['owner--repo--skill.dotted'],
    ])('"%s" を受理する', (input) => {
      expect(BIBLIO_NAME_RE.test(input)).toBe(true);
    });
  });

  describe('境界値 — 設計上 受理される (greedy matching の既知挙動を意図的に固定)', () => {
    // 文字クラス `[A-Za-z0-9._-]*` が `-` を含むため `--` が segment 内に紛れ込んでも受理される。
    // これは「先頭英数字 + 区切り存在 + path traversal 防御」の最小限制約として運用上問題に
    // ならない (= GitHub repo 名にこれらの形は出ない)。将来 regex を厳格化したとき
    // silent regression にならないよう、受理される境界を test として固定する。
    it.each([
      ['owner---repo'], // 3 連続ハイフン (= owner + "-repo" の組合せでマッチ)
      ['owner--repo--'], // 末尾セパレータ (= owner + repo + "" の 3 要素として受理)
      ['owner--repo--skill--extra'], // 4 要素以上 (= 3 要素まで定義だが greedy で受理、extractOwnerRepo で先頭 2 のみに丸める)
    ])('"%s" を受理する (= greedy 既知挙動、Phase 4 前から)', (input) => {
      expect(BIBLIO_NAME_RE.test(input)).toBe(true);
    });
  });

  describe('不正形式 — 拒否', () => {
    it.each([
      [''],
      ['short-name'], // セパレータなし
      ['owner-repo'], // 1 ハイフン (= owner--repo の `--` ではない)
      ['--owner--repo'], // 先頭セパレータ
      ['.owner--repo'], // 先頭が `.`
      ['_owner--repo'], // 先頭が `_`
      ['-owner--repo'], // 先頭が `-`
      ['owner/repo--skill'], // `/` 含む (path traversal)
      ['../../etc--passwd'], // `..` + `/` (path traversal)
    ])('"%s" を拒否する', (input) => {
      expect(BIBLIO_NAME_RE.test(input)).toBe(false);
    });
  });
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
