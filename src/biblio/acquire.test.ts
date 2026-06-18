/**
 * 仕入れの決定的ロジックのユニットテスト。
 *
 * - normalizeRepo: 各入力形式 + 不正入力
 * - acquire: gh/git の spawnSync を mock し 4 分岐 (404 / clone失敗 / manifest不在 / 成功)
 * - getChildProcEnv: initHostProxy 後に proxy env + CA が乗ること
 *
 * fs は /tmp の実ディレクトリ (DATA_DIR を mock で TEST_DIR に差し替え)、
 * child_process / log / secret provider は mock。circuit-breaker.test.ts を踏襲。
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

// child_process.spawnSync を mock。テストごとに mockImplementation を差し替える。
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

import { spawnSync } from 'node:child_process';
import { log } from '../log.js';
import { normalizeRepo, acquire } from './acquire.js';
import { getChildProcEnv, initHostProxy, _resetHostProxyForTesting } from './host-proxy.js';

const mockSpawn = vi.mocked(spawnSync);
const QUARANTINE = path.join(TEST_DIR, 'quarantine');

/** spawnSync 戻り値のヘルパ (encoding:'utf-8' なので stdout/stderr は string)。 */
function spawnResult(status: number, stderr = ''): ReturnType<typeof spawnSync> {
  return { status, stdout: '', stderr, pid: 1, output: [], signal: null } as unknown as ReturnType<typeof spawnSync>;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  mockSpawn.mockReset();
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
  it('不正入力で invalid_input を返す (gh を呼ばない)', async () => {
    const result = await acquire({ repo: 'not a repo/x/y' });
    expect(result).toEqual({ ok: false, reason: 'invalid_input', detail: expect.any(String) });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('gh 404 で not_found を返す', async () => {
    mockSpawn.mockImplementation((cmd) => spawnResult(cmd === 'gh' ? 1 : 0, 'HTTP 404'));
    const result = await acquire({ repo: 'octocat/missing' });
    expect(result).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('clone 失敗で clone_failed を返し quarantine を残さない', async () => {
    mockSpawn.mockImplementation((cmd) => spawnResult(cmd === 'gh' ? 0 : 128, cmd === 'git' ? 'fatal: clone' : ''));
    const result = await acquire({ repo: 'octocat/hello' });
    expect(result).toMatchObject({ ok: false, reason: 'clone_failed' });
    expect(fs.existsSync(path.join(QUARANTINE, 'hello'))).toBe(false);
  });

  it('clone 成功だが manifest 不在で manifest_missing を返し quarantine を削除する', async () => {
    mockSpawn.mockImplementation((cmd, args) => {
      if (cmd === 'gh') return spawnResult(0);
      // git clone: 空ディレクトリだけ作る (manifest なし)
      const dest = (args as string[])[4];
      fs.mkdirSync(path.join(dest, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dest, 'README.md'), '# no manifest');
      return spawnResult(0);
    });
    const result = await acquire({ repo: 'octocat/hello' });
    expect(result).toMatchObject({ ok: false, reason: 'manifest_missing' });
    expect(fs.existsSync(path.join(QUARANTINE, 'hello'))).toBe(false);
  });

  it('marketplace.json 有りで成功する', async () => {
    mockSpawn.mockImplementation((cmd, args) => {
      if (cmd === 'gh') return spawnResult(0);
      const dest = (args as string[])[4];
      fs.mkdirSync(path.join(dest, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(dest, '.claude-plugin', 'marketplace.json'), '{}');
      return spawnResult(0);
    });
    const result = await acquire({ repo: 'octocat/hello' });
    expect(result).toEqual({ ok: true, biblioName: 'hello', quarantinePath: path.join(QUARANTINE, 'hello') });
    expect(fs.existsSync(path.join(QUARANTINE, 'hello', '.claude-plugin', 'marketplace.json'))).toBe(true);
  });

  it('ネストした SKILL.md だけでも成功する', async () => {
    mockSpawn.mockImplementation((cmd, args) => {
      if (cmd === 'gh') return spawnResult(0);
      const dest = (args as string[])[4];
      const deep = path.join(dest, 'plugins', 'sample', 'skills', 'sample');
      fs.mkdirSync(deep, { recursive: true });
      fs.writeFileSync(path.join(deep, 'SKILL.md'), '# skill');
      return spawnResult(0);
    });
    const result = await acquire({ repo: 'octocat/hello' });
    expect(result).toMatchObject({ ok: true, biblioName: 'hello' });
  });

  it('既存 quarantine を冪等に上書きする (再取得)', async () => {
    const dest = path.join(QUARANTINE, 'hello');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'stale.txt'), 'old');
    mockSpawn.mockImplementation((cmd, args) => {
      if (cmd === 'gh') return spawnResult(0);
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
