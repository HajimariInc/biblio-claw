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
import { shelve, shelveMulti } from './shelve.js';

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

describe('shelve — 後半 API step non-2xx (rename 完了後の中断、PR #8 レビュー pr-test-analyzer 改善 1)', () => {
  it('POST git/blobs が 500 を返すと github_api_error (rename 完了後なので shelf に残骸が残る)', async () => {
    setupQuarantine('owner--repo');
    let blobCalled = false;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.includes('/contents/.claude-plugin/marketplace.json') && (!init?.method || init.method === 'GET')) {
        return res(404, { message: 'Not Found' });
      }
      if (url.includes('/git/ref/heads/main')) return res(200, { object: { sha: 'base-commit-sha' } });
      if (url.match(/\/git\/commits\/[a-z0-9-]+$/) && (!init?.method || init.method === 'GET'))
        return res(200, { tree: { sha: 'base-tree-sha' } });
      if (url.endsWith('/git/blobs') && init?.method === 'POST') {
        blobCalled = true;
        return res(500, 'internal server error');
      }
      throw new Error(`unexpected: ${init?.method ?? 'GET'} ${url}`);
    });
    const result = await shelve(
      { biblioName: 'owner--repo', category: 'biblio-dev', reason: 'test' },
      { quarantineRoot: path.join(TEST_DIR, 'quarantine'), shelfRoot: path.join(TEST_DIR, 'shelf') },
    );
    expect(blobCalled).toBe(true);
    expect(result).toMatchObject({ ok: false, reason: 'github_api_error' });
    // rename 完了後の失敗 = shelf に残骸が残り、quarantine からは消える
    // (= 次回 acquire で quarantine_missing に倒れるリスクを warn ログで可視化する流儀)
    expect(fs.existsSync(path.join(TEST_DIR, 'shelf', 'biblio-dev', 'owner--repo'))).toBe(true);
    expect(fs.existsSync(path.join(TEST_DIR, 'quarantine', 'owner--repo'))).toBe(false);
  });
});

describe('shelve — marketplace.json invalid JSON (PR #8 レビュー pr-test-analyzer 改善 2)', () => {
  it('既存 marketplace.json が壊れた JSON だと github_api_error + quarantine 残置', async () => {
    setupQuarantine('owner--repo');
    fetchMock.mockImplementationOnce(async () =>
      res(200, {
        content: Buffer.from('{"plugins": [BROKEN', 'utf-8').toString('base64'),
        encoding: 'base64',
        sha: 'mp-sha',
      }),
    );
    const result = await shelve(
      { biblioName: 'owner--repo', category: 'biblio-dev', reason: 'test' },
      { quarantineRoot: path.join(TEST_DIR, 'quarantine'), shelfRoot: path.join(TEST_DIR, 'shelf') },
    );
    expect(result).toMatchObject({
      ok: false,
      reason: 'github_api_error',
      detail: expect.stringContaining('invalid JSON'),
    });
    // 重複検知フェーズで失敗 → rename 未達なので quarantine は残る
    expect(fs.existsSync(path.join(TEST_DIR, 'quarantine', 'owner--repo'))).toBe(true);
  });
});

describe('shelve — バイナリ fail-closed (PR #8 レビュー silent-failure-hunter Important 2)', () => {
  it('shelf 内に NULL byte を含むファイルがあると github_api_error で中断 (silent 文字化け回避)', async () => {
    const dir = setupQuarantine('owner--repo');
    // NULL byte を含む binary ファイルを混ぜる (= SKILL.md / plugin.json と同じ階層)
    fs.writeFileSync(path.join(dir, 'binary.dat'), Buffer.from([0xff, 0x00, 0xab, 0xcd]));
    // 他のテキストファイルは blob 作成を成功させ、binary.dat に到達したときに detection で中断する経路を確認
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.includes('/contents/.claude-plugin/marketplace.json') && (!init?.method || init.method === 'GET')) {
        return res(404, { message: 'Not Found' });
      }
      if (url.includes('/git/ref/heads/main')) return res(200, { object: { sha: 'base-commit-sha' } });
      if (url.match(/\/git\/commits\/[a-z0-9-]+$/) && (!init?.method || init.method === 'GET'))
        return res(200, { tree: { sha: 'base-tree-sha' } });
      if (url.endsWith('/git/blobs') && init?.method === 'POST') {
        // SKILL.md / plugin.json の blob は 201 で受ける。binary.dat は ghFetch に届く前に
        // shelve.ts の NULL byte detection で throw されるため、ここには到達しない。
        return res(201, { sha: `blob-text-${Math.random()}` });
      }
      throw new Error(`unexpected: ${init?.method ?? 'GET'} ${url}`);
    });
    const result = await shelve(
      { biblioName: 'owner--repo', category: 'biblio-dev', reason: 'test' },
      { quarantineRoot: path.join(TEST_DIR, 'quarantine'), shelfRoot: path.join(TEST_DIR, 'shelf') },
    );
    expect(result).toMatchObject({
      ok: false,
      reason: 'github_api_error',
      detail: expect.stringContaining('binary'),
    });
  });
});

