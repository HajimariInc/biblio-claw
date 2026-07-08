import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/biblio-container-runner-test-${process.pid}` }));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import type { VolumeMount } from './providers/provider-container-registry.js';
import type { Session } from './types.js';

import { appendEquippedBiblioMounts, resolveProviderName } from './container-runner.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup, createSession } from './db/index.js';
import { upsertEquippedBiblios } from './db/session-equipped-biblios.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('appendEquippedBiblioMounts (env override 経路)', () => {
  const EQUIP_DIR = path.join(TEST_DIR, 'biblio-equipped');

  function makeSession(id = 'sess-m3'): Session {
    return {
      id,
      agent_group_id: 'ag-m3',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'idle',
      last_active: null,
      created_at: new Date(0).toISOString(),
    };
  }

  function seedBiblio(name: string): void {
    fs.mkdirSync(path.join(EQUIP_DIR, name), { recursive: true });
    fs.writeFileSync(path.join(EQUIP_DIR, name, 'marker.txt'), `m-${name}`);
  }

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    vi.unstubAllEnvs();
  });

  it('env 未設定なら mounts に何も追加しない', async () => {
    vi.stubEnv('BIBLIO_EQUIPPED_NAMES', '');
    const mounts: VolumeMount[] = [];
    await appendEquippedBiblioMounts(mounts, makeSession(), TEST_DIR);
    expect(mounts).toEqual([]);
  });

  it('1 件装備: mount 1 件が末尾に追加され、subPath / containerPath / readonly が正しい', async () => {
    seedBiblio('octocat--hello');
    vi.stubEnv('BIBLIO_EQUIPPED_NAMES', 'octocat--hello');
    const mounts: VolumeMount[] = [];
    await appendEquippedBiblioMounts(mounts, makeSession(), TEST_DIR);
    expect(mounts).toEqual([
      {
        hostPath: path.join(EQUIP_DIR, 'octocat--hello'),
        subPath: 'biblio-equipped/octocat--hello',
        containerPath: '/workspace/biblios/octocat--hello',
        readonly: true,
      },
    ]);
  });

  it('複数装備 (csv 3 件): csv 順序を維持して全て append される', async () => {
    seedBiblio('a--one');
    seedBiblio('b--two');
    seedBiblio('c--three');
    vi.stubEnv('BIBLIO_EQUIPPED_NAMES', 'c--three,a--one,b--two');
    const mounts: VolumeMount[] = [];
    await appendEquippedBiblioMounts(mounts, makeSession(), TEST_DIR);
    expect(mounts.map((m) => m.containerPath)).toEqual([
      '/workspace/biblios/c--three',
      '/workspace/biblios/a--one',
      '/workspace/biblios/b--two',
    ]);
    for (const m of mounts) {
      expect(m.readonly).toBe(true);
      expect(m.subPath).toMatch(/^biblio-equipped\//);
    }
  });

  it('既存の mounts には影響を与えず末尾に追加する', async () => {
    seedBiblio('mine--biblio');
    vi.stubEnv('BIBLIO_EQUIPPED_NAMES', 'mine--biblio');
    const existing: VolumeMount = {
      hostPath: path.join(TEST_DIR, 'v2-sessions/x/y'),
      subPath: 'v2-sessions/x/y',
      containerPath: '/workspace',
      readonly: false,
    };
    const mounts: VolumeMount[] = [existing];
    await appendEquippedBiblioMounts(mounts, makeSession(), TEST_DIR);
    expect(mounts.length).toBe(2);
    expect(mounts[0]).toEqual(existing);
    expect(mounts[1].containerPath).toBe('/workspace/biblios/mine--biblio');
  });

  it('物理 dir が無い entry は skip され mount に出ない', async () => {
    seedBiblio('exists--ok');
    // env 上は 2 件、片方は dir 不在
    vi.stubEnv('BIBLIO_EQUIPPED_NAMES', 'exists--ok,missing--gone');
    const mounts: VolumeMount[] = [];
    await appendEquippedBiblioMounts(mounts, makeSession(), TEST_DIR);
    expect(mounts.length).toBe(1);
    expect(mounts[0].containerPath).toBe('/workspace/biblios/exists--ok');
  });
});

// 本番の DB lookup 経路 + VolumeMount 組み立ての integration test。
// env override 経路は上の describe で網羅、DB 経路 (= 本番経路) は equip.test.ts で
// resolveEquippedBiblios 単体まで担保されていたが、appendEquippedBiblioMounts × DB lookup × mount
// 変換の経路が unit レベルで未検証だった。GKE 本番で装備 mount が生えない silent fail を防ぐ。
describe('appendEquippedBiblioMounts (DB 経路 integration)', () => {
  const EQUIP_DIR = path.join(TEST_DIR, 'biblio-equipped');

  function makeSession(id = 'sess-m3-db'): Session {
    return {
      id,
      agent_group_id: 'ag-m3-db',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'idle',
      last_active: null,
      created_at: new Date(0).toISOString(),
    };
  }

  function seedBiblio(name: string): void {
    fs.mkdirSync(path.join(EQUIP_DIR, name), { recursive: true });
    fs.writeFileSync(path.join(EQUIP_DIR, name, 'marker.txt'), `m-${name}`);
  }

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    vi.unstubAllEnvs();
    // env override を意図的に「未設定」状態にして DB 経路にフォールスルーさせる
    // (equip.ts:60-62 は `process.env[ENV_NAME] === undefined` のみ DB lookup へ)。
    delete process.env.BIBLIO_EQUIPPED_NAMES;
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: 'ag-m3-db',
      name: 'M3 DB Agent',
      folder: 'ag-m3-db',
      agent_provider: null,
      created_at: new Date(0).toISOString(),
    });
    createSession(makeSession());
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    vi.unstubAllEnvs();
  });

  it('DB 経路: session_equipped_biblios から装備リストを取得して VolumeMount に変換する', async () => {
    seedBiblio('octocat--hello');
    upsertEquippedBiblios('sess-m3-db', ['octocat--hello']);
    const mounts: VolumeMount[] = [];
    await appendEquippedBiblioMounts(mounts, makeSession(), TEST_DIR);
    expect(mounts).toEqual([
      {
        hostPath: path.join(EQUIP_DIR, 'octocat--hello'),
        subPath: 'biblio-equipped/octocat--hello',
        containerPath: '/workspace/biblios/octocat--hello',
        readonly: true,
      },
    ]);
  });

  it('DB 経路: 複数装備 (order_index 順) で全件 append、各 mount は readonly + subPath で K8s 対応', async () => {
    seedBiblio('a--one');
    seedBiblio('b--two');
    seedBiblio('c--three');
    // DB に c → a → b 順で upsert (= order_index 0 → c, 1 → a, 2 → b)
    upsertEquippedBiblios('sess-m3-db', ['c--three', 'a--one', 'b--two']);
    const mounts: VolumeMount[] = [];
    await appendEquippedBiblioMounts(mounts, makeSession(), TEST_DIR);
    expect(mounts.map((m) => m.containerPath)).toEqual([
      '/workspace/biblios/c--three',
      '/workspace/biblios/a--one',
      '/workspace/biblios/b--two',
    ]);
    for (const m of mounts) {
      expect(m.readonly).toBe(true);
      expect(m.subPath).toMatch(/^biblio-equipped\//);
    }
  });

  it('DB 経路: DB にあるが物理 dir が無い entry は skip (= 焼却後の dangling entry を warn skip)', async () => {
    seedBiblio('exists--ok');
    upsertEquippedBiblios('sess-m3-db', ['exists--ok', 'missing--gone']);
    const mounts: VolumeMount[] = [];
    await appendEquippedBiblioMounts(mounts, makeSession(), TEST_DIR);
    expect(mounts.length).toBe(1);
    expect(mounts[0].containerPath).toBe('/workspace/biblios/exists--ok');
  });
});
