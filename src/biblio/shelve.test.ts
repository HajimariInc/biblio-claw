/**
 * 陳列 (shelve) の決定的ロジックのユニットテスト。
 *
 * - undici.fetch を vi.mock で「URL + method → 期待応答」の table に差し替える
 * - tmpfs に quarantine biblio を組み立て、`quarantineRoot` + `shelfRoot` で直接指す
 * - 重複検知 / 初回 / quarantine 不在 / non-2xx / PAT fallback の 5 + ケースで分岐を網羅
 *
 * inspect.test.ts / categorize.test.ts と同じ vi.mock 境界 (config / log / env) を踏襲。
 * 実 GitHub への到達は scripts/verify-m2.sh で担保する (本テストは決定的ロジックのみ)。
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/biblio-shelve-test-${process.pid}` }));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({
    SHELF_REPO_OWNER: 'HajimariInc',
    SHELF_REPO_NAME: 'biblio-shelf',
    SHELF_PR_AUTHOR_NAME: 'hj-biblio-github-app[bot]',
    SHELF_PR_AUTHOR_EMAIL: '292998322+hj-biblio-github-app[bot]@users.noreply.github.com',
    // テストでは fallback を空にして default 経路だけを使う。fallback ケースは
    // 個別 test 内で `vi.mocked(readEnvFile).mockReturnValueOnce(...)` で上書きする。
    SHELF_PR_AUTHOR_FALLBACK: '',
  })),
}));

// undici.fetch をテーブル駆動で差し替え (実 GitHub に到達させない)。
const fetchMock = vi.fn();

vi.mock('undici', () => ({
  fetch: (url: string, init?: { method?: string; body?: string }) => fetchMock(url, init),
}));

import { readEnvFile } from '../env.js';
import { shelve } from './shelve.js';

/** 簡易 Response モック (ok / status / json / text を持つ最小実装)。 */
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

/** tmpfs 内に quarantine biblio を作る (SKILL.md + plugin.json)。 */
function setupQuarantine(name: string): string {
  const dir = path.join(TEST_DIR, 'quarantine', name);
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, description: 'test biblio', license: 'MIT', version: '0.1.0' }),
  );
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# test skill body');
  return dir;
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
 * 成功フル経路の fetch シナリオを順序通り発行する handler。
 * 各 step で expected URL pattern を assert し、規定 sha を返す。
 */
function setupHappyPath(opts: { marketplaceExists?: boolean; commitStatus?: number } = {}): void {
  const { marketplaceExists = false, commitStatus = 201 } = opts;
  let callIndex = 0;
  fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    callIndex++;
    if (url.includes('/contents/.claude-plugin/marketplace.json') && (!init?.method || init.method === 'GET')) {
      return marketplaceExists
        ? res(200, { content: marketplaceContent([]), encoding: 'base64', sha: 'mp-sha' })
        : res(404, { message: 'Not Found' });
    }
    if (url.includes('/git/ref/heads/main')) {
      return res(200, { object: { sha: 'base-commit-sha' } });
    }
    if (url.match(/\/git\/commits\/[a-z0-9-]+$/) && (!init?.method || init.method === 'GET')) {
      return res(200, { tree: { sha: 'base-tree-sha' } });
    }
    if (url.endsWith('/git/blobs') && init?.method === 'POST') {
      return res(201, { sha: `blob-sha-${callIndex}` });
    }
    if (url.endsWith('/git/trees') && init?.method === 'POST') {
      return res(201, { sha: 'new-tree-sha' });
    }
    if (url.endsWith('/git/commits') && init?.method === 'POST') {
      return res(commitStatus, commitStatus < 300 ? { sha: 'new-commit-sha' } : { message: 'auth required' });
    }
    if (url.endsWith('/git/refs') && init?.method === 'POST') {
      return res(201, { ref: 'refs/heads/shelve/...' });
    }
    if (url.endsWith('/pulls') && init?.method === 'POST') {
      return res(201, { html_url: 'https://github.com/HajimariInc/biblio-shelf/pull/42', number: 42 });
    }
    throw new Error(`unexpected fetch call: ${init?.method ?? 'GET'} ${url}`);
  });
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fetchMock.mockReset();
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('shelve — 重複検知', () => {
  it('既存 marketplace.json に同名 entry があれば early return / already_shelved', async () => {
    setupQuarantine('owner--repo');
    fetchMock.mockImplementationOnce(async () =>
      res(200, {
        content: marketplaceContent([{ name: 'owner--repo' }]),
        encoding: 'base64',
        sha: 'mp-sha',
      }),
    );
    const result = await shelve(
      { biblioName: 'owner--repo', category: 'biblio-dev', reason: 'test' },
      { quarantineRoot: path.join(TEST_DIR, 'quarantine'), shelfRoot: path.join(TEST_DIR, 'shelf') },
    );
    expect(result).toMatchObject({ ok: false, reason: 'already_shelved' });
    // 重複検知後は他の API は叩かない (= 1 回しか呼ばれていない)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // quarantine は残す (移動しない)
    expect(fs.existsSync(path.join(TEST_DIR, 'quarantine', 'owner--repo'))).toBe(true);
  });
});

