/**
 * `shelf-gh.ts` の env 読み込み関数 + GitHub API ラッパのユニットテスト。
 *
 * 構成:
 *   - `readListEnv` (= list-biblio 経路、author env 不要) を中心にカバー
 *   - `readShelveEnv` (= 既存 4 件必須) の regression も併設
 *   - `ghFetch` (= 全 GitHub API 経路の中核): 200 / 4xx / 5xx / body 読取失敗
 *   - `fetchMarketplace`: 404 → null / 200 正常 / content 欠落 → throw / invalid JSON → throw
 *   - `createCommit`: POST body 構造 + 200 sha 有り / sha 欠落 → throw
 *
 * shelve.test.ts と同じ vi.mock 境界 (log / env) を踏襲し、`readEnvFile` の
 * 戻り値を test ごとに `mockReturnValueOnce` で差し替える。`undici.fetch` も
 * mock し、wire レベルの response を test ごとに組み立てる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(),
}));

const undiciFetchMock = vi.fn();
vi.mock('undici', async (importActual) => {
  const actual = await importActual<typeof import('undici')>();
  return {
    ...actual,
    fetch: (...args: unknown[]) => undiciFetchMock(...args),
  };
});

import { readEnvFile } from '../env.js';
import {
  GITHUB_API,
  GhHttpError,
  createCommit,
  fetchMarketplace,
  ghFetch,
  readListEnv,
  readShelveEnv,
  type ListEnv,
  type ShelfEnv,
} from './shelf-gh.js';

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
      SHELF_PR_AUTHOR_EMAIL: 'test-bot@example.com',
    });
    const env = readShelveEnv();
    expect(env.shelfOwner).toBe('HajimariInc');
    expect(env.shelfRepo).toBe('biblio-shelf');
    expect(env.authorName).toBe('biblio-claw bot');
    expect(env.authorEmail).toBe('test-bot@example.com');
    expect(env.fallbackAuthor).toBeNull();
  });

  it('throws with "shelve:" prefix when SHELF_PR_AUTHOR_NAME is missing', () => {
    vi.mocked(readEnvFile).mockReturnValueOnce({
      SHELF_REPO_OWNER: 'HajimariInc',
      SHELF_REPO_NAME: 'biblio-shelf',
      SHELF_PR_AUTHOR_EMAIL: 'test-bot@example.com',
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
      SHELF_PR_AUTHOR_EMAIL: 'test-bot@example.com',
      SHELF_PR_AUTHOR_FALLBACK: 'Test <test@example.com>',
    });
    const env = readShelveEnv();
    expect(env.fallbackAuthor).toEqual({ name: 'Test', email: 'test@example.com' });
  });
});

// ----------------------------------------------------------------------------
// GitHub API ラッパのテスト群
// ----------------------------------------------------------------------------

describe('ghFetch', () => {
  beforeEach(() => undiciFetchMock.mockReset());

  it('200 レスポンスを JSON としてパースして返す', async () => {
    undiciFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ sha: 'abc123' }),
    });
    const result = await ghFetch('test.get', `${GITHUB_API}/test`);
    expect(result).toEqual({ sha: 'abc123' });
  });

  it('4xx レスポンスを GhHttpError に変換する (status + body 保持)', async () => {
    undiciFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    });
    try {
      await ghFetch('test.404', `${GITHUB_API}/test`);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GhHttpError);
      expect((err as GhHttpError).status).toBe(404);
      expect((err as GhHttpError).body).toBe('Not Found');
      expect((err as GhHttpError).step).toBe('test.404');
    }
  });

  it('5xx レスポンスを GhHttpError に変換する', async () => {
    undiciFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    });
    await expect(ghFetch('test.503', `${GITHUB_API}/test`)).rejects.toBeInstanceOf(GhHttpError);
  });

  it('body 読み取り失敗時に body="(body read failed)" マーカーを設定する (= I4 解消)', async () => {
    undiciFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error('socket closed');
      },
    });
    try {
      await ghFetch('test.body-fail', `${GITHUB_API}/test`);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GhHttpError);
      // caller の detail 整形 (`err.body.slice(0, 200)`) が空文字でデバッグ不能になる罠を回避。
      expect((err as GhHttpError).body).toBe('(body read failed)');
    }
  });

  it('Authorization: Bearer placeholder ヘッダを wire で送る (= OneCLI MITM 経路)', async () => {
    undiciFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    await ghFetch('test.headers', `${GITHUB_API}/test`);
    const fetchCall = undiciFetchMock.mock.calls.at(0);
    expect(fetchCall?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: 'Bearer placeholder',
        Accept: 'application/vnd.github+json',
      }),
    });
  });
});

describe('fetchMarketplace', () => {
  beforeEach(() => undiciFetchMock.mockReset());

  const env: ListEnv = { shelfOwner: 'HajimariInc', shelfRepo: 'biblio-shelf' };

  it('404 のときは { raw: null, sha: null } を返す (= unshelve が「既に解除済 / 元から不在」として扱う経路)', async () => {
    undiciFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    });
    const result = await fetchMarketplace(env);
    expect(result).toEqual({ raw: null, sha: null });
  });

  it('200 正常レスポンスを base64 decode して JSON パースする', async () => {
    const marketplace = { plugins: [{ name: 'test', source: { type: 'github', repo: 'foo/bar' } }] };
    const content = Buffer.from(JSON.stringify(marketplace), 'utf-8').toString('base64');
    undiciFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ content, encoding: 'base64', sha: 'sha-xyz' }),
    });
    const result = await fetchMarketplace(env);
    expect(result.raw).toEqual(marketplace);
    expect(result.sha).toBe('sha-xyz');
  });

  it('content フィールド欠落で GhHttpError(200) を throw する', async () => {
    undiciFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ sha: 'sha-xyz' }), // content / encoding 欠落
    });
    try {
      await fetchMarketplace(env);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GhHttpError);
      expect((err as GhHttpError).status).toBe(200);
      expect((err as GhHttpError).body).toContain('response missing content/encoding');
    }
  });

  it('decode 後が invalid JSON で GhHttpError(200) を throw する', async () => {
    const content = Buffer.from('this is not json {{{', 'utf-8').toString('base64');
    undiciFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ content, encoding: 'base64', sha: 'sha-xyz' }),
    });
    try {
      await fetchMarketplace(env);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GhHttpError);
      expect((err as GhHttpError).status).toBe(200);
      expect((err as GhHttpError).body).toContain('invalid JSON');
    }
  });
});

describe('createCommit', () => {
  beforeEach(() => undiciFetchMock.mockReset());

  const shelfEnv: ShelfEnv = {
    shelfOwner: 'HajimariInc',
    shelfRepo: 'biblio-shelf',
    authorName: 'biblio-claw bot',
    authorEmail: 'test-bot@example.com',
    fallbackAuthor: null,
  };
  const author = { name: shelfEnv.authorName, email: shelfEnv.authorEmail };

  it('POST git/commits を message + tree + parents + author + committer で叩く', async () => {
    undiciFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ sha: 'commit-sha' }),
    });
    const result = await createCommit({
      env: shelfEnv,
      message: 'test commit',
      treeSha: 'tree-sha',
      parentSha: 'parent-sha',
      author,
    });
    expect(result).toEqual({ sha: 'commit-sha' });
    const fetchCall = undiciFetchMock.mock.calls.at(0);
    expect(fetchCall?.[0]).toBe(`${GITHUB_API}/repos/HajimariInc/biblio-shelf/git/commits`);
    expect(fetchCall?.[1]).toMatchObject({ method: 'POST' });
    const body = JSON.parse((fetchCall?.[1] as { body: string }).body);
    expect(body).toEqual({
      message: 'test commit',
      tree: 'tree-sha',
      parents: ['parent-sha'],
      author,
      committer: author,
    });
  });

  it('response.sha 欠落で GhHttpError(200) を throw する', async () => {
    undiciFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ commit: {} }), // sha 欠落
    });
    try {
      await createCommit({
        env: shelfEnv,
        message: 'test',
        treeSha: 'tree-sha',
        parentSha: 'parent-sha',
        author,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GhHttpError);
      expect((err as GhHttpError).body).toContain('response missing sha');
    }
  });
});