/**
 * 後半 API (= rename + blob + tree + commit 完了後の branch / PR 作成段) の失敗テスト。
 *
 * verify-m2.sh の 6/6 (再 shelve) は branch 既存 422 を実機で踏むが、unit でも分類網羅
 * (= github_api_error への確実な倒し込み) を固定する。残骸 shelf も assert することで
 * silent-failure-hunter で対応した「rename 後失敗 = shelf 残骸 warn」経路が回帰しないよう守る。
 */
describe('shelve — branch / PR 作成失敗 (rename + blob/tree/commit 完了後)', () => {
  it('POST git/refs が 422 (Reference already exists) を返すと github_api_error + shelf 残骸', async () => {
    setupQuarantine('owner--repo');
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.includes('/contents/.claude-plugin/marketplace.json') && (!init?.method || init.method === 'GET')) {
        return res(404, { message: 'Not Found' });
      }
      if (url.includes('/git/ref/heads/main')) return res(200, { object: { sha: 'base-commit-sha' } });
      if (url.match(/\/git\/commits\/[a-z0-9-]+$/) && (!init?.method || init.method === 'GET'))
        return res(200, { tree: { sha: 'base-tree-sha' } });
      if (url.endsWith('/git/blobs') && init?.method === 'POST') return res(201, { sha: 'blob-x' });
      if (url.endsWith('/git/trees') && init?.method === 'POST') return res(201, { sha: 'new-tree-sha' });
      if (url.endsWith('/git/commits') && init?.method === 'POST') return res(201, { sha: 'new-commit-sha' });
      if (url.endsWith('/git/refs') && init?.method === 'POST') {
        return res(422, { message: 'Reference already exists' });
      }
      throw new Error(`unexpected: ${init?.method ?? 'GET'} ${url}`);
    });
    const result = await shelve(
      { biblioName: 'owner--repo', category: 'biblio-dev', reason: 'test' },
      { quarantineRoot: path.join(TEST_DIR, 'quarantine'), shelfRoot: path.join(TEST_DIR, 'shelf') },
    );
    expect(result).toMatchObject({
      ok: false,
      reason: 'github_api_error',
      detail: expect.stringContaining('status=422'),
    });
    // rename + blob/tree/commit 完了済 = shelf に残骸が残る
    expect(fs.existsSync(path.join(TEST_DIR, 'shelf', 'biblio-dev', 'owner--repo'))).toBe(true);
    expect(fs.existsSync(path.join(TEST_DIR, 'quarantine', 'owner--repo'))).toBe(false);
  });

  it('POST pulls が 422 (Validation Failed) を返すと github_api_error', async () => {
    setupQuarantine('owner--repo');
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.includes('/contents/.claude-plugin/marketplace.json') && (!init?.method || init.method === 'GET')) {
        return res(404, { message: 'Not Found' });
      }
      if (url.includes('/git/ref/heads/main')) return res(200, { object: { sha: 'base-commit-sha' } });
      if (url.match(/\/git\/commits\/[a-z0-9-]+$/) && (!init?.method || init.method === 'GET'))
        return res(200, { tree: { sha: 'base-tree-sha' } });
      if (url.endsWith('/git/blobs') && init?.method === 'POST') return res(201, { sha: 'blob-x' });
      if (url.endsWith('/git/trees') && init?.method === 'POST') return res(201, { sha: 'new-tree-sha' });
      if (url.endsWith('/git/commits') && init?.method === 'POST') return res(201, { sha: 'new-commit-sha' });
      if (url.endsWith('/git/refs') && init?.method === 'POST') return res(201, { ref: 'refs/heads/...' });
      if (url.endsWith('/pulls') && init?.method === 'POST') {
        return res(422, { message: 'Validation Failed' });
      }
      throw new Error(`unexpected: ${init?.method ?? 'GET'} ${url}`);
    });
    const result = await shelve(
      { biblioName: 'owner--repo', category: 'biblio-dev', reason: 'test' },
      { quarantineRoot: path.join(TEST_DIR, 'quarantine'), shelfRoot: path.join(TEST_DIR, 'shelf') },
    );
    expect(result).toMatchObject({
      ok: false,
      reason: 'github_api_error',
      detail: expect.stringContaining('status=422'),
    });
  });
});