describe('shelve — 初回成功 (marketplace 不在 → 新規作成)', () => {
  it('marketplace 404 → 各 API 200/201 → ok=true + prUrl 返却', async () => {
    setupQuarantine('owner--repo');
    setupHappyPath({ marketplaceExists: false });
    const result = await shelve(
      { biblioName: 'owner--repo', category: 'biblio-dev', reason: 'TypeScript refactor 補助' },
      { quarantineRoot: path.join(TEST_DIR, 'quarantine'), shelfRoot: path.join(TEST_DIR, 'shelf') },
    );
    expect(result).toMatchObject({
      ok: true,
      biblioName: 'owner--repo',
      category: 'biblio-dev',
      prUrl: 'https://github.com/HajimariInc/biblio-shelf/pull/42',
      prNumber: 42,
      branchName: 'shelve/biblio-dev--owner--repo',
    });
    // quarantine → shelf 移動済 (rename 成立)
    expect(fs.existsSync(path.join(TEST_DIR, 'quarantine', 'owner--repo'))).toBe(false);
    expect(fs.existsSync(path.join(TEST_DIR, 'shelf', 'biblio-dev', 'owner--repo', 'SKILL.md'))).toBe(true);
  });
});

describe('shelve — quarantine 不在', () => {
  it('quarantine dir が無いと quarantine_missing で early return (rename 試行しない)', async () => {
    // 重複検知は通って (marketplace 404)、その後の存在確認で落ちる経路
    fetchMock.mockImplementationOnce(async () => res(404, { message: 'Not Found' }));
    const result = await shelve(
      { biblioName: 'owner--nonexistent', category: 'biblio-dev', reason: 'test' },
      { quarantineRoot: path.join(TEST_DIR, 'quarantine'), shelfRoot: path.join(TEST_DIR, 'shelf') },
    );
    expect(result).toMatchObject({ ok: false, reason: 'quarantine_missing' });
  });
});

describe('shelve — GitHub API non-2xx', () => {
  it('GET marketplace で 500 が返ると github_api_error', async () => {
    setupQuarantine('owner--repo');
    fetchMock.mockImplementationOnce(async () => res(500, 'internal server error'));
    const result = await shelve(
      { biblioName: 'owner--repo', category: 'biblio-dev', reason: 'test' },
      { quarantineRoot: path.join(TEST_DIR, 'quarantine'), shelfRoot: path.join(TEST_DIR, 'shelf') },
    );
    expect(result).toMatchObject({
      ok: false,
      reason: 'github_api_error',
      detail: expect.stringContaining('status=500'),
    });
    // quarantine は残す
    expect(fs.existsSync(path.join(TEST_DIR, 'quarantine', 'owner--repo'))).toBe(true);
  });
});

describe('shelve — PAT fallback', () => {
  it('SHELF_PR_AUTHOR_FALLBACK が設定済で commit が 4xx → fallback で 1 回 retry → 成功', async () => {
    setupQuarantine('owner--repo');
    // fallback ありの env に上書き
    vi.mocked(readEnvFile).mockReturnValue({
      SHELF_REPO_OWNER: 'HajimariInc',
      SHELF_REPO_NAME: 'biblio-shelf',
      SHELF_PR_AUTHOR_NAME: 'hj-biblio-github-app[bot]',
      SHELF_PR_AUTHOR_EMAIL: '292998322+hj-biblio-github-app[bot]@users.noreply.github.com',
      SHELF_PR_AUTHOR_FALLBACK: 'MAXiDEN <claude@wforest.jp>',
    });

    let commitAttempts = 0;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (url.includes('/contents/.claude-plugin/marketplace.json') && (!init?.method || init.method === 'GET')) {
        return res(404, { message: 'Not Found' });
      }
      if (url.includes('/git/ref/heads/main')) return res(200, { object: { sha: 'base-commit-sha' } });
      if (url.match(/\/git\/commits\/[a-z0-9-]+$/) && (!init?.method || init.method === 'GET'))
        return res(200, { tree: { sha: 'base-tree-sha' } });
      if (url.endsWith('/git/blobs') && init?.method === 'POST') return res(201, { sha: 'blob-x' });
      if (url.endsWith('/git/trees') && init?.method === 'POST') return res(201, { sha: 'new-tree-sha' });
      if (url.endsWith('/git/commits') && init?.method === 'POST') {
        commitAttempts++;
        // 1 回目は 422 (GH App 経路で失敗) → 2 回目は 201 (fallback)
        return commitAttempts === 1 ? res(422, { message: 'invalid author' }) : res(201, { sha: 'new-commit-sha' });
      }
      if (url.endsWith('/git/refs') && init?.method === 'POST') return res(201, { ref: 'refs/heads/...' });
      if (url.endsWith('/pulls') && init?.method === 'POST')
        return res(201, { html_url: 'https://github.com/HajimariInc/biblio-shelf/pull/77', number: 77 });
      throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    const result = await shelve(
      { biblioName: 'owner--repo', category: 'biblio-dev', reason: 'test' },
      { quarantineRoot: path.join(TEST_DIR, 'quarantine'), shelfRoot: path.join(TEST_DIR, 'shelf') },
    );
    expect(result).toMatchObject({ ok: true, prNumber: 77 });
    expect(commitAttempts).toBe(2);
  });

  it('SHELF_PR_AUTHOR_FALLBACK が未設定で commit が 4xx → github_api_error (retry しない)', async () => {
    setupQuarantine('owner--repo');
    // env は default (fallback 空)
    setupHappyPath({ marketplaceExists: false, commitStatus: 422 });
    const result = await shelve(
      { biblioName: 'owner--repo', category: 'biblio-dev', reason: 'test' },
      { quarantineRoot: path.join(TEST_DIR, 'quarantine'), shelfRoot: path.join(TEST_DIR, 'shelf') },
    );
    expect(result).toMatchObject({ ok: false, reason: 'github_api_error' });
  });
});
