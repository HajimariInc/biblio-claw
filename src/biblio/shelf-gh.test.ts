/**
 * `shelf-gh.ts` の env 読み込み関数のユニットテスト。
 *
 * `readListEnv` (= list-biblio 経路、author env 不要) を中心にカバーし、
 * `readShelveEnv` (= 既存 4 件必須) の regression も併設する。
 *
 * shelve.test.ts と同じ vi.mock 境界 (log / env) を踏襲し、`readEnvFile` の
 * 戻り値を test ごとに `mockReturnValueOnce` で差し替える。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(),
}));

import { readEnvFile } from '../env.js';
import { readListEnv, readShelveEnv } from './shelf-gh.js';

describe('readListEnv', () => {
  beforeEach(() => {
    vi.mocked(readEnvFile).mockReset();
  });

  it('returns shelfOwner/shelfRepo when both SHELF_REPO_* are set', () => {
    vi.mocked(readEnvFile).mockReturnValueOnce({
      SHELF_REPO_OWNER: 'test-owner',
      SHELF_REPO_NAME: 'test-shelf',
    });
    const env = readListEnv();
    expect(env).toEqual({ shelfOwner: 'test-owner', shelfRepo: 'test-shelf' });
  });

  it('does not require SHELF_PR_AUTHOR_* (= list-biblio 経路の write 不要前提)', () => {
    // author env を一切渡さなくても通ることが本関数の存在意義。
    vi.mocked(readEnvFile).mockReturnValueOnce({
      SHELF_REPO_OWNER: 'HajimariInc',
      SHELF_REPO_NAME: 'biblio-shelf',
    });
    expect(() => readListEnv()).not.toThrow();
  });

  it('throws with "list:" prefix when SHELF_REPO_OWNER is missing', () => {
    vi.mocked(readEnvFile).mockReturnValueOnce({ SHELF_REPO_NAME: 'test-shelf' });
    expect(() => readListEnv()).toThrow(/^list: required env missing: SHELF_REPO_OWNER$/);
  });

  it('throws when SHELF_REPO_NAME is missing', () => {
    vi.mocked(readEnvFile).mockReturnValueOnce({ SHELF_REPO_OWNER: 'test-owner' });
    expect(() => readListEnv()).toThrow(/required env missing: SHELF_REPO_NAME/);
  });

  it('reports both missing env keys in a single error', () => {
    vi.mocked(readEnvFile).mockReturnValueOnce({});
    expect(() => readListEnv()).toThrow(/required env missing: SHELF_REPO_OWNER, SHELF_REPO_NAME/);
  });

  it('treats an empty-string value as missing (= readEnvFile が空文字を返した場合)', () => {
    vi.mocked(readEnvFile).mockReturnValueOnce({ SHELF_REPO_OWNER: '', SHELF_REPO_NAME: 'test-shelf' });
    expect(() => readListEnv()).toThrow(/SHELF_REPO_OWNER/);
  });
});

describe('readShelveEnv (regression)', () => {
  beforeEach(() => {
    vi.mocked(readEnvFile).mockReset();
  });

  it('still requires all 4 keys (= write 経路は author 必須を維持)', () => {
    vi.mocked(readEnvFile).mockReturnValueOnce({
      SHELF_REPO_OWNER: 'HajimariInc',
      SHELF_REPO_NAME: 'biblio-shelf',
      SHELF_PR_AUTHOR_NAME: 'biblio-claw bot',
      SHELF_PR_AUTHOR_EMAIL: 'biblio-claw@wforest.jp',
    });
    const env = readShelveEnv();
    expect(env.shelfOwner).toBe('HajimariInc');
    expect(env.shelfRepo).toBe('biblio-shelf');
    expect(env.authorName).toBe('biblio-claw bot');
    expect(env.authorEmail).toBe('biblio-claw@wforest.jp');
    expect(env.fallbackAuthor).toBeNull();
  });

  it('throws with "shelve:" prefix when SHELF_PR_AUTHOR_NAME is missing', () => {
    vi.mocked(readEnvFile).mockReturnValueOnce({
      SHELF_REPO_OWNER: 'HajimariInc',
      SHELF_REPO_NAME: 'biblio-shelf',
      SHELF_PR_AUTHOR_EMAIL: 'biblio-claw@wforest.jp',
    });
    expect(() => readShelveEnv()).toThrow(/^shelve: required env missing: SHELF_PR_AUTHOR_NAME$/);
  });

  it('throws when SHELF_PR_AUTHOR_EMAIL is missing (= readListEnv との対比)', () => {
    vi.mocked(readEnvFile).mockReturnValueOnce({
      SHELF_REPO_OWNER: 'HajimariInc',
      SHELF_REPO_NAME: 'biblio-shelf',
      SHELF_PR_AUTHOR_NAME: 'biblio-claw bot',
    });
    expect(() => readShelveEnv()).toThrow(/SHELF_PR_AUTHOR_EMAIL/);
  });

  it('parses SHELF_PR_AUTHOR_FALLBACK in `Name <email>` form', () => {
    vi.mocked(readEnvFile).mockReturnValueOnce({
      SHELF_REPO_OWNER: 'HajimariInc',
      SHELF_REPO_NAME: 'biblio-shelf',
      SHELF_PR_AUTHOR_NAME: 'biblio-claw bot',
      SHELF_PR_AUTHOR_EMAIL: 'biblio-claw@wforest.jp',
      SHELF_PR_AUTHOR_FALLBACK: 'DEN <den@example.com>',
    });
    const env = readShelveEnv();
    expect(env.fallbackAuthor).toEqual({ name: 'DEN', email: 'den@example.com' });
  });
});