/**
 * `rename_error` 分類の到達テスト。
 *
 * `ShelveFailureReason` に定義されているのに既存テストで到達経路が未カバー = 死に分岐
 * になっていた。`fs.promises.rename` を spy で reject させて分類を固定する。将来 rename
 * 周辺をリファクタしてもこの分岐が消えたことを CI で検知できる。
 */
describe('shelve — rename_error (fs.promises.rename 失敗)', () => {
  it('rename が EACCES で reject すると rename_error 分類で返る (= 重複検知通過後、blob 走査前)', async () => {
    setupQuarantine('owner--repo');
    // 重複検知は通る (marketplace 404)、その後 rename で reject させる
    fetchMock.mockImplementationOnce(async () => res(404, { message: 'Not Found' }));
    const renameSpy = vi
      .spyOn(fs.promises, 'rename')
      .mockRejectedValueOnce(
        Object.assign(new Error('EACCES: permission denied, rename to shelf'), { code: 'EACCES' }),
      );
    const result = await shelve(
      { biblioName: 'owner--repo', category: 'biblio-dev', reason: 'test' },
      { quarantineRoot: path.join(TEST_DIR, 'quarantine'), shelfRoot: path.join(TEST_DIR, 'shelf') },
    );
    expect(renameSpy).toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      reason: 'rename_error',
      detail: expect.stringContaining('EACCES'),
    });
    // rename 失敗 = quarantine は残り、shelf は作られない
    expect(fs.existsSync(path.join(TEST_DIR, 'quarantine', 'owner--repo'))).toBe(true);
    expect(fs.existsSync(path.join(TEST_DIR, 'shelf', 'biblio-dev', 'owner--repo'))).toBe(false);
    renameSpy.mockRestore();
  });
});

/**
 * Phase 4 — multi-category-shelve のユニットテスト。
 *
 * shelveMulti は単一 shelve の汎化 = N 件の (biblioName, category, reason) を 1 PR に
 * まとめる。N=1 では既存 shelve と branch 名 / commit message / PR body / PR title が
 * 完全互換に保たれる (= 上の 12 tests + verify-m2 で確認)。本セクションでは N>1 の
 * 経路と原子性 (= 部分成功なし) を網羅する。
 */

/**
 * multi-skill quarantine fixture を作る (3 skill / 各 SKILL.md + plugin.json)。
 * 戻り値: 3 件の (biblioName, category) ペア (= shelveMulti の reqs にそのまま流す)。
 */
function setupMultiQuarantine(): Array<{ biblioName: string; category: 'biblio-dev' | 'biblio-art'; reason: string }> {
  setupQuarantine('owner--repo--skill-a');
  setupQuarantine('owner--repo--skill-b');
  setupQuarantine('owner--repo--skill-c');
  return [
    { biblioName: 'owner--repo--skill-a', category: 'biblio-dev', reason: 'TS refactor 補助' },
    { biblioName: 'owner--repo--skill-b', category: 'biblio-dev', reason: 'コードレビュー支援' },
    { biblioName: 'owner--repo--skill-c', category: 'biblio-art', reason: '図版生成プロンプト' },
  ];
}

/** tree push 時に body を捕える sink (= test 側で path 配列を assert するため)。 */
type TreeSink = { body: Record<string, unknown> | null };

/**
 * multi 経路の happy path 用 fetch handler。tree push の body を引数 sink に記録する
 * (= 後で path 配列の assert に使う)。
 */
