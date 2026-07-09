/**
 * 解除 (unshelve) の決定的ロジックのユニットテスト。
 *
 * - undici.fetch を vi.mock で URL + method → 期待応答 table に差し替える
 * - shelve.test.ts と同じ mock 境界 (config / log / env)
 * - 重複検知 (= not_shelved) / 削除 PR 作成 / sha:null + base_tree の組み立て /
 *   permission_denied 系 GhHttpError / category 不在経路 / dir 不在経路 を網羅
 *
 * 実 GitHub への到達は `scripts/verify-m3-phase-3.sh` で担保する (本テストは決定的ロジックのみ)。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({
    SHELF_REPO_OWNER: 'HajimariInc',
    SHELF_REPO_NAME: 'biblio-shelf',
    SHELF_PR_AUTHOR_NAME: 'hj-biblio-github-app[bot]',
    SHELF_PR_AUTHOR_EMAIL: '292998322+hj-biblio-github-app[bot]@users.noreply.github.com',
    SHELF_PR_AUTHOR_FALLBACK: '',
  })),
}));

// undici.fetch をテーブル駆動で差し替え (実 GitHub に到達させない)。
const fetchMock = vi.fn();
vi.mock('undici', () => ({
  fetch: (url: string, init?: { method?: string; body?: string }) => fetchMock(url, init),
}));

import { log } from '../log.js';
import { readEnvFile } from '../env.js';
import { unshelve } from './unshelve.js';

/** 簡易 Response モック (ok / status / json / text)。 */
function res(
  status: number,
  body: unknown,
): {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
} {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 404 ? 'Not Found' : 'Error',
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => text,
  };
}

/** marketplace.json content (base64 encoded) を組む。 */
function marketplaceContent(plugins: Array<{ name: string; source?: string }>): string {
  const json = JSON.stringify(
    {
      name: 'biblio-shelf',
      owner: { name: 'HajimariInc', email: 'noreply@example.com' },
      description: 'test',
      plugins,
    },
    null,
    2,
  );
  return Buffer.from(json, 'utf-8').toString('base64');
}

/**
 * 成功フル経路 (= 削除 PR 作成) の fetch シナリオ。
 *
 * URL pattern と method で分岐、規定 sha + 期待 body を返す。tree fetch は
 * root → category → biblio dir の 3 段で別々に応答する。
 */
