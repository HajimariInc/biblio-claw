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

// Phase 2: readEnvFile を mock — `vi.stubEnv` は `.env` ファイル読み取りに効かない (key が `.env`
// に書かれていると process.env fallback がスキップされる) ため、確実性のため readEnvFile 自体を
// 差し替える。デフォルトは空 object (= ACQUIRE_SKILL_THRESHOLD 未設定 = default 10)。
// `vi.mock` は import より前に hoist されるため、receiver は `vi.hoisted` 経由で初期化する
// (= TEST_DIR と同じパターン)。
const { mockReadEnvFile } = vi.hoisted(() => {
  // 空 object を返す default を hoist 時に立てる。`src/config.ts` はモジュール load 時に
  // `readEnvFile([...]).ASSISTANT_NAME` 等を呼ぶため、戻り値が undefined だと TypeError で死ぬ。
  const fn = vi.fn<(keys: string[]) => Record<string, string>>();
  fn.mockReturnValue({});
  return { mockReadEnvFile: fn };
});
vi.mock('../env.js', () => ({
  readEnvFile: (keys: string[]) => mockReadEnvFile(keys),
}));

// 個別 PRD Phase 5: getBiblioSetting を mock — `resolveSkillThreshold` の 3 層
// (DB → env → DEFAULT) 解決経路を test で制御するため、DB 層を関数差し替えで切り離す。
// in-memory DB を本 test ファイルで持ち回らないことで、acquire の振る舞いに集中する
// (= DB 層の機械的 CRUD は `db/biblio-settings.test.ts` で固める分業)。
const { mockGetBiblioSetting } = vi.hoisted(() => {
  const fn = vi.fn<(key: string) => string | undefined>();
  fn.mockReturnValue(undefined);
  return { mockGetBiblioSetting: fn };
});
vi.mock('../db/biblio-settings.js', () => ({
  getBiblioSetting: (key: string) => mockGetBiblioSetting(key),
}));

// Phase 2: undici.fetch を mock — acquire の閾値判定経路 (= `ghFetch('GET contents/marketplace.json
// (acquire)', ..., { noAuth: true })` 等) が undici 経由で外部 repo に直接到達するため、これらの
// 呼び出しは undici.fetch 差し替えで応答する。`vi.stubGlobal('fetch', ...)` は named import に
// 効かないため、undici モジュール自体を mock + 他 export は実体保持。
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return { ...actual, fetch: (...args: unknown[]) => fetchMock(...args) };
});

// ghFetch のみ mock し GhHttpError クラスは実物のまま使う。acquire 内の存在確認経路
// (= `ghFetch('acquire.check-repo', ...)`, PR #33 hotfix で gh CLI 撤廃) のテストに使う。
// vi.mock で全上書きすると GhHttpError が別参照になり、acquire.ts の `err instanceof GhHttpError`
// 判定がテスト環境で壊れるため、importActual で実物 module を取り込んで部分上書きする。
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