function setupHappyPathMulti(
  opts: {
    marketplaceExists?: boolean;
    treeSink?: TreeSink;
    prNumber?: number;
  } = {},
): void {
  const { marketplaceExists = false, treeSink, prNumber = 100 } = opts;
  let blobIndex = 0;
  fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    if (url.includes('/contents/.claude-plugin/marketplace.json') && (!init?.method || init.method === 'GET')) {
      return marketplaceExists
        ? res(200, { content: marketplaceContent([]), encoding: 'base64', sha: 'mp-sha' })
        : res(404, { message: 'Not Found' });
    }
    if (url.includes('/git/ref/heads/main')) return res(200, { object: { sha: 'base-commit-sha' } });
    if (url.match(/\/git\/commits\/[a-z0-9-]+$/) && (!init?.method || init.method === 'GET'))
      return res(200, { tree: { sha: 'base-tree-sha' } });
    if (url.endsWith('/git/blobs') && init?.method === 'POST') {
      blobIndex++;
      return res(201, { sha: `blob-sha-${blobIndex}` });
    }
    if (url.endsWith('/git/trees') && init?.method === 'POST') {
      if (treeSink) treeSink.body = init?.body ? JSON.parse(init.body) : null;
      return res(201, { sha: 'new-tree-sha' });
    }
    if (url.endsWith('/git/commits') && init?.method === 'POST') return res(201, { sha: 'new-commit-sha' });
    if (url.endsWith('/git/refs') && init?.method === 'POST') return res(201, { ref: 'refs/heads/...' });
    if (url.endsWith('/pulls') && init?.method === 'POST') {
      return res(201, {
        html_url: `https://github.com/HajimariInc/biblio-shelf/pull/${prNumber}`,
        number: prNumber,
      });
    }
    throw new Error(`unexpected: ${init?.method ?? 'GET'} ${url}`);
  });
}

