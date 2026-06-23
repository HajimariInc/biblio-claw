/**
 * 仕入れの決定的ロジックのユニットテスト。
 *
 * - normalizeRepo: 各入力形式 + 不正入力
 * - acquire: ghFetch (= shelf-gh) を mock + git の spawnSync を mock し 6 分岐
 *   (ghFetch 404 / 5xx / network error / 成功 → さらに clone失敗 / manifest不在 / 成功)
 * - getChildProcEnv: initHostProxy 後に proxy env + CA が乗ること
 *
 * fs は /tmp の実ディレクトリ (DATA_DIR を mock で TEST_DIR に差し替え)、
 * child_process / shelf-gh / log / secret provider は mock。circuit-breaker.test.ts を踏襲。
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vi.hoisted は import より前に走るため module import を使えない。circuit-breaker.test.ts は
// require() で os/path を引くが、本ファイルは lint (no-require-imports) を避けるため
// グローバルの process.pid で衝突回避した tmp パスを直接組む (Linux/Mac は /tmp 前提)。
const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/biblio-acquire-test-${process.pid}` }));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// secret provider は getChildProcEnv テストでのみ使う。テストごとに差し替え可能にする。
const mockEnsureAgent = vi.fn();
const mockGetProxyConfig = vi.fn();
vi.mock('../adapters/secret/index.js', () => ({
  getSecretProvider: () => ({ ensureAgent: mockEnsureAgent, getProxyConfig: mockGetProxyConfig }),
}));

// child_process.spawnSync は git clone 経路で残るため引き続き mock。
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

// shelf-gh.ts の ghFetch のみ override。GhHttpError は実物を使う (= acquire.ts 内の
// `err instanceof GhHttpError` 検査が壊れないようにする = shelve.test.ts の流儀)。
vi.mock('./shelf-gh.js', async () => {
  const actual = await vi.importActual<typeof import('./shelf-gh.js')>('./shelf-gh.js');
  return { ...actual, ghFetch: vi.fn() };
});

import { spawnSync } from 'node:child_process';
import { log } from '../log.js';
import { normalizeRepo, acquire } from './acquire.js';
import { getChildProcEnv, initHostProxy, _resetHostProxyForTesting } from './host-proxy.js';
import { GhHttpError, ghFetch } from './shelf-gh.js';

const mockSpawn = vi.mocked(spawnSync);
const mockGhFetch = vi.mocked(ghFetch);
const QUARANTINE = path.join(TEST_DIR, 'quarantine');

/** spawnSync 戻り値のヘルパ (encoding:'utf-8' なので stdout/stderr は string)。 */
function spawnResult(status: number, stderr = ''): ReturnType<typeof spawnSync> {
  return { status, stdout: '', stderr, pid: 1, output: [], signal: null } as unknown as ReturnType<typeof spawnSync>;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  mockSpawn.mockReset();
  mockGhFetch.mockReset();
  // 既定で存在確認は成功扱い (= 200 OK の repo metadata 相当)。各 test で個別 reject 上書き可。
  mockGhFetch.mockResolvedValue({ full_name: 'octocat/hello' });
  mockEnsureAgent.mockReset();
  mockGetProxyConfig.mockReset();
  _resetHostProxyForTesting();
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('normalizeRepo', () => {
  it('owner/repo 短縮形を受理する', () => {
    expect(normalizeRepo('octocat/hello')).toEqual({
      owner: 'octocat',
      name: 'hello',
      cloneUrl: 'https://github.com/octocat/hello.git',
    });
  });

  it('フル URL を受理する', () => {
    expect(normalizeRepo('https://github.com/octocat/hello')).toEqual({
      owner: 'octocat',
      name: 'hello',
      cloneUrl: 'https://github.com/octocat/hello.git',
    });
  });

  it('末尾 .git を吸収する', () => {
    expect(normalizeRepo('https://github.com/octocat/hello.git')?.name).toBe('hello');
    expect(normalizeRepo('octocat/hello.git')?.name).toBe('hello');
  });

  it('末尾 / と前後空白を吸収する', () => {
    expect(normalizeRepo('  octocat/hello/  ')?.owner).toBe('octocat');
    expect(normalizeRepo('https://github.com/octocat/hello/')?.name).toBe('hello');
  });

  it('scheme なし github.com URL を受理する', () => {
    expect(normalizeRepo('github.com/octocat/hello')?.cloneUrl).toBe('https://github.com/octocat/hello.git');
  });

  it.each([
    ['空文字', ''],
    ['空白のみ', '   '],
    ['セグメント過多', 'owner/repo/extra'],
    ['セグメント不足', 'just-owner'],
    ['内部スペース', 'own er/repo'],
    ['github 以外の URL', 'https://gitlab.com/owner/repo'],
    ['不正文字', 'owner/re;po'],
  ])('不正入力を null にする: %s', (_label, input) => {
    expect(normalizeRepo(input)).toBeNull();
  });
});

describe('acquire', () => {
  it('不正入力で invalid_input を返す (ghFetch を呼ばない)', async () => {
    const result = await acquire({ repo: 'not a repo/x/y' });
    expect(result).toEqual({ ok: false, reason: 'invalid_input', detail: expect.any(String) });
    expect(mockGhFetch).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('ghFetch 404 で not_found を返す (= repo 不在 or private)', async () => {
    mockGhFetch.mockRejectedValue(new GhHttpError('acquire.check-repo', 404, '{"message":"Not Found"}'));
    const result = await acquire({ repo: 'octocat/missing' });
    expect(result).toMatchObject({ ok: false, reason: 'not_found' });
    if (result.ok === false) {
      expect(result.detail).toMatch(/repo が見つかりません/);
    }
    // 後続の git clone は実行されない (= 1 回も spawnSync が呼ばれない)。
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('ghFetch 5xx で internal を返す (= GitHub 障害 / proxy 経路の問題)', async () => {
    mockGhFetch.mockRejectedValue(new GhHttpError('acquire.check-repo', 503, '{"message":"Service Unavailable"}'));
    const result = await acquire({ repo: 'octocat/hello' });
    expect(result).toMatchObject({ ok: false, reason: 'internal' });
    if (result.ok === false) {
      expect(result.detail).toMatch(/GitHub API エラー/);
      expect(result.detail).toMatch(/status=503/);
    }
    expect(mockSpawn).not.toHaveBeenCalled();
    // silent failure 防止のため log.error で出る (warn ではなく)。
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      'acquire: GitHub API error',
      expect.objectContaining({ reason: 'internal', status: 503 }),
    );
  });

  it('ghFetch が network エラー (= 非 GhHttpError) で throw したら internal を返す', async () => {
    mockGhFetch.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));
    const result = await acquire({ repo: 'octocat/hello' });
    expect(result).toMatchObject({ ok: false, reason: 'internal' });
    if (result.ok === false) {
      expect(result.detail).toMatch(/GitHub API への接続に失敗/);
      expect(result.detail).toMatch(/ECONNREFUSED/);
    }
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      'acquire: fetch error',
      expect.objectContaining({ reason: 'internal' }),
    );
  });

  it('clone 失敗で clone_failed を返し quarantine を残さない', async () => {
    mockSpawn.mockImplementation((cmd) => spawnResult(cmd === 'git' ? 128 : 0, cmd === 'git' ? 'fatal: clone' : ''));
    const result = await acquire({ repo: 'octocat/hello' });
    expect(result).toMatchObject({ ok: false, reason: 'clone_failed' });
    expect(fs.existsSync(path.join(QUARANTINE, 'octocat--hello'))).toBe(false);
  });

  it('clone 成功だが manifest 不在で manifest_missing を返し quarantine を削除する', async () => {
    mockSpawn.mockImplementation((_cmd, args) => {
      // git clone: 空ディレクトリだけ作る (manifest なし)
      const dest = (args as string[])[4];
      fs.mkdirSync(path.join(dest, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dest, 'README.md'), '# no manifest');
      return spawnResult(0);
    });
    const result = await acquire({ repo: 'octocat/hello' });
    expect(result).toMatchObject({ ok: false, reason: 'manifest_missing' });
    expect(fs.existsSync(path.join(QUARANTINE, 'octocat--hello'))).toBe(false);
  });

  it('marketplace.json 有りで成功する', async () => {
    mockSpawn.mockImplementation((_cmd, args) => {
      const dest = (args as string[])[4];
      fs.mkdirSync(path.join(dest, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(dest, '.claude-plugin', 'marketplace.json'), '{}');
      return spawnResult(0);
    });
    const result = await acquire({ repo: 'octocat/hello' });
    expect(result).toEqual({
      ok: true,
      biblioName: 'octocat--hello',
      quarantinePath: path.join(QUARANTINE, 'octocat--hello'),
    });
    expect(fs.existsSync(path.join(QUARANTINE, 'octocat--hello', '.claude-plugin', 'marketplace.json'))).toBe(true);
    // ghFetch が GET /repos/octocat/hello で 1 回呼ばれている。
    expect(mockGhFetch).toHaveBeenCalledWith('acquire.check-repo', expect.stringMatching(/\/repos\/octocat\/hello$/));
  });

  it('ネストした SKILL.md だけでも成功する', async () => {
    mockSpawn.mockImplementation((_cmd, args) => {
      const dest = (args as string[])[4];
      const deep = path.join(dest, 'plugins', 'sample', 'skills', 'sample');
      fs.mkdirSync(deep, { recursive: true });
      fs.writeFileSync(path.join(deep, 'SKILL.md'), '# skill');
      return spawnResult(0);
    });
    const result = await acquire({ repo: 'octocat/hello' });
    expect(result).toMatchObject({ ok: true, biblioName: 'octocat--hello' });
  });

  it('既存 quarantine を冪等に上書きする (再取得)', async () => {
    const dest = path.join(QUARANTINE, 'octocat--hello');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'stale.txt'), 'old');
    mockSpawn.mockImplementation((_cmd, args) => {
      const d = (args as string[])[4];
      fs.mkdirSync(path.join(d, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(d, '.claude-plugin', 'marketplace.json'), '{}');
      return spawnResult(0);
    });
    const result = await acquire({ repo: 'octocat/hello' });
    expect(result).toMatchObject({ ok: true });
    // 旧ファイルは消えている (上書き前に削除された)
    expect(fs.existsSync(path.join(dest, 'stale.txt'))).toBe(false);
  });
});

describe('getChildProcEnv / initHostProxy', () => {
  it('proxy 未初期化なら proxy env を含まない', () => {
    const env = getChildProcEnv();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.GIT_SSL_CAINFO).toBeUndefined();
  });

  it('initHostProxy 後に HTTPS_PROXY (127.0.0.1 へ rewrite) と CA 経路が乗る', async () => {
    mockEnsureAgent.mockResolvedValue({ created: true });
    mockGetProxyConfig.mockResolvedValue({
      env: { HTTPS_PROXY: 'http://tok@host.docker.internal:10255' },
      caCertificate: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
      caCertificateContainerPath: '/tmp/x.pem',
    });
    await initHostProxy();
    const env = getChildProcEnv();
    expect(env.HTTPS_PROXY).toBe('http://tok@127.0.0.1:10255');
    expect(env.GIT_SSL_CAINFO).toBe(path.join(TEST_DIR, '.onecli-host-ca.pem'));
    expect(env.SSL_CERT_FILE).toBe(path.join(TEST_DIR, '.onecli-host-ca.pem'));
    expect(fs.existsSync(path.join(TEST_DIR, '.onecli-host-ca.pem'))).toBe(true);
  });

  it('OneCLI 到達不可 (ensureAgent throw) でも fail-open し proxy なし env を返す', async () => {
    mockEnsureAgent.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(initHostProxy()).resolves.toBeUndefined();
    expect(getChildProcEnv().HTTPS_PROXY).toBeUndefined();
  });

  it('CA なし (proxy のみ) なら GIT_SSL_CAINFO / SSL_CERT_FILE を設定しない', async () => {
    mockEnsureAgent.mockResolvedValue({ created: true });
    mockGetProxyConfig.mockResolvedValue({
      env: { HTTPS_PROXY: 'http://tok@host.docker.internal:10255' },
      caCertificate: undefined,
    });
    await initHostProxy();
    const env = getChildProcEnv();
    expect(env.HTTPS_PROXY).toBe('http://tok@127.0.0.1:10255');
    expect(env.GIT_SSL_CAINFO).toBeUndefined();
    expect(env.SSL_CERT_FILE).toBeUndefined();
    expect(fs.existsSync(path.join(TEST_DIR, '.onecli-host-ca.pem'))).toBe(false);
  });

  it('想定外 proxy ホスト形式 (host.docker.internal 不在) はそのまま素通しして warn する', async () => {
    mockEnsureAgent.mockResolvedValue({ created: true });
    mockGetProxyConfig.mockResolvedValue({
      env: { HTTPS_PROXY: 'http://127.0.0.1:10255' }, // SDK が将来 localhost を返す想定
      caCertificate: undefined,
    });
    await initHostProxy();
    expect(getChildProcEnv().HTTPS_PROXY).toBe('http://127.0.0.1:10255'); // 素通し
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('unexpected proxy host format'),
      expect.objectContaining({ value: 'http://127.0.0.1:10255' }),
    );
  });
});