// Phase 2: countSkillsInRepo は `ghFetch(..., { noAuth: true })` 経由なので mockGhFetch
// で受ける。デフォルトの 404 fallback は beforeEach で mockGhFetch に対して設定する
// (= marketplace 404 → git trees main 404 → master 404 → unknown となり閾値判定が skip され、
// 後続の clone 経路 = 既存挙動 に進む)。
function gh404(step = 'mock'): GhHttpError {
  return new GhHttpError(step, 404, 'not found');
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
  mockReadEnvFile.mockReset();
  mockReadEnvFile.mockReturnValue({});
  mockGetBiblioSetting.mockReset();
  mockGetBiblioSetting.mockReturnValue(undefined);
  fetchMock.mockReset();
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

  it('owner/repo/skill 3 segments を skill 付きで受理する (Phase 1 個別 skill 防御線)', () => {
    expect(normalizeRepo('anthropics/skills/algorithmic-art')).toEqual({
      owner: 'anthropics',
      name: 'skills',
      cloneUrl: 'https://github.com/anthropics/skills.git',
      skill: 'algorithmic-art',
    });
  });

  it('URL 形式の 3 segments も skill 付きで受理する', () => {
    expect(normalizeRepo('https://github.com/anthropics/skills/algorithmic-art')).toEqual({
      owner: 'anthropics',
      name: 'skills',
      cloneUrl: 'https://github.com/anthropics/skills.git',
      skill: 'algorithmic-art',
    });
  });

  it.each([
    ['空文字', ''],
    ['空白のみ', '   '],
    ['4 segments (dir+skill は標準外)', 'owner/repo/dir/skill'],
    ['セグメント不足', 'just-owner'],
    ['内部スペース', 'own er/repo'],
    ['github 以外の URL', 'https://gitlab.com/owner/repo'],
    ['不正文字 (name)', 'owner/re;po'],
    ['不正文字 (skill)', 'owner/repo/sk;ill'],
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
    // ghFetch が GET /repos/octocat/hello で 1 回呼ばれている (= ctx は呼出元から渡さない経路、{ ctx: undefined, noAuth: true })。
    // noAuth: true は外部 repo 対応 (issue #46 fix)。countSkillsInRepo (marketplace.json / git/trees) と対称。
    expect(mockGhFetch).toHaveBeenCalledWith(
      'acquire.check-repo',
      expect.stringMatching(/\/repos\/octocat\/hello$/),
      {},
      { ctx: undefined, noAuth: true },
    );
  });

  it('外部 public repo (scope 外) でも check-repo が noAuth: true で通る (issue #46)', async () => {
    // 外部 repo (= GH App installation scope 外) でも check-repo が 200 を返せる
    // ことを assert。実装の noAuth: true により Authorization header が省略され、
    // OneCLI MITM の installation token inject 経路を bypass する (= 401 にならない)。
    mockSpawn.mockImplementation((_cmd, args) => {
      const dest = (args as string[])[4];
      fs.mkdirSync(path.join(dest, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(dest, '.claude-plugin', 'marketplace.json'), '{}');
      return spawnResult(0);
    });
    const result = await acquire({ repo: 'example-org/test-biblio-minimal' });
    expect(result.ok).toBe(true);
    expect(mockGhFetch).toHaveBeenCalledWith(
      'acquire.check-repo',
      expect.stringMatching(/\/repos\/example-org\/test-biblio-minimal$/),
      {},
      expect.objectContaining({ noAuth: true }),
    );
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

  it('skill 指定で個別 fetch (sparse-checkout) 経路に進み成功する', async () => {
    mockSpawn.mockImplementation((cmd, args) => {
      if (cmd === 'gh') return spawnResult(0);
      if (cmd === 'git') {
        const a = args as string[];
        if (a[0] === 'clone') {
          // partial clone + no-checkout: .git だけ作る (sparse-checkout init の前提)
          const dest = a[a.length - 1];
          fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
          return spawnResult(0);
        }
        if (a[2] === 'sparse-checkout' && a[3] === 'init') return spawnResult(0);
        if (a[2] === 'sparse-checkout' && a[3] === 'set') {
          // sparse set: 指定 skill dir + SKILL.md を mock 生成 (= 実 git ならここで blob が引かれる)
          const qpath = a[1];
          const skill = a[4];
          const skillDir = path.join(qpath, skill);
          fs.mkdirSync(skillDir, { recursive: true });
          fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# mock skill');
          return spawnResult(0);
        }
        if (a[2] === 'checkout') return spawnResult(0);
      }
      return spawnResult(1);
    });
    const result = await acquire({ repo: 'anthropics/skills', skill: 'algorithmic-art' });
    expect(result).toEqual({
      ok: true,
      biblioName: 'anthropics--skills--algorithmic-art',
      quarantinePath: path.join(QUARANTINE, 'anthropics--skills--algorithmic-art'),
    });
    expect(
      fs.existsSync(path.join(QUARANTINE, 'anthropics--skills--algorithmic-art', 'algorithmic-art', 'SKILL.md')),
    ).toBe(true);
    // gh api は個別経路では呼ばれない (= sparse-checkout の git clone 自体が repo 存在確認を兼ねる)
    const ghCalls = mockSpawn.mock.calls.filter((c) => c[0] === 'gh');
    expect(ghCalls).toHaveLength(0);
    // sparse-checkout set には skill dir + `.claude-plugin` の両方が渡されること (issue #63 regression 防止)。
    // `.claude-plugin` 不在の場合 marketplace 形式 repo の検品 / 陳列が壊れる。
    const sparseSetCall = mockSpawn.mock.calls.find(
      (c) => c[0] === 'git' && (c[1] as string[])[2] === 'sparse-checkout' && (c[1] as string[])[3] === 'set',
    );
    expect(sparseSetCall).toBeDefined();
    const sparsePatterns = (sparseSetCall![1] as string[]).slice(4);
    expect(sparsePatterns).toContain('algorithmic-art');
    expect(sparsePatterns).toContain('.claude-plugin');
  });

  it('marketplace.json の source="./<dir>/<skill>" 形式で subdir 再 sparse-checkout して成功 (issue #63 PR review)', async () => {
    // anthropics/claude-plugins-official で観察された `./plugins/<skill>` 形式を mock。
    // sparse-checkout は 1 回目 = [skill, .claude-plugin] / 2 回目 = [skill, .claude-plugin, plugins/<skill>] と再実行。
    let sparseSetCallNo = 0;
    mockSpawn.mockImplementation((cmd, args) => {
      if (cmd === 'git') {
        const a = args as string[];
        if (a[0] === 'clone') {
          const dest = a[a.length - 1];
          fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
          return spawnResult(0);
        }
        if (a[2] === 'sparse-checkout' && a[3] === 'init') return spawnResult(0);
        if (a[2] === 'sparse-checkout' && a[3] === 'set') {
          sparseSetCallNo++;
          const qpath = a[1];
          // 1 回目: marketplace.json を `.claude-plugin/` に置く (= step 5.5 で読まれる)
          if (sparseSetCallNo === 1) {
            const mpDir = path.join(qpath, '.claude-plugin');
            fs.mkdirSync(mpDir, { recursive: true });
            fs.writeFileSync(
              path.join(mpDir, 'marketplace.json'),
              JSON.stringify({
                name: 'mp',
                plugins: [{ name: 'api-security-testing', source: './plugins/api-security-testing' }],
              }),
            );
          }
          // 2 回目: subdir 経路で skill 本体を出現させる
          if (sparseSetCallNo === 2) {
            const skillBodyDir = path.join(qpath, 'plugins', 'api-security-testing');
            fs.mkdirSync(skillBodyDir, { recursive: true });
            fs.writeFileSync(path.join(skillBodyDir, 'SKILL.md'), '# subdir skill');
          }
          return spawnResult(0);
        }
        if (a[2] === 'checkout') return spawnResult(0);
      }
      return spawnResult(1);
    });
    const result = await acquire({ repo: '42crunch/marketplace-mock', skill: 'api-security-testing' });
    expect(result).toEqual({
      ok: true,
      biblioName: '42crunch--marketplace-mock--api-security-testing',
      quarantinePath: path.join(QUARANTINE, '42crunch--marketplace-mock--api-security-testing'),
    });
    // sparse-checkout set が 2 回呼ばれ、2 回目に `plugins/api-security-testing` が渡されている
    expect(sparseSetCallNo).toBe(2);
    const sparseSetCalls = mockSpawn.mock.calls.filter(
      (c) => c[0] === 'git' && (c[1] as string[])[2] === 'sparse-checkout' && (c[1] as string[])[3] === 'set',
    );
    const patterns2 = (sparseSetCalls[1][1] as string[]).slice(4);
    expect(patterns2).toContain('plugins/api-security-testing');
  });

  it('marketplace.json の source="./" なら marketplace_source_root REJECT (= 2-segment 推奨)', async () => {
    mockSpawn.mockImplementation((cmd, args) => {
      if (cmd === 'git') {
        const a = args as string[];
        if (a[0] === 'clone') {
          const dest = a[a.length - 1];
          fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
          return spawnResult(0);
        }
        if (a[2] === 'sparse-checkout' && a[3] === 'init') return spawnResult(0);
        if (a[2] === 'sparse-checkout' && a[3] === 'set') {
          const qpath = a[1];
          const mpDir = path.join(qpath, '.claude-plugin');
          fs.mkdirSync(mpDir, { recursive: true });
          fs.writeFileSync(
            path.join(mpDir, 'marketplace.json'),
            JSON.stringify({ name: 'mp', plugins: [{ name: 'agent-browser', source: './' }] }),
          );
          return spawnResult(0);
        }
        if (a[2] === 'checkout') return spawnResult(0);
      }
      return spawnResult(1);
    });
    const result = await acquire({ repo: 'vercel-labs/agent-browser', skill: 'agent-browser' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('marketplace_source_root');
      expect(result.detail).toContain('2-segment');
      expect(result.detail).toContain('vercel-labs/agent-browser');
    }
  });

  it('marketplace.json の source object 形式 (git-subdir) なら marketplace_source_external REJECT', async () => {
    mockSpawn.mockImplementation((cmd, args) => {
      if (cmd === 'git') {
        const a = args as string[];
        if (a[0] === 'clone') {
          const dest = a[a.length - 1];
          fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
          return spawnResult(0);
        }
        if (a[2] === 'sparse-checkout' && a[3] === 'init') return spawnResult(0);
        if (a[2] === 'sparse-checkout' && a[3] === 'set') {
          const qpath = a[1];
          const mpDir = path.join(qpath, '.claude-plugin');
          fs.mkdirSync(mpDir, { recursive: true });
          fs.writeFileSync(
            path.join(mpDir, 'marketplace.json'),
            JSON.stringify({
              name: 'mp',
              plugins: [
                {
                  name: 'external-skill',
                  source: {
                    source: 'git-subdir',
                    url: 'https://github.com/other/repo.git',
                    path: 'plugins/external-skill',
                  },
                },
              ],
            }),
          );
          return spawnResult(0);
        }
        if (a[2] === 'checkout') return spawnResult(0);
      }
      return spawnResult(1);
    });
    const result = await acquire({ repo: 'anthropics/claude-plugins-official', skill: 'external-skill' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('marketplace_source_external');
      expect(result.detail).toContain('別 repo');
      expect(result.detail).toContain('git-subdir');
    }
  });

  it('req.skill が SEGMENT_RE 不一致 (不正文字) なら invalid_input を返す (Phase 3 fetch パス踏み抜き防衛)', async () => {
    const result = await acquire({ repo: 'anthropics/skills', skill: 'sk;ill' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_input');
      expect(result.detail).toContain('sk;ill');
    }
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('3 segments 入力 (normalized.skill 経由) でも個別 fetch に進む', async () => {
    mockSpawn.mockImplementation((cmd, args) => {
      if (cmd === 'git') {
        const a = args as string[];
        if (a[0] === 'clone') {
          const dest = a[a.length - 1];
          fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
          return spawnResult(0);
        }
        if (a[2] === 'sparse-checkout' && a[3] === 'init') return spawnResult(0);
        if (a[2] === 'sparse-checkout' && a[3] === 'set') {
          const qpath = a[1];
          const skill = a[4];
          const skillDir = path.join(qpath, skill);
          fs.mkdirSync(skillDir, { recursive: true });
          fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# skill');
        }
        return spawnResult(0);
      }
      return spawnResult(0);
    });
    const result = await acquire({ repo: 'anthropics/skills/algorithmic-art' });
    expect(result).toMatchObject({ ok: true, biblioName: 'anthropics--skills--algorithmic-art' });
  });

  it('skill 指定で partial clone 失敗 → clone_failed (quarantine 削除)', async () => {
    mockSpawn.mockImplementation((cmd, args) => {
      if (cmd === 'git' && (args as string[])[0] === 'clone') {
        return spawnResult(128, 'fatal: repository not found');
      }
      return spawnResult(0);
    });
    const result = await acquire({ repo: 'anthropics/skills', skill: 'algorithmic-art' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('clone_failed');
      expect(result.detail).toContain('partial clone');
    }
    expect(fs.existsSync(path.join(QUARANTINE, 'anthropics--skills--algorithmic-art'))).toBe(false);
  });

  it('skill 指定で sparse-checkout set 失敗 → clone_failed (quarantine 削除)', async () => {
    mockSpawn.mockImplementation((cmd, args) => {
      if (cmd === 'git') {
        const a = args as string[];
        if (a[0] === 'clone') {
          const dest = a[a.length - 1];
          fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
          return spawnResult(0);
        }
        if (a[2] === 'sparse-checkout' && a[3] === 'init') return spawnResult(0);
        if (a[2] === 'sparse-checkout' && a[3] === 'set') return spawnResult(1, 'sparse-checkout: pattern error');
      }
      return spawnResult(0);
    });
    const result = await acquire({ repo: 'anthropics/skills', skill: 'bad-skill' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('clone_failed');
      expect(result.detail).toContain('sparse-checkout set');
    }
    expect(fs.existsSync(path.join(QUARANTINE, 'anthropics--skills--bad-skill'))).toBe(false);
  });

  it('skill 指定で sparse 後の skill dir に SKILL.md 不在 → manifest_missing', async () => {
    mockSpawn.mockImplementation((cmd, args) => {
      if (cmd === 'git') {
        const a = args as string[];
        if (a[0] === 'clone') {
          const dest = a[a.length - 1];
          fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
          return spawnResult(0);
        }
        if (a[2] === 'sparse-checkout' && a[3] === 'set') {
          // skill dir は作るが SKILL.md は置かない (= README のみ等)
          const qpath = a[1];
          const skill = a[4];
          const skillDir = path.join(qpath, skill);
          fs.mkdirSync(skillDir, { recursive: true });
          fs.writeFileSync(path.join(skillDir, 'README.md'), '# no SKILL.md');
        }
        return spawnResult(0);
      }
      return spawnResult(0);
    });
    const result = await acquire({ repo: 'someone/repo', skill: 'not-a-skill' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('manifest_missing');
      expect(result.detail).toContain('SKILL.md');
    }
    expect(fs.existsSync(path.join(QUARANTINE, 'someone--repo--not-a-skill'))).toBe(false);
  });

  it('skill 指定で sparse-checkout init 失敗 → clone_failed (quarantine 削除)', async () => {
    // 4 子プロセスのうち最も環境依存度が高い (= --cone mode 未対応 git バージョン) 分岐の網羅
    mockSpawn.mockImplementation((cmd, args) => {
      if (cmd === 'git') {
        const a = args as string[];
        if (a[0] === 'clone') {
          const dest = a[a.length - 1];
          fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
          return spawnResult(0);
        }
        if (a[2] === 'sparse-checkout' && a[3] === 'init') {
          return spawnResult(128, 'error: unknown option `cone`');
        }
      }
      return spawnResult(0);
    });
    const result = await acquire({ repo: 'anthropics/skills', skill: 'algorithmic-art' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('clone_failed');
      expect(result.detail).toContain('sparse-checkout init');
    }
    expect(fs.existsSync(path.join(QUARANTINE, 'anthropics--skills--algorithmic-art'))).toBe(false);
  });

  it('skill 指定で checkout 失敗 → clone_failed (quarantine 削除)', async () => {
    // sparse-checkout set まで成功するが checkout (= blob 遅延 fetch 経路) が失敗するケース
    mockSpawn.mockImplementation((cmd, args) => {
      if (cmd === 'git') {
        const a = args as string[];
        if (a[0] === 'clone') {
          const dest = a[a.length - 1];
          fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
          return spawnResult(0);
        }
        if (a[2] === 'sparse-checkout') return spawnResult(0);
        if (a[2] === 'checkout') return spawnResult(128, 'error: unable to checkout');
      }
      return spawnResult(0);
    });
    const result = await acquire({ repo: 'anthropics/skills', skill: 'algorithmic-art' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('clone_failed');
      expect(result.detail).toContain('checkout に失敗');
    }
    expect(fs.existsSync(path.join(QUARANTINE, 'anthropics--skills--algorithmic-art'))).toBe(false);
  });

  it('skill 指定で sparse 後の skill dir 自体が不在 → manifest_missing (quarantine 削除)', async () => {
    // patron が指定した skill が repo 内に存在しない場合の挙動 (= sparse-checkout set 自体は
    // 成功するが、worktree 展開後に skill dir が作られないケース)。SKILL.md 不在 test とは別経路で、
    // `!fs.existsSync(skillDir)` の早期分岐を直接 cover する。
    mockSpawn.mockImplementation((cmd, args) => {
      if (cmd === 'git') {
        const a = args as string[];
        if (a[0] === 'clone') {
          const dest = a[a.length - 1];
          fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
          return spawnResult(0);
        }
        // sparse-checkout set / init / checkout すべて成功するが skill dir を作らない
        return spawnResult(0);
      }
      return spawnResult(0);
    });
    const result = await acquire({ repo: 'someone/repo', skill: 'non-existent-skill' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('manifest_missing');
      expect(result.detail).toContain('skill ディレクトリが見つかりません');
    }
    expect(fs.existsSync(path.join(QUARANTINE, 'someone--repo--non-existent-skill'))).toBe(false);
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

describe('acquire — Phase 2 threshold-promote', () => {
  /**
   * countSkillsInRepo は `ghFetch(..., { noAuth: true })` 経路。`ghFetch` は内部で
   * `await res.json()` まで実行して JSON object を返すため、mockGhFetch には
   * 「parse 済みの object」を直接返却させる (= 旧 `Response` 返却から構造を変更)。
   */

  /** marketplace.json fetch の ghFetch 戻り値 (= base64 encode 済 JSON)。 */
  function mockMarketplaceData(plugins: unknown): unknown {
    const json = JSON.stringify({ plugins });
    return {
      content: Buffer.from(json).toString('base64'),
      encoding: 'base64',
      sha: 'mocksha',
    };
  }

  /** Git Trees API fetch の ghFetch 戻り値 (= path 配列、blob 限定)。 */
  function mockGitTreesData(paths: string[], truncated = false): unknown {
    return {
      truncated,
      tree: paths.map((p) => ({ path: p, type: 'blob' as const })),
    };
  }

  /**
   * 各 Phase 2 test の mockGhFetch 設定の共通 prelude — 1 回目は存在確認 (= 成功)。
   * 2 回目以降は countSkillsInRepo / Git Trees fallback 経路で個別に上書きする。
   */
  function setupExistenceCheckSuccess(): void {
    mockGhFetch.mockReset();
    mockGhFetch.mockResolvedValueOnce({ full_name: 'octocat/hello' });
  }

  /** 仕入れ成功用の spawnSync mock (gh 0 + git clone でマニフェスト作成)。 */
  function setupCloneSuccess(): void {
    mockSpawn.mockImplementation((cmd, args) => {
      if (cmd === 'gh') return spawnResult(0);
      const dest = (args as string[])[4];
      fs.mkdirSync(path.join(dest, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(dest, '.claude-plugin', 'marketplace.json'), '{}');
      return spawnResult(0);
    });
  }

  it('marketplace.json 経路 — 閾値以内 (5 skill) なら clone 経路に進む', async () => {
    setupCloneSuccess();
    setupExistenceCheckSuccess();
    mockGhFetch.mockResolvedValueOnce(mockMarketplaceData([{ skills: ['./a', './b', './c', './d', './e'] }]));
    const result = await acquire({ repo: 'small/repo' });
    expect(result).toMatchObject({ ok: true, biblioName: 'small--repo' });
    // git clone が呼ばれている (= 閾値判定後に clone 経路に進んだ証拠)
    const gitCalls = mockSpawn.mock.calls.filter((c) => c[0] === 'git');
    expect(gitCalls.length).toBe(1);
  });

  it('marketplace.json 経路 — 閾値超過 (17 skill) で early return、clone 呼ばれない', async () => {
    // git は呼ばれない想定
    mockSpawn.mockImplementation(() => spawnResult(-1));
    setupExistenceCheckSuccess();
    mockGhFetch.mockResolvedValueOnce(
      mockMarketplaceData([{ skills: Array.from({ length: 17 }, (_, i) => `./skill-${i}`) }]),
    );
    const result = await acquire({ repo: 'large/repo' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('threshold_exceeded');
    expect(result.detail).toContain('17 個');
    expect(result.detail).toContain('上限 10 個');
    expect(result.detail).toContain('large/repo/<skill-name>');
    expect(result.detail).toContain('https://github.com/large/repo');
    // git clone が呼ばれていない (= early return が効いた証拠)
    const gitCalls = mockSpawn.mock.calls.filter((c) => c[0] === 'git');
    expect(gitCalls.length).toBe(0);
  });

  it('marketplace.json 不在 → Git Trees fallback (main) で閾値超過', async () => {
    mockSpawn.mockImplementation(() => spawnResult(-1));
    setupExistenceCheckSuccess();
    mockGhFetch
      .mockRejectedValueOnce(gh404('GET contents/marketplace.json (acquire)')) // marketplace.json: 404 → fallback
      .mockResolvedValueOnce(
        mockGitTreesData(Array.from({ length: 15 }, (_, i) => `skill-${i}/SKILL.md`).concat(['README.md', 'LICENSE'])),
      );
    const result = await acquire({ repo: 'no-marketplace/repo' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('threshold_exceeded');
    expect(result.detail).toContain('15 個');
  });

  it('Git Trees truncated → unknown → 閾値判定 skip → clone 経路に進む (既存挙動維持)', async () => {
    setupCloneSuccess();
    setupExistenceCheckSuccess();
    mockGhFetch
      .mockRejectedValueOnce(gh404('GET contents/marketplace.json (acquire)'))
      .mockResolvedValueOnce(mockGitTreesData(['skill-1/SKILL.md'], true));
    const result = await acquire({ repo: 'huge/repo' });
    // threshold_exceeded ではなく clone 経路 (= ok:true) に進んだ
    expect(result).toMatchObject({ ok: true, biblioName: 'huge--repo' });
  });

  it('env ACQUIRE_SKILL_THRESHOLD=20 オーバーライド — 17 skill は通る', async () => {
    setupCloneSuccess();
    mockReadEnvFile.mockReturnValue({ ACQUIRE_SKILL_THRESHOLD: '20' });
    setupExistenceCheckSuccess();
    mockGhFetch.mockResolvedValueOnce(
      mockMarketplaceData([{ skills: Array.from({ length: 17 }, (_, i) => `./skill-${i}`) }]),
    );
    const result = await acquire({ repo: 'medium/repo' });
    expect(result).toMatchObject({ ok: true, biblioName: 'medium--repo' });
  });

  it('env ACQUIRE_SKILL_THRESHOLD=-5 (不正値) → default 10 に倒れ warn ログ', async () => {
    mockSpawn.mockImplementation(() => spawnResult(-1));
    mockReadEnvFile.mockReturnValue({ ACQUIRE_SKILL_THRESHOLD: '-5' });
    setupExistenceCheckSuccess();
    mockGhFetch.mockResolvedValueOnce(
      mockMarketplaceData([{ skills: Array.from({ length: 11 }, (_, i) => `./skill-${i}`) }]),
    );
    const result = await acquire({ repo: 'mid/repo' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('threshold_exceeded');
    expect(result.detail).toContain('上限 10 個'); // default に倒れたことの証拠
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'invalid ACQUIRE_SKILL_THRESHOLD, using default',
      expect.objectContaining({ raw: '-5', default: 10 }),
    );
  });

  it('plugins[] 直配列 (claude-plugins-official 型) — 1 plugin = 1 skill で count', async () => {
    mockSpawn.mockImplementation(() => spawnResult(-1));
    setupExistenceCheckSuccess();
    // skills フィールド無し → 各 plugin を 1 skill として count
    mockGhFetch.mockResolvedValueOnce(
      mockMarketplaceData(Array.from({ length: 12 }, (_, i) => ({ name: `plugin-${i}` }))),
    );
    const result = await acquire({ repo: 'official/style' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('threshold_exceeded');
    expect(result.detail).toContain('12 個');
  });

  // ===== レビュー指摘対応 (PR #19) — 境界値 + degraded 経路カバレッジ =====

  it('境界値 — ちょうど閾値 (10 skill) なら clone 経路に進む (> は exclusive)', async () => {
    // `count > threshold` 判定の境界仕様の明示化 (= 10 ちょうどは通る、11 で promote)。
    // 仕様変更時 (> → >=) の回帰を 1 件で検知する。
    setupCloneSuccess();
    setupExistenceCheckSuccess();
    mockGhFetch.mockResolvedValueOnce(
      mockMarketplaceData([{ skills: Array.from({ length: 10 }, (_, i) => `./s-${i}`) }]),
    );
    const result = await acquire({ repo: 'boundary/repo' });
    expect(result).toMatchObject({ ok: true, biblioName: 'boundary--repo' });
  });

  it('marketplace.json 500 エラー → unknown → clone 経路に進む (degraded 保護)', async () => {
    // rate limit / GitHub server error 時に閾値判定を skip して既存挙動を維持することを確認。
    setupCloneSuccess();
    setupExistenceCheckSuccess();
    mockGhFetch.mockRejectedValueOnce(
      new GhHttpError('GET contents/marketplace.json (acquire)', 500, 'internal server error'),
    );
    const result = await acquire({ repo: 'flaky/repo' });
    expect(result).toMatchObject({ ok: true, biblioName: 'flaky--repo' });
  });

  it('marketplace.json に plugins[] なし → unknown → clone 経路に進む', async () => {
    // marketplace.json は存在するが plugins フィールド欠落 (= biblio 仕様外形式) の防御確認。
    setupCloneSuccess();
    setupExistenceCheckSuccess();
    const malformedJson = JSON.stringify({ version: '1.0' }); // plugins キーなし
    mockGhFetch.mockResolvedValueOnce({
      content: Buffer.from(malformedJson).toString('base64'),
      encoding: 'base64',
    });
    const result = await acquire({ repo: 'no-plugins/repo' });
    expect(result).toMatchObject({ ok: true, biblioName: 'no-plugins--repo' });
  });

  it('marketplace.json が不正 JSON → unknown → clone 経路 + warn ログ', async () => {
    // base64 decode 後の文字列が JSON parse 失敗するケース。silent failure 防止の確認。
    setupCloneSuccess();
    setupExistenceCheckSuccess();
    mockGhFetch.mockResolvedValueOnce({
      content: Buffer.from('{ invalid json }').toString('base64'),
      encoding: 'base64',
    });
    const result = await acquire({ repo: 'malformed/repo' });
    expect(result).toMatchObject({ ok: true, biblioName: 'malformed--repo' });
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'countSkillsInRepo: marketplace.json invalid JSON',
      expect.objectContaining({ owner: 'malformed', name: 'repo' }),
    );
  });

  it('Git Trees fallback — main 404 → master 200 で閾値超過', async () => {
    // tryBranches ループの continue 経路 (= main を試した後 master に進む) の直接検証。
    // 既存テストは「main 200」または「main + master の両方 404 / truncated」しかカバーしていない。
    mockSpawn.mockImplementation(() => spawnResult(-1));
    setupExistenceCheckSuccess();
    mockGhFetch
      .mockRejectedValueOnce(gh404('GET contents/marketplace.json (acquire)')) // marketplace.json: 404
      .mockRejectedValueOnce(gh404('GET git/trees (acquire)')) // git/trees/main: 404
      .mockResolvedValueOnce(mockGitTreesData(Array.from({ length: 12 }, (_, i) => `skill-${i}/SKILL.md`))); // git/trees/master: 12 SKILL.md
    const result = await acquire({ repo: 'legacy/repo' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('threshold_exceeded');
    expect(result.detail).toContain('12 個');
  });

  it('countSkillsInRepo は外部 repo に noAuth: true で fetch する (= Authorization ヘッダなし)', async () => {
    // 外部 repo (= GH App installation scope 外、anthropics/skills 等) は OneCLI MITM が token 注入
    // しても GitHub が 401 Bad credentials を返すため、countSkillsInRepo は ghFetch を
    // `{ noAuth: true }` opts 付きで呼び出して無認証 public API 200 を取る経路に倒す。
    // 本テストは mockGhFetch の引数を直接見て opts.noAuth が true であることを assert する。
    setupCloneSuccess();
    setupExistenceCheckSuccess();
    mockGhFetch.mockResolvedValueOnce(mockMarketplaceData([{ skills: ['./a', './b'] }]));
    await acquire({ repo: 'small/repo' });
    // 1 回目: 存在確認 (acquire.check-repo)、2 回目: countSkillsInRepo (marketplace.json)
    expect(mockGhFetch).toHaveBeenCalledTimes(2);
    const [step, url, , opts] = mockGhFetch.mock.calls[1];
    expect(step).toContain('GET contents/marketplace.json (acquire)');
    expect(url).toContain('/repos/small/repo/contents/.claude-plugin/marketplace.json');
    // noAuth: true で Authorization ヘッダを省略する経路
    expect(opts).toMatchObject({ noAuth: true });
  });

  it('env ACQUIRE_SKILL_THRESHOLD="abc" (非数値) → default 10 に倒れ warn ログ', async () => {
    // `-5` は `< 1` 分岐で弾かれるが、`"abc"` は `parseInt → NaN` → `!Number.isFinite(NaN)`
    // 分岐で弾かれる別経路。両方の防御パスをカバーする。
    mockSpawn.mockImplementation(() => spawnResult(-1));
    mockReadEnvFile.mockReturnValue({ ACQUIRE_SKILL_THRESHOLD: 'abc' });
    setupExistenceCheckSuccess();
    mockGhFetch.mockResolvedValueOnce(
      mockMarketplaceData([{ skills: Array.from({ length: 11 }, (_, i) => `./s-${i}`) }]),
    );
    const result = await acquire({ repo: 'nan/repo' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('threshold_exceeded');
    expect(result.detail).toContain('上限 10 個');
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'invalid ACQUIRE_SKILL_THRESHOLD, using default',
      expect.objectContaining({ raw: 'abc', default: 10 }),
    );
  });

  // ===== 個別 PRD Phase 5: 3 層 fallback (DB → env → DEFAULT) =====

  it('DB 優先 — getBiblioSetting が "25" を返す + env "20" でも DB 値 (25) が採用される', async () => {
    setupCloneSuccess();
    setupExistenceCheckSuccess();
    mockGetBiblioSetting.mockReturnValue('25');
    mockReadEnvFile.mockReturnValue({ ACQUIRE_SKILL_THRESHOLD: '20' });
    // 22 skill = env 20 なら超過するが DB 25 なら通る → clone 経路 (= ok:true) になることで DB 優先を検証
    mockGhFetch.mockResolvedValueOnce(
      mockMarketplaceData([{ skills: Array.from({ length: 22 }, (_, i) => `./s-${i}`) }]),
    );
    const result = await acquire({ repo: 'db-priority/repo' });
    expect(result).toMatchObject({ ok: true, biblioName: 'db-priority--repo' });
  });

  it('DB 不正値 ("abc") → warn ログ + env fallback (20) に倒れる', async () => {
    mockSpawn.mockImplementation(() => spawnResult(-1));
    mockGetBiblioSetting.mockReturnValue('abc');
    mockReadEnvFile.mockReturnValue({ ACQUIRE_SKILL_THRESHOLD: '20' });
    // 21 skill = env 20 なら超過 → DB 不正で env に降りた証拠
    setupExistenceCheckSuccess();
    mockGhFetch.mockResolvedValueOnce(
      mockMarketplaceData([{ skills: Array.from({ length: 21 }, (_, i) => `./s-${i}`) }]),
    );
    const result = await acquire({ repo: 'db-bad/repo' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('threshold_exceeded');
    expect(result.detail).toContain('上限 20 個');
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'invalid ACQUIRE_SKILL_THRESHOLD in DB, falling back to env',
      expect.objectContaining({ raw: 'abc' }),
    );
  });

  it('DB + env 共に不正 → warn 2 件 + DEFAULT (10) に倒れる', async () => {
    mockSpawn.mockImplementation(() => spawnResult(-1));
    mockGetBiblioSetting.mockReturnValue('not-a-number');
    mockReadEnvFile.mockReturnValue({ ACQUIRE_SKILL_THRESHOLD: '-5' });
    setupExistenceCheckSuccess();
    mockGhFetch.mockResolvedValueOnce(
      mockMarketplaceData([{ skills: Array.from({ length: 11 }, (_, i) => `./s-${i}`) }]),
    );
    const result = await acquire({ repo: 'all-bad/repo' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('threshold_exceeded');
    expect(result.detail).toContain('上限 10 個');
    // DB 層の warn
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'invalid ACQUIRE_SKILL_THRESHOLD in DB, falling back to env',
      expect.objectContaining({ raw: 'not-a-number' }),
    );
    // env 層の warn
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'invalid ACQUIRE_SKILL_THRESHOLD, using default',
      expect.objectContaining({ raw: '-5', default: 10 }),
    );
  });

  it('DB undefined → env fallback で既存挙動維持 (env 20 採用)', async () => {
    setupCloneSuccess();
    setupExistenceCheckSuccess();
    mockGetBiblioSetting.mockReturnValue(undefined);
    mockReadEnvFile.mockReturnValue({ ACQUIRE_SKILL_THRESHOLD: '20' });
    // 17 skill = env 20 以内 → 通る (= env が DB なしのフォールバックとして効いている証拠)
    mockGhFetch.mockResolvedValueOnce(
      mockMarketplaceData([{ skills: Array.from({ length: 17 }, (_, i) => `./s-${i}`) }]),
    );
    const result = await acquire({ repo: 'no-db/repo' });
    expect(result).toMatchObject({ ok: true, biblioName: 'no-db--repo' });
  });

  it('DB 空文字 ("") → env fallback (= 空文字は未設定扱い、空文字を Number.parseInt すると NaN なので別経路を確実に取る)', async () => {
    setupCloneSuccess();
    setupExistenceCheckSuccess();
    mockGetBiblioSetting.mockReturnValue('');
    mockReadEnvFile.mockReturnValue({ ACQUIRE_SKILL_THRESHOLD: '20' });
    mockGhFetch.mockResolvedValueOnce(
      mockMarketplaceData([{ skills: Array.from({ length: 17 }, (_, i) => `./s-${i}`) }]),
    );
    // beforeEach で log.warn mock が reset されない (= 別 test の warn が trailing で残る) ため、
    // negative assertion 直前に local clear する。同 file の他 test は positive `toHaveBeenCalledWith`
    // のみ使っているので clear せずに済む。
    vi.mocked(log.warn).mockClear();
    const result = await acquire({ repo: 'db-empty/repo' });
    expect(result).toMatchObject({ ok: true, biblioName: 'db-empty--repo' });
    // 空文字は invalid warn を出さずに env に降りる (= 未設定相当)
    expect(vi.mocked(log.warn)).not.toHaveBeenCalledWith(
      'invalid ACQUIRE_SKILL_THRESHOLD in DB, falling back to env',
      expect.anything(),
    );
  });

  // resolveSkillThreshold の DB throw 時 degraded fallback (= DB 未初期化 / SQLITE_BUSY 等)。
  // try/catch (acquire.ts:556-568) で囲って DEFAULT に倒れることを unit で固定する。
  // PR #48 review-agents (pr-test-analyzer 改善 1、6/10) 対応。
  it('getBiblioSetting throw (= DB 未初期化等) → warn (acquire.threshold_resolve_failed) + DEFAULT(10) に degraded fallback', async () => {
    setupCloneSuccess();
    setupExistenceCheckSuccess();
    // DB throw でも acquire は discriminated union を返し続ける (= not throw、設計契約維持)
    mockGetBiblioSetting.mockImplementation(() => {
      throw new Error('SQLITE_ERROR: no such table biblio_settings');
    });
    // env は未設定 = DEFAULT(10) を見るパターン
    mockReadEnvFile.mockReturnValue({});
    // 9 skill = DEFAULT(10) 以内 → 通る (= DEFAULT に倒れた証拠)
    mockGhFetch.mockResolvedValueOnce(
      mockMarketplaceData([{ skills: Array.from({ length: 9 }, (_, i) => `./s-${i}`) }]),
    );
    const result = await acquire({ repo: 'db-throw/repo' });
    expect(result).toMatchObject({ ok: true, biblioName: 'db-throw--repo' });
    // structured event で degraded fallback を可視化 (= Cloud Logging で検知可能)
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'acquire: resolveSkillThreshold threw, using default',
      expect.objectContaining({
        event: 'acquire.threshold_resolve_failed',
        outcome: 'degraded',
        default: 10,
      }),
    );
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
