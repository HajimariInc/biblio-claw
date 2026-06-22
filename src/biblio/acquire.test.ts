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

// Phase 2: undici.fetch を mock — shelve.ts は `import { fetch } from 'undici'` で named import
// しているため、`vi.stubGlobal('fetch', ...)` (globalThis.fetch 差し替え) は効かない。undici
// モジュール自体を mock し、他の export (Agent / EnvHttpProxyAgent 等) は実体を保つ。
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return { ...actual, fetch: (...args: unknown[]) => fetchMock(...args) };
});

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

// Phase 2: 既存テストへの影響を抑えるため、fetch を default で 404 にする。countSkillsInRepo は
// marketplace 404 → git trees main 404 → master 404 → unknown となり閾値判定が skip され、
// 後続の clone 経路 (= 既存挙動) に進む。Phase 2 テストは `fetchMock.mockResolvedValueOnce(...)`
// で個別 response を上書きする。
function mock404(): Response {
  return { ok: false, status: 404, text: async () => 'not found' } as Response;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  mockSpawn.mockReset();
  mockEnsureAgent.mockReset();
  mockGetProxyConfig.mockReset();
  _resetHostProxyForTesting();
  mockReadEnvFile.mockReset();
  mockReadEnvFile.mockReturnValue({});
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(mock404());
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
    expect(fs.existsSync(path.join(QUARANTINE, 'octocat--hello'))).toBe(false);
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
    expect(fs.existsSync(path.join(QUARANTINE, 'octocat--hello'))).toBe(false);
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
    expect(result).toEqual({
      ok: true,
      biblioName: 'octocat--hello',
      quarantinePath: path.join(QUARANTINE, 'octocat--hello'),
    });
    expect(fs.existsSync(path.join(QUARANTINE, 'octocat--hello', '.claude-plugin', 'marketplace.json'))).toBe(true);
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

describe('acquire — Phase 2 threshold-promote', () => {
  /** marketplace.json fetch response を組む (= base64 + encoding)。 */
  function mockMarketplaceResponse(plugins: unknown): Response {
    const json = JSON.stringify({ plugins });
    return {
      ok: true,
      json: async () => ({
        content: Buffer.from(json).toString('base64'),
        encoding: 'base64',
        sha: 'mocksha',
      }),
    } as Response;
  }

  /** Git Trees API response を組む (= path 配列、blob 限定)。 */
  function mockGitTreesResponse(paths: string[], truncated = false): Response {
    return {
      ok: true,
      json: async () => ({
        truncated,
        tree: paths.map((p) => ({ path: p, type: 'blob' as const })),
      }),
    } as Response;
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
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(mockMarketplaceResponse([{ skills: ['./a', './b', './c', './d', './e'] }]));
    const result = await acquire({ repo: 'small/repo' });
    expect(result).toMatchObject({ ok: true, biblioName: 'small--repo' });
    // git clone が呼ばれている (= 閾値判定後に clone 経路に進んだ証拠)
    const gitCalls = mockSpawn.mock.calls.filter((c) => c[0] === 'git');
    expect(gitCalls.length).toBe(1);
  });

  it('marketplace.json 経路 — 閾値超過 (17 skill) で early return、clone 呼ばれない', async () => {
    // gh は OK、git は呼ばれない想定
    mockSpawn.mockImplementation((cmd) => spawnResult(cmd === 'gh' ? 0 : -1));
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      mockMarketplaceResponse([{ skills: Array.from({ length: 17 }, (_, i) => `./skill-${i}`) }]),
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
    mockSpawn.mockImplementation((cmd) => spawnResult(cmd === 'gh' ? 0 : -1));
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(mock404()) // marketplace.json: 404 → fallback
      .mockResolvedValueOnce(
        mockGitTreesResponse(
          Array.from({ length: 15 }, (_, i) => `skill-${i}/SKILL.md`).concat(['README.md', 'LICENSE']),
        ),
      );
    const result = await acquire({ repo: 'no-marketplace/repo' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('threshold_exceeded');
    expect(result.detail).toContain('15 個');
  });

  it('Git Trees truncated → unknown → 閾値判定 skip → clone 経路に進む (既存挙動維持)', async () => {
    setupCloneSuccess();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(mock404()).mockResolvedValueOnce(mockGitTreesResponse(['skill-1/SKILL.md'], true));
    const result = await acquire({ repo: 'huge/repo' });
    // threshold_exceeded ではなく clone 経路 (= ok:true) に進んだ
    expect(result).toMatchObject({ ok: true, biblioName: 'huge--repo' });
  });

  it('env ACQUIRE_SKILL_THRESHOLD=20 オーバーライド — 17 skill は通る', async () => {
    setupCloneSuccess();
    mockReadEnvFile.mockReturnValue({ ACQUIRE_SKILL_THRESHOLD: '20' });
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      mockMarketplaceResponse([{ skills: Array.from({ length: 17 }, (_, i) => `./skill-${i}`) }]),
    );
    const result = await acquire({ repo: 'medium/repo' });
    expect(result).toMatchObject({ ok: true, biblioName: 'medium--repo' });
  });

  it('env ACQUIRE_SKILL_THRESHOLD=-5 (不正値) → default 10 に倒れ warn ログ', async () => {
    mockSpawn.mockImplementation((cmd) => spawnResult(cmd === 'gh' ? 0 : -1));
    mockReadEnvFile.mockReturnValue({ ACQUIRE_SKILL_THRESHOLD: '-5' });
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      mockMarketplaceResponse([{ skills: Array.from({ length: 11 }, (_, i) => `./skill-${i}`) }]),
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
    mockSpawn.mockImplementation((cmd) => spawnResult(cmd === 'gh' ? 0 : -1));
    fetchMock.mockReset();
    // skills フィールド無し → 各 plugin を 1 skill として count
    fetchMock.mockResolvedValueOnce(
      mockMarketplaceResponse(Array.from({ length: 12 }, (_, i) => ({ name: `plugin-${i}` }))),
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
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      mockMarketplaceResponse([{ skills: Array.from({ length: 10 }, (_, i) => `./s-${i}`) }]),
    );
    const result = await acquire({ repo: 'boundary/repo' });
    expect(result).toMatchObject({ ok: true, biblioName: 'boundary--repo' });
  });

  it('marketplace.json 500 エラー → unknown → clone 経路に進む (degraded 保護)', async () => {
    // rate limit / GitHub server error 時に閾値判定を skip して既存挙動を維持することを確認。
    setupCloneSuccess();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'internal server error',
    } as Response);
    const result = await acquire({ repo: 'flaky/repo' });
    expect(result).toMatchObject({ ok: true, biblioName: 'flaky--repo' });
  });

  it('marketplace.json に plugins[] なし → unknown → clone 経路に進む', async () => {
    // marketplace.json は存在するが plugins フィールド欠落 (= biblio 仕様外形式) の防御確認。
    setupCloneSuccess();
    fetchMock.mockReset();
    const malformedJson = JSON.stringify({ version: '1.0' }); // plugins キーなし
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: Buffer.from(malformedJson).toString('base64'),
        encoding: 'base64',
      }),
    } as Response);
    const result = await acquire({ repo: 'no-plugins/repo' });
    expect(result).toMatchObject({ ok: true, biblioName: 'no-plugins--repo' });
  });

  it('marketplace.json が不正 JSON → unknown → clone 経路 + warn ログ', async () => {
    // base64 decode 後の文字列が JSON parse 失敗するケース。silent failure 防止の確認。
    setupCloneSuccess();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: Buffer.from('{ invalid json }').toString('base64'),
        encoding: 'base64',
      }),
    } as Response);
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
    mockSpawn.mockImplementation((cmd) => spawnResult(cmd === 'gh' ? 0 : -1));
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(mock404()) // marketplace.json: 404
      .mockResolvedValueOnce(mock404()) // git/trees/main: 404
      .mockResolvedValueOnce(mockGitTreesResponse(Array.from({ length: 12 }, (_, i) => `skill-${i}/SKILL.md`))); // git/trees/master: 12 SKILL.md
    const result = await acquire({ repo: 'legacy/repo' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('threshold_exceeded');
    expect(result.detail).toContain('12 個');
  });

  it('countSkillsInRepo は外部 repo に noAuth: true で fetch する (= Authorization ヘッダなし)', async () => {
    // OneCLI secret の pathPattern (`/repos/HajimariInc/*`) miss で `Bearer placeholder` を素通しすると
    // GitHub が invalid token として 401 を返す問題への対策。外部 repo (anthropics/skills 等) を呼ぶ
    // countSkillsInRepo は ghFetch を `noAuth: true` で呼び出し、Authorization ヘッダを省略する。
    // 本テストは fetchMock の引数を直接見て Authorization が含まれないことを assert する。
    setupCloneSuccess();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(mockMarketplaceResponse([{ skills: ['./a', './b'] }]));
    await acquire({ repo: 'small/repo' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toContain('/repos/small/repo/contents/.claude-plugin/marketplace.json');
    const headers = (calledInit as { headers?: Record<string, string> }).headers ?? {};
    expect(headers).not.toHaveProperty('Authorization');
    // Accept / X-GitHub-Api-Version は載っていることを確認 (= ghFetch の通常 header は維持)
    expect(headers).toMatchObject({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  it('env ACQUIRE_SKILL_THRESHOLD="abc" (非数値) → default 10 に倒れ warn ログ', async () => {
    // `-5` は `< 1` 分岐で弾かれるが、`"abc"` は `parseInt → NaN` → `!Number.isFinite(NaN)`
    // 分岐で弾かれる別経路。両方の防御パスをカバーする。
    mockSpawn.mockImplementation((cmd) => spawnResult(cmd === 'gh' ? 0 : -1));
    mockReadEnvFile.mockReturnValue({ ACQUIRE_SKILL_THRESHOLD: 'abc' });
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      mockMarketplaceResponse([{ skills: Array.from({ length: 11 }, (_, i) => `./s-${i}`) }]),
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
