/**
 * `equip.ts` (= 装備機構の物理配置解決) のユニットテスト。
 *
 * - env 未/空: 空配列、warn なし
 * - BIBLIO_NAME_RE 不通過: warn + skip
 * - 物理 dir 不在: warn + skip
 * - 正常 1 件: EquippedBiblio 形が正しい
 * - 複数 csv: 順序維持、各 entry 独立
 * - opts.equipmentRoot で root を override
 *
 * fs は /tmp の実ディレクトリ (DATA_DIR を mock で TEST_DIR に差し替え)、
 * log は mock。acquire.test.ts のパターンを踏襲。
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/biblio-equip-test-${process.pid}` }));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { log } from '../log.js';
import type { Session } from '../types.js';

import { resolveEquippedBiblios } from './equip.js';

/** 最小 Session stub — equip.ts は session.id のみ使う。 */
function makeSession(id = 'sess-test-1'): Session {
  return {
    id,
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: new Date(0).toISOString(),
  };
}

const EQUIP_DIR = path.join(TEST_DIR, 'biblio-equipped');

/** 装備物理 dir + marker を仕掛けるヘルパ。 */
function seedBiblio(name: string, root = EQUIP_DIR): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'marker.txt'), `marker-${name}`);
  return dir;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  vi.mocked(log.warn).mockClear();
  vi.unstubAllEnvs();
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  vi.unstubAllEnvs();
});

describe('resolveEquippedBiblios', () => {
  it('env 未設定なら空配列を返し warn しない', async () => {
    // 環境を clean に: 念のため undefined にする
    vi.stubEnv('BIBLIO_EQUIPPED_NAMES', '');
    const result = await resolveEquippedBiblios(makeSession());
    expect(result).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('env が空白のみなら空配列を返す', async () => {
    vi.stubEnv('BIBLIO_EQUIPPED_NAMES', '   ');
    const result = await resolveEquippedBiblios(makeSession());
    expect(result).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('invalid name (BIBLIO_NAME_RE 不通過) は warn + skip', async () => {
    vi.stubEnv('BIBLIO_EQUIPPED_NAMES', '../etc/passwd');
    const result = await resolveEquippedBiblios(makeSession());
    expect(result).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('invalid biblio name'),
      expect.objectContaining({ name: '../etc/passwd' }),
    );
  });

  it('owner--name 形式でも物理 dir が無ければ warn + skip', async () => {
    vi.stubEnv('BIBLIO_EQUIPPED_NAMES', 'octocat--hello');
    const result = await resolveEquippedBiblios(makeSession());
    expect(result).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('not found'),
      expect.objectContaining({ name: 'octocat--hello' }),
    );
  });

  it('正常: dir 存在で EquippedBiblio が 1 件返る', async () => {
    seedBiblio('octocat--hello');
    vi.stubEnv('BIBLIO_EQUIPPED_NAMES', 'octocat--hello');
    const result = await resolveEquippedBiblios(makeSession());
    expect(result).toEqual([
      {
        name: 'octocat--hello',
        sourcePath: path.join(EQUIP_DIR, 'octocat--hello'),
        mountPath: '/workspace/biblios/octocat--hello',
      },
    ]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('複数 csv は csv 順を維持し、各 entry が独立して返る', async () => {
    seedBiblio('a--one');
    seedBiblio('b--two');
    seedBiblio('c--three');
    vi.stubEnv('BIBLIO_EQUIPPED_NAMES', 'b--two,a--one,c--three');
    const result = await resolveEquippedBiblios(makeSession());
    expect(result.map((b) => b.name)).toEqual(['b--two', 'a--one', 'c--three']);
    for (const b of result) {
      expect(b.sourcePath).toBe(path.join(EQUIP_DIR, b.name));
      expect(b.mountPath).toBe(`/workspace/biblios/${b.name}`);
    }
  });

  it('一部 invalid / 一部 正常 を混ぜると、無効は warn skip し有効のみ返る', async () => {
    seedBiblio('ok--good');
    vi.stubEnv('BIBLIO_EQUIPPED_NAMES', '../bad, ok--good, missing--dir');
    const result = await resolveEquippedBiblios(makeSession());
    expect(result.map((b) => b.name)).toEqual(['ok--good']);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('opts.equipmentRoot を渡すと custom root が使われる (DATA_DIR 罠回避フック)', async () => {
    const customRoot = path.join(TEST_DIR, 'alt-root');
    seedBiblio('custom--biblio', customRoot);
    vi.stubEnv('BIBLIO_EQUIPPED_NAMES', 'custom--biblio');
    const result = await resolveEquippedBiblios(makeSession(), { equipmentRoot: customRoot });
    expect(result).toEqual([
      {
        name: 'custom--biblio',
        sourcePath: path.join(customRoot, 'custom--biblio'),
        mountPath: '/workspace/biblios/custom--biblio',
      },
    ]);
  });

  it('空 segment (連続 comma) は無視される', async () => {
    seedBiblio('alpha--beta');
    vi.stubEnv('BIBLIO_EQUIPPED_NAMES', ',,alpha--beta,,');
    const result = await resolveEquippedBiblios(makeSession());
    expect(result.map((b) => b.name)).toEqual(['alpha--beta']);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('大文字 / 数字 / `.` / `_` を含む正規 owner--name も受理する (RE 文字クラスの regression 防止)', async () => {
    const name = 'MyOrg123--Repo.Name_v2';
    seedBiblio(name);
    vi.stubEnv('BIBLIO_EQUIPPED_NAMES', name);
    const result = await resolveEquippedBiblios(makeSession());
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe(name);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