function setupHappyPath(opts: { biblioName?: string; category?: string; mpEntryExists?: boolean } = {}): {
  capturedTreeBody: { value: string | null };
} {
  const biblioName = opts.biblioName ?? 'owner--repo';
  const category = opts.category ?? 'biblio-dev';
  const mpEntryExists = opts.mpEntryExists ?? true;
  const capturedTreeBody: { value: string | null } = { value: null };

  fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    // marketplace.json fetch
    if (url.includes('/contents/.claude-plugin/marketplace.json') && (!init?.method || init.method === 'GET')) {
      return res(200, {
        content: marketplaceContent(mpEntryExists ? [{ name: biblioName, source: `./${category}/${biblioName}` }] : []),
        encoding: 'base64',
        sha: 'mp-sha',
      });
    }
    // GET /git/ref/heads/main
    if (url.endsWith('/git/ref/heads/main') && (!init?.method || init.method === 'GET')) {
      return res(200, { object: { sha: 'base-commit-sha' } });
    }
    // GET /git/commits/{sha}
    if (url.match(/\/git\/commits\/[a-z0-9-]+$/) && (!init?.method || init.method === 'GET')) {
      return res(200, { tree: { sha: 'base-tree-sha' } });
    }
    // GET /git/trees/{sha} or /git/trees/{sha}?recursive=1
    if (url.match(/\/git\/trees\/[a-z0-9-]+(\?recursive=1)?$/) && (!init?.method || init.method === 'GET')) {
      // base-tree-sha (root, non-recursive) → category entry を返す
      if (url.endsWith('/git/trees/base-tree-sha')) {
        return res(200, {
          tree: [{ path: category, mode: '040000', type: 'tree', sha: 'category-tree-sha' }],
          truncated: false,
        });
      }
      // category-tree-sha (non-recursive) → biblio dir entry を返す
      if (url.endsWith('/git/trees/category-tree-sha')) {
        return res(200, {
          tree: [{ path: biblioName, mode: '040000', type: 'tree', sha: 'biblio-dir-tree-sha' }],
          truncated: false,
        });
      }
      // biblio-dir-tree-sha?recursive=1 → 配下 blob 2 件
      if (url.endsWith('/git/trees/biblio-dir-tree-sha?recursive=1')) {
        return res(200, {
          tree: [
            { path: '.claude-plugin/plugin.json', mode: '100644', type: 'blob', sha: 'blob-1' },
            { path: 'SKILL.md', mode: '100644', type: 'blob', sha: 'blob-2' },
          ],
          truncated: false,
        });
      }
      throw new Error(`unexpected tree fetch URL: ${url}`);
    }
    // POST /git/blobs (= entry 除去版 marketplace.json)
    if (url.endsWith('/git/blobs') && init?.method === 'POST') {
      return res(201, { sha: 'new-mp-blob-sha' });
    }
    // POST /git/trees (= 削除 tree、ここで body を capture)
    if (url.endsWith('/git/trees') && init?.method === 'POST') {
      capturedTreeBody.value = init.body ?? null;
      return res(201, { sha: 'new-tree-sha' });
    }
    // POST /git/commits
    if (url.endsWith('/git/commits') && init?.method === 'POST') {
      return res(201, { sha: 'new-commit-sha' });
    }
    // POST /git/refs
    if (url.endsWith('/git/refs') && init?.method === 'POST') {
      return res(201, { ref: 'refs/heads/enkin/...' });
    }
    // POST /pulls
    if (url.endsWith('/pulls') && init?.method === 'POST') {
      return res(201, { html_url: 'https://github.com/HajimariInc/biblio-shelf/pull/99', number: 99 });
    }
    throw new Error(`unexpected fetch call: ${init?.method ?? 'GET'} ${url}`);
  });
  return { capturedTreeBody };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('unshelve — 正常系 (削除 PR 作成)', () => {
  it('正常経路で ok=true + prUrl/branchName を返し、削除 tree に sha:null + base_tree が組まれる', async () => {
    const { capturedTreeBody } = setupHappyPath();
    const result = await unshelve({
      biblioName: 'owner--repo',
      category: 'biblio-dev',
      opLabel: '禁書',
      branchPrefix: 'enkin',
    });
    expect(result).toMatchObject({
      ok: true,
      biblioName: 'owner--repo',
      category: 'biblio-dev',
      prUrl: 'https://github.com/HajimariInc/biblio-shelf/pull/99',
      prNumber: 99,
    });
    expect(result.ok && result.branchName.startsWith('enkin/biblio-dev--owner--repo-')).toBe(true);

    // 削除 tree body の検証 — base_tree が必ず渡る + sha:null × N + marketplace.json blob
    expect(capturedTreeBody.value).not.toBeNull();
    const treeBody = JSON.parse(capturedTreeBody.value!) as {
      base_tree: string;
      tree: Array<{ path: string; mode: string; type: string; sha: string | null }>;
    };
    expect(treeBody.base_tree).toBe('base-tree-sha');
    // 2 個の blob path + 1 個の marketplace.json = 計 3 entries
    expect(treeBody.tree).toHaveLength(3);
    // 2 個は sha:null で削除
    expect(treeBody.tree[0]).toMatchObject({
      path: 'biblio-dev/owner--repo/.claude-plugin/plugin.json',
      sha: null,
    });
    expect(treeBody.tree[1]).toMatchObject({
      path: 'biblio-dev/owner--repo/SKILL.md',
      sha: null,
    });
    // 最後は marketplace.json の新 blob
    expect(treeBody.tree[2]).toMatchObject({
      path: '.claude-plugin/marketplace.json',
      sha: 'new-mp-blob-sha',
    });
  });
});