describe('shelveMulti — multi-category 跨ぎ happy path', () => {
  // 3 skill × (SKILL.md + plugin.json) = 6 blob + marketplace 1 blob = 7 × GH_BLOB_SLEEP_MS (1000ms)
  // → 約 7 秒 (= デフォルト 5s timeout 超過)。30s に明示拡張。
  it('3 skill / 2 category 跨ぎで 1 PR に陳列され、tree に両 category の path が含まれる', async () => {
    const reqs = setupMultiQuarantine();
    const treeSink: TreeSink = { body: null };
    setupHappyPathMulti({ treeSink });

    const result = await shelveMulti(reqs, {
      quarantineRoot: path.join(TEST_DIR, 'quarantine'),
      shelfRoot: path.join(TEST_DIR, 'shelf'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok=true');
    expect(result.items).toHaveLength(3);
    expect(result.items).toEqual([
      { biblioName: 'owner--repo--skill-a', category: 'biblio-dev' },
      { biblioName: 'owner--repo--skill-b', category: 'biblio-dev' },
      { biblioName: 'owner--repo--skill-c', category: 'biblio-art' },
    ]);
    expect(result.branchName).toMatch(/^shelve\/multi-owner--repo-\d+$/);
    expect(result.prUrl).toContain('/pull/100');

    // tree push の path 配列が両 category dir を含んでいる (= 複数 cat 跨ぎ陳列の証跡)
    expect(treeSink.body).not.toBeNull();
    const treeArr = (treeSink.body?.tree ?? []) as Array<{ path: string }>;
    const treePaths = treeArr.map((e) => e.path);
    expect(treePaths.some((p) => p.startsWith('biblio-dev/owner--repo--skill-a/'))).toBe(true);
    expect(treePaths.some((p) => p.startsWith('biblio-dev/owner--repo--skill-b/'))).toBe(true);
    expect(treePaths.some((p) => p.startsWith('biblio-art/owner--repo--skill-c/'))).toBe(true);
    expect(treePaths).toContain('.claude-plugin/marketplace.json');

    // per-req 物理移動: 3 件すべて shelf へ移動済 (quarantine から消える)
    for (const req of reqs) {
      expect(fs.existsSync(path.join(TEST_DIR, 'quarantine', req.biblioName))).toBe(false);
      expect(fs.existsSync(path.join(TEST_DIR, 'shelf', req.category, req.biblioName))).toBe(true);
    }
  }, 30_000);
});

describe('shelveMulti — 入口 validation', () => {
  it('空配列 → empty_items', async () => {
    const result = await shelveMulti([], {
      quarantineRoot: path.join(TEST_DIR, 'quarantine'),
      shelfRoot: path.join(TEST_DIR, 'shelf'),
    });
    expect(result).toMatchObject({ ok: false, reason: 'empty_items' });
    // 何も fetch しない
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('重複 biblioName → duplicate_biblio_name (pre-flight fail、何も fetch しない)', async () => {
    const result = await shelveMulti(
      [
        { biblioName: 'owner--repo--dup', category: 'biblio-dev', reason: 'r1' },
        { biblioName: 'owner--repo--dup', category: 'biblio-art', reason: 'r2' },
      ],
      { quarantineRoot: path.join(TEST_DIR, 'quarantine'), shelfRoot: path.join(TEST_DIR, 'shelf') },
    );
    expect(result).toMatchObject({ ok: false, reason: 'duplicate_biblio_name' });
    expect(fetchMock).not.toHaveBeenCalled();
    // debug 用 items が全件含まれる
    if (!result.ok) {
      expect(result.items).toHaveLength(2);
    }
  });
});

describe('shelveMulti — 原子性 (1 件失敗で全体 fail、部分成功なし)', () => {
  it('3 件中 1 件が marketplace で重複検知に引っかかれば全体 already_shelved (rename しない)', async () => {
    const reqs = setupMultiQuarantine();
    // marketplace.json に skill-b の entry が既存
    fetchMock.mockImplementationOnce(async () =>
      res(200, {
        content: marketplaceContent([{ name: 'owner--repo--skill-b' }]),
        encoding: 'base64',
        sha: 'mp-sha',
      }),
    );
    const result = await shelveMulti(reqs, {
      quarantineRoot: path.join(TEST_DIR, 'quarantine'),
      shelfRoot: path.join(TEST_DIR, 'shelf'),
    });
    expect(result).toMatchObject({ ok: false, reason: 'already_shelved' });
    // 重複検知だけで終わる → fetch は 1 回のみ
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 全 quarantine が温存される (= 部分 rename なし)
    for (const req of reqs) {
      expect(fs.existsSync(path.join(TEST_DIR, 'quarantine', req.biblioName))).toBe(true);
      expect(fs.existsSync(path.join(TEST_DIR, 'shelf', req.category, req.biblioName))).toBe(false);
    }
  });

  it('合算 fileCount > MAX_BLOBS_PER_PR で fail-closed (= github_api_error + 合算件数を detail に)', async () => {
    // setupQuarantine は SKILL.md + plugin.json の 2 ファイルを置く。
    // 50 件追加すると per-biblio 52 ファイル、2 biblio で合算 104 ファイル (= 上限 100 超)。
    for (const name of ['owner--repo--a', 'owner--repo--b']) {
      setupQuarantine(name);
      const qDir = path.join(TEST_DIR, 'quarantine', name);
      for (let i = 0; i < 50; i++) {
        fs.writeFileSync(path.join(qDir, `extra-${i}.txt`), 'x');
      }
    }
    // marketplace 404 → 重複検知通過、rename して合算 file count で落ちる経路
    fetchMock.mockImplementationOnce(async () => res(404, { message: 'Not Found' }));

    const result = await shelveMulti(
      [
        { biblioName: 'owner--repo--a', category: 'biblio-dev', reason: 'r1' },
        { biblioName: 'owner--repo--b', category: 'biblio-dev', reason: 'r2' },
      ],
      { quarantineRoot: path.join(TEST_DIR, 'quarantine'), shelfRoot: path.join(TEST_DIR, 'shelf') },
    );
    expect(result).toMatchObject({
      ok: false,
      reason: 'github_api_error',
      detail: expect.stringContaining('合算'),
    });
    if (!result.ok) {
      expect(result.detail).toContain('104');
      expect(result.detail).toContain('100');
    }
  });

  it('2 件目の rename が EACCES で reject すると全体 rename_error + 1 件目残骸を detail に列挙', async () => {
    setupQuarantine('owner--repo--first');
    setupQuarantine('owner--repo--second');
    // marketplace 404
    fetchMock.mockImplementationOnce(async () => res(404, { message: 'Not Found' }));
    // 1 回目 rename は本物 (= 1 件目を実際に shelf へ移動)、2 回目で EACCES。
    // spy をかける前に元 fn を bind 経由で握っておく (= mock 内で本物を再帰呼出するため)。
    const originalRename = fs.promises.rename.bind(fs.promises);
    let renameCount = 0;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (src: fs.PathLike, dst: fs.PathLike) => {
      renameCount++;
      if (renameCount === 1) {
        return originalRename(src, dst);
      }
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });

    const result = await shelveMulti(
      [
        { biblioName: 'owner--repo--first', category: 'biblio-dev', reason: 'r1' },
        { biblioName: 'owner--repo--second', category: 'biblio-art', reason: 'r2' },
      ],
      { quarantineRoot: path.join(TEST_DIR, 'quarantine'), shelfRoot: path.join(TEST_DIR, 'shelf') },
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'rename_error',
      detail: expect.stringContaining('EACCES'),
    });
    // detail に 1 件目の shelf 残骸 path が列挙される (= 運用者が rm -rf できる)
    if (!result.ok) {
      expect(result.detail).toContain('既に shelf に移動済の残骸');
    }
    // 1 件目は実際に移動済 (= shelf 残骸残置)
    expect(fs.existsSync(path.join(TEST_DIR, 'shelf', 'biblio-dev', 'owner--repo--first'))).toBe(true);
    renameSpy.mockRestore();
  });
});

describe('shelveMulti — single 経路 (reqs.length === 1) で既存 shelve と完全互換', () => {
  // POST /pulls と POST /git/commits の body を捕える sink。
  // PR title / commit message / PR body の互換性を 1 つのテストで固定する
  // (= reqs.length === 1 分岐の回帰を verify-m2 (実 API) に頼らず unit で検知)。
  type CompatSink = { pullsBody: Record<string, unknown> | null; commitBody: Record<string, unknown> | null };

  function setupCompatFetchMock(sink: CompatSink, prNumber = 7): void {
    let blobIndex = 0;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (url.includes('/contents/.claude-plugin/marketplace.json') && (!init?.method || init.method === 'GET')) {
        return res(404, { message: 'Not Found' });
      }
      if (url.includes('/git/ref/heads/main')) return res(200, { object: { sha: 'base-commit-sha' } });
      if (url.match(/\/git\/commits\/[a-z0-9-]+$/) && (!init?.method || init.method === 'GET'))
        return res(200, { tree: { sha: 'base-tree-sha' } });
      if (url.endsWith('/git/blobs') && init?.method === 'POST') {
        blobIndex++;
        return res(201, { sha: `blob-sha-${blobIndex}` });
      }
      if (url.endsWith('/git/trees') && init?.method === 'POST') return res(201, { sha: 'new-tree-sha' });
      if (url.endsWith('/git/commits') && init?.method === 'POST') {
        sink.commitBody = init?.body ? JSON.parse(init.body) : null;
        return res(201, { sha: 'new-commit-sha' });
      }
      if (url.endsWith('/git/refs') && init?.method === 'POST') return res(201, { ref: 'refs/heads/...' });
      if (url.endsWith('/pulls') && init?.method === 'POST') {
        sink.pullsBody = init?.body ? JSON.parse(init.body) : null;
        return res(201, {
          html_url: `https://github.com/HajimariInc/biblio-shelf/pull/${prNumber}`,
          number: prNumber,
        });
      }
      throw new Error(`unexpected: ${init?.method ?? 'GET'} ${url}`);
    });
  }

  it('reqs.length === 1 で branch 名 / PR title / commit message が既存単一 shelve 形式を維持', async () => {
    setupQuarantine('owner--repo');
    const sink: CompatSink = { pullsBody: null, commitBody: null };
    setupCompatFetchMock(sink);

    const result = await shelveMulti([{ biblioName: 'owner--repo', category: 'biblio-dev', reason: 'compat check' }], {
      quarantineRoot: path.join(TEST_DIR, 'quarantine'),
      shelfRoot: path.join(TEST_DIR, 'shelf'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok=true');

    // branch 名が既存形式 (= verify-m2 で実 PR が立つときの命名と一致)
    expect(result.branchName).toBe('shelve/biblio-dev--owner--repo');

    // PR title が既存形式 `shelve(<cat>): <name>` (multi 経路 `shelve(multi): N biblios ...` ではない)
    expect(sink.pullsBody).not.toBeNull();
    expect(sink.pullsBody?.title).toBe('shelve(biblio-dev): owner--repo');
    // PR body が single 形式 (= 「## 陳列対象」見出し、「## カテゴリ別内訳」は multi 専用)
    const prBody = sink.pullsBody?.body as string;
    expect(prBody).toContain('## 陳列対象');
    expect(prBody).toContain('- biblio: `owner--repo`');
    expect(prBody).toContain('- category: `biblio-dev`');
    expect(prBody).not.toContain('カテゴリ別内訳'); // multi 専用見出しが混入しない

    // commit message が既存形式 `feat(<cat>): shelve <name>` (multi `feat(multi):` ではない)
    expect(sink.commitBody).not.toBeNull();
    const commitMsg = sink.commitBody?.message as string;
    expect(commitMsg).toMatch(/^feat\(biblio-dev\): shelve owner--repo\n/);
    expect(commitMsg).toContain('カテゴリ判定: biblio-dev');
    expect(commitMsg).toContain('理由: compat check');
    expect(commitMsg).not.toMatch(/^feat\(multi\)/); // multi 専用先頭が混入しない
  });
});