describe('unshelve — config_error (env 欠落)', () => {
  it('SHELF_REPO_OWNER 等の必須 env が欠落していると config_error reason で fail を返す', async () => {
    // readEnvFile が空オブジェクトを返すと shelf-gh.ts:readShelveEnv が
    // `shelve: required env missing: SHELF_REPO_OWNER, ...` を throw する。
    vi.mocked(readEnvFile).mockReturnValueOnce({});
    vi.mocked(log.warn).mockClear();

    const result = await unshelve({
      biblioName: 'owner--repo',
      category: 'biblio-dev',
      opLabel: '禁書',
      branchPrefix: 'enkin',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return; // 型ガード
    expect(result.reason).toBe('config_error');
    expect(result.detail).toMatch(/required env missing: SHELF_REPO_OWNER/);
    expect(result.biblioName).toBe('owner--repo');
    // env catch は marketplace 取得前に早期 return するため、ネットワーク呼び出しは発生しない
    expect(fetchMock).not.toHaveBeenCalled();
    // 構造化ログキー (= BQ sink の event/outcome 集計に乗ること) の永続 guard
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'unshelve: env not ready',
      expect.objectContaining({
        event: 'biblio.unshelve',
        outcome: 'config_error',
        biblioName: 'owner--repo',
      }),
    );
  });
});

describe('unshelve — not_shelved 早期 return', () => {
  it('marketplace.json が 404 だと not_shelved (= rename / tree fetch しない)', async () => {
    fetchMock.mockImplementationOnce(async () => res(404, { message: 'Not Found' }));
    const result = await unshelve({
      biblioName: 'owner--repo',
      category: 'biblio-dev',
      opLabel: '禁書',
      branchPrefix: 'enkin',
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_shelved' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('plugins[] に entry が存在しないと not_shelved', async () => {
    fetchMock.mockImplementationOnce(async () =>
      res(200, {
        content: marketplaceContent([{ name: 'other--biblio' }]),
        encoding: 'base64',
        sha: 'mp-sha',
      }),
    );
    const result = await unshelve({
      biblioName: 'owner--repo',
      category: 'biblio-dev',
      opLabel: '禁書',
      branchPrefix: 'enkin',
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_shelved' });
    // marketplace fetch だけで早期 return
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('root tree に category dir がないと not_shelved', async () => {
    // marketplace は entry あり、root tree に category なし
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.includes('/contents/.claude-plugin/marketplace.json')) {
        return res(200, {
          content: marketplaceContent([{ name: 'owner--repo' }]),
          encoding: 'base64',
          sha: 'mp-sha',
        });
      }
      if (url.endsWith('/git/ref/heads/main')) return res(200, { object: { sha: 'base-commit-sha' } });
      if (url.match(/\/git\/commits\/[a-z0-9-]+$/)) return res(200, { tree: { sha: 'base-tree-sha' } });
      if (url.endsWith('/git/trees/base-tree-sha')) {
        return res(200, {
          tree: [{ path: 'unrelated', mode: '040000', type: 'tree', sha: 'other-sha' }],
          truncated: false,
        });
      }
      throw new Error(`unexpected: ${init?.method ?? 'GET'} ${url}`);
    });
    const result = await unshelve({
      biblioName: 'owner--repo',
      category: 'biblio-dev',
      opLabel: '禁書',
      branchPrefix: 'enkin',
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_shelved' });
  });

  it('category tree に biblio dir がないと not_shelved', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.includes('/contents/.claude-plugin/marketplace.json')) {
        return res(200, {
          content: marketplaceContent([{ name: 'owner--repo' }]),
          encoding: 'base64',
          sha: 'mp-sha',
        });
      }
      if (url.endsWith('/git/ref/heads/main')) return res(200, { object: { sha: 'base-commit-sha' } });
      if (url.match(/\/git\/commits\/[a-z0-9-]+$/)) return res(200, { tree: { sha: 'base-tree-sha' } });
      if (url.endsWith('/git/trees/base-tree-sha')) {
        return res(200, {
          tree: [{ path: 'biblio-dev', mode: '040000', type: 'tree', sha: 'category-tree-sha' }],
          truncated: false,
        });
      }
      if (url.endsWith('/git/trees/category-tree-sha')) {
        // biblio dir なし
        return res(200, {
          tree: [{ path: 'other--biblio', mode: '040000', type: 'tree', sha: 'other-dir-sha' }],
          truncated: false,
        });
      }
      throw new Error(`unexpected: ${init?.method ?? 'GET'} ${url}`);
    });
    const result = await unshelve({
      biblioName: 'owner--repo',
      category: 'biblio-dev',
      opLabel: '禁書',
      branchPrefix: 'enkin',
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_shelved' });
  });
});

describe('unshelve — github_api_error', () => {
  it('GET marketplace で 500 が返ると github_api_error', async () => {
    fetchMock.mockImplementationOnce(async () => res(500, 'internal server error'));
    const result = await unshelve({
      biblioName: 'owner--repo',
      category: 'biblio-dev',
      opLabel: '禁書',
      branchPrefix: 'enkin',
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'github_api_error',
      detail: expect.stringContaining('status=500'),
    });
  });

  it('POST /git/blobs が 403 (permission denied) を返すと github_api_error', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.includes('/contents/.claude-plugin/marketplace.json')) {
        return res(200, {
          content: marketplaceContent([{ name: 'owner--repo' }]),
          encoding: 'base64',
          sha: 'mp-sha',
        });
      }
      if (url.endsWith('/git/ref/heads/main')) return res(200, { object: { sha: 'base-commit-sha' } });
      if (url.match(/\/git\/commits\/[a-z0-9-]+$/)) return res(200, { tree: { sha: 'base-tree-sha' } });
      if (url.endsWith('/git/trees/base-tree-sha')) {
        return res(200, {
          tree: [{ path: 'biblio-dev', mode: '040000', type: 'tree', sha: 'category-tree-sha' }],
          truncated: false,
        });
      }
      if (url.endsWith('/git/trees/category-tree-sha')) {
        return res(200, {
          tree: [{ path: 'owner--repo', mode: '040000', type: 'tree', sha: 'biblio-dir-tree-sha' }],
          truncated: false,
        });
      }
      if (url.endsWith('/git/trees/biblio-dir-tree-sha?recursive=1')) {
        return res(200, {
          tree: [{ path: 'SKILL.md', mode: '100644', type: 'blob', sha: 'blob-1' }],
          truncated: false,
        });
      }
      if (url.endsWith('/git/blobs') && init?.method === 'POST') {
        return res(403, { message: 'Resource not accessible by integration' });
      }
      throw new Error(`unexpected: ${init?.method ?? 'GET'} ${url}`);
    });
    const result = await unshelve({
      biblioName: 'owner--repo',
      category: 'biblio-dev',
      opLabel: '焼却',
      branchPrefix: 'shokyaku',
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'github_api_error',
      detail: expect.stringContaining('status=403'),
    });
  });
});

describe('unshelve — PAT fallback (= shelve.test.ts と対称)', () => {
  it('SHELF_PR_AUTHOR_FALLBACK 設定済で commit 4xx → fallback で 1 回 retry → ok=true', async () => {
    vi.mocked(readEnvFile).mockReturnValueOnce({
      SHELF_REPO_OWNER: 'HajimariInc',
      SHELF_REPO_NAME: 'biblio-shelf',
      SHELF_PR_AUTHOR_NAME: 'hj-biblio-github-app[bot]',
      SHELF_PR_AUTHOR_EMAIL: '292998322+hj-biblio-github-app[bot]@users.noreply.github.com',
      SHELF_PR_AUTHOR_FALLBACK: 'Test Author <test@example.com>',
    });

    let commitAttempts = 0;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      // marketplace.json — entry あり
      if (url.includes('/contents/.claude-plugin/marketplace.json')) {
        return res(200, {
          content: marketplaceContent([{ name: 'owner--repo' }]),
          encoding: 'base64',
          sha: 'mp-sha',
        });
      }
      if (url.endsWith('/git/ref/heads/main')) return res(200, { object: { sha: 'base-commit-sha' } });
      if (url.match(/\/git\/commits\/[a-z0-9-]+$/) && (!init?.method || init.method === 'GET'))
        return res(200, { tree: { sha: 'base-tree-sha' } });
      if (url.endsWith('/git/trees/base-tree-sha')) {
        return res(200, {
          tree: [{ path: 'biblio-dev', mode: '040000', type: 'tree', sha: 'category-tree-sha' }],
          truncated: false,
        });
      }
      if (url.endsWith('/git/trees/category-tree-sha')) {
        return res(200, {
          tree: [{ path: 'owner--repo', mode: '040000', type: 'tree', sha: 'biblio-dir-tree-sha' }],
          truncated: false,
        });
      }
      if (url.endsWith('/git/trees/biblio-dir-tree-sha?recursive=1')) {
        return res(200, {
          tree: [{ path: 'SKILL.md', mode: '100644', type: 'blob', sha: 'blob-1' }],
          truncated: false,
        });
      }
      if (url.endsWith('/git/blobs') && init?.method === 'POST') return res(201, { sha: 'new-mp-blob-sha' });
      if (url.endsWith('/git/trees') && init?.method === 'POST') return res(201, { sha: 'new-tree-sha' });
      if (url.endsWith('/git/commits') && init?.method === 'POST') {
        commitAttempts++;
        // 1 回目は 422 (GH App identity 失敗) → 2 回目は 201 (fallback)
        return commitAttempts === 1 ? res(422, { message: 'invalid author' }) : res(201, { sha: 'new-commit-sha' });
      }
      if (url.endsWith('/git/refs') && init?.method === 'POST') return res(201, { ref: 'refs/heads/enkin/...' });
      if (url.endsWith('/pulls') && init?.method === 'POST')
        return res(201, { html_url: 'https://github.com/HajimariInc/biblio-shelf/pull/77', number: 77 });
      throw new Error(`unexpected: ${init?.method ?? 'GET'} ${url}`);
    });

    const result = await unshelve({
      biblioName: 'owner--repo',
      category: 'biblio-dev',
      opLabel: '禁書',
      branchPrefix: 'enkin',
    });
    expect(result).toMatchObject({ ok: true, prNumber: 77 });
    expect(commitAttempts).toBe(2);
  });

  it('SHELF_PR_AUTHOR_FALLBACK 未設定で commit 4xx → github_api_error (retry しない)', async () => {
    // default env は fallback 空 (vi.mock 冒頭で設定済)
    setupHappyPath();
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.includes('/contents/.claude-plugin/marketplace.json')) {
        return res(200, {
          content: marketplaceContent([{ name: 'owner--repo' }]),
          encoding: 'base64',
          sha: 'mp-sha',
        });
      }
      if (url.endsWith('/git/ref/heads/main')) return res(200, { object: { sha: 'base-commit-sha' } });
      if (url.match(/\/git\/commits\/[a-z0-9-]+$/) && (!init?.method || init.method === 'GET'))
        return res(200, { tree: { sha: 'base-tree-sha' } });
      if (url.endsWith('/git/trees/base-tree-sha')) {
        return res(200, {
          tree: [{ path: 'biblio-dev', mode: '040000', type: 'tree', sha: 'category-tree-sha' }],
          truncated: false,
        });
      }
      if (url.endsWith('/git/trees/category-tree-sha')) {
        return res(200, {
          tree: [{ path: 'owner--repo', mode: '040000', type: 'tree', sha: 'biblio-dir-tree-sha' }],
          truncated: false,
        });
      }
      if (url.endsWith('/git/trees/biblio-dir-tree-sha?recursive=1')) {
        return res(200, {
          tree: [{ path: 'SKILL.md', mode: '100644', type: 'blob', sha: 'blob-1' }],
          truncated: false,
        });
      }
      if (url.endsWith('/git/blobs') && init?.method === 'POST') return res(201, { sha: 'new-mp-blob-sha' });
      if (url.endsWith('/git/trees') && init?.method === 'POST') return res(201, { sha: 'new-tree-sha' });
      if (url.endsWith('/git/commits') && init?.method === 'POST') {
        // fallback 未設定で 4xx → 即 github_api_error (retry なし)
        return res(422, { message: 'auth required' });
      }
      throw new Error(`unexpected: ${init?.method ?? 'GET'} ${url}`);
    });

    const result = await unshelve({
      biblioName: 'owner--repo',
      category: 'biblio-dev',
      opLabel: '禁書',
      branchPrefix: 'enkin',
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'github_api_error',
      detail: expect.stringContaining('status=422'),
    });
  });
});
