/**
 * `equip.ts` (= 装備機構の物理配置解決) のユニットテスト。
 *
 * DB lookup 経路を検証する。test setup で `initTestDb` + `runMigrations` +
 * session 作成 + `upsertEquippedBiblios` で装備リストを seed して、
 * `resolveEquippedBiblios` が DB 経路で正しく返すかを確認する。
 *
 * Case 一覧:
 * - DB 装備 0 件 (env も未設定) → 空配列、warn なし
 * - BIBLIO_NAME_RE 不通過 (DB に invalid name 登録) → warn + skip
 * - 物理 dir 不在 → warn + skip
 * - 正常 1 件: EquippedBiblio 形が正しい
 * - 複数装備: `order_index` ASC 順で返る
 * - 一部 invalid / 一部 正常 を混ぜると、無効は warn skip し有効のみ返る
 * - `opts.equipmentRoot` で root を override
 * - 空 segment / 連続装備 (DB は order_index で素直に列挙)
 * - 大文字 / 数字 / `.` / `_` を含む正規 owner--name も受理
 * - env override: env が明示セットされていれば DB を bypass する (テスト bd 経路)
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

import { initTestDb, closeDb, runMigrations, createAgentGroup, createSession } from '../db/index.js';
import { upsertEquippedBiblios } from '../db/session-equipped-biblios.js';
import { log } from '../log.js';
import type { Session } from '../types.js';

import { resolveEquippedBiblios } from './equip.js';

const SESSION_ID = 'sess-equip-test';

/** 最小 Session stub — equip.ts は session.id のみ使う。 */
function makeSession(id = SESSION_ID): Session {
  return {
    id,
    agent_group_id: 'ag-equip-test',
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

  // DB セットアップ + test session を ensure
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: 'ag-equip-test',
    name: 'Equip Test Agent',
    folder: 'equip-test-agent',
    agent_provider: null,
    created_at: new Date(0).toISOString(),
  });
  createSession(makeSession());

  // env override は test 単位で明示的に設定する場合のみ。デフォルトは「未設定」を保証
  // (= 他テストからの汚染で stub が残っている場合に備え、毎回 unstub)。
  vi.unstubAllEnvs();
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  vi.unstubAllEnvs();
  closeDb();
});

describe('resolveEquippedBiblios (DB-driven)', () => {
  it('DB 装備 0 件 (env も未設定) なら空配列を返し warn しない', async () => {
    const result = await resolveEquippedBiblios(makeSession());
    expect(result).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('invalid name (BIBLIO_NAME_RE 不通過) は warn + skip', async () => {
    upsertEquippedBiblios(SESSION_ID, ['../etc/passwd']);
    const result = await resolveEquippedBiblios(makeSession());
    expect(result).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('invalid biblio name'),
      expect.objectContaining({ name: '../etc/passwd' }),
    );
  });

  it('owner--name 形式でも物理 dir が無ければ warn + skip', async () => {
    upsertEquippedBiblios(SESSION_ID, ['octocat--hello']);
    const result = await resolveEquippedBiblios(makeSession());
    expect(result).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('not found'),
      expect.objectContaining({ name: 'octocat--hello' }),
    );
  });

  it('正常: dir 存在で EquippedBiblio が 1 件返る', async () => {
    seedBiblio('octocat--hello');
    upsertEquippedBiblios(SESSION_ID, ['octocat--hello']);
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

  it('複数装備は order_index ASC 順で返り、各 entry が独立する', async () => {
    seedBiblio('a--one');
    seedBiblio('b--two');
    seedBiblio('c--three');
    upsertEquippedBiblios(SESSION_ID, ['b--two', 'a--one', 'c--three']);
    const result = await resolveEquippedBiblios(makeSession());
    expect(result.map((b) => b.name)).toEqual(['b--two', 'a--one', 'c--three']);
    for (const b of result) {
      expect(b.sourcePath).toBe(path.join(EQUIP_DIR, b.name));
      expect(b.mountPath).toBe(`/workspace/biblios/${b.name}`);
    }
  });

  it('一部 invalid / 一部 正常 を混ぜると、無効は warn skip し有効のみ返る', async () => {
    seedBiblio('ok--good');
    upsertEquippedBiblios(SESSION_ID, ['../bad', 'ok--good', 'missing--dir']);
    const result = await resolveEquippedBiblios(makeSession());
    expect(result.map((b) => b.name)).toEqual(['ok--good']);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('opts.equipmentRoot を渡すと custom root が使われる (DATA_DIR 罠回避フック)', async () => {
    const customRoot = path.join(TEST_DIR, 'alt-root');
    seedBiblio('custom--biblio', customRoot);
    upsertEquippedBiblios(SESSION_ID, ['custom--biblio']);
    const result = await resolveEquippedBiblios(makeSession(), { equipmentRoot: customRoot });
    expect(result).toEqual([
      {
        name: 'custom--biblio',
        sourcePath: path.join(customRoot, 'custom--biblio'),
        mountPath: '/workspace/biblios/custom--biblio',
      },
    ]);
  });

  it('大文字 / 数字 / `.` / `_` を含む正規 owner--name も受理する (RE 文字クラスの regression 防止)', async () => {
    const name = 'MyOrg123--Repo.Name_v2';
    seedBiblio(name);
    upsertEquippedBiblios(SESSION_ID, [name]);
    const result = await resolveEquippedBiblios(makeSession());
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe(name);
    expect(log.warn).not.toHaveBeenCalled();
  });

  // env override = test only backdoor (= DB を持たずに装備リストを差し込む経路)。
  // 本番 host では env をセットしないので、DB 経路が優先される (= 既存テスト群が
  // それを担保)。env override 経路自体の動作も 1 件だけ確認する。
  it('env override: BIBLIO_EQUIPPED_NAMES が明示セットされていれば DB を bypass する', async () => {
    // DB には別の装備を入れて、env が勝つことを確認
    seedBiblio('db--side');
    seedBiblio('env--side');
    upsertEquippedBiblios(SESSION_ID, ['db--side']);
    vi.stubEnv('BIBLIO_EQUIPPED_NAMES', 'env--side');
    const result = await resolveEquippedBiblios(makeSession());
    expect(result.map((b) => b.name)).toEqual(['env--side']);
  });

  it('env override 空文字も DB を bypass する (= csv 解析で 0 件と評価)', async () => {
    seedBiblio('db--side');
    upsertEquippedBiblios(SESSION_ID, ['db--side']);
    vi.stubEnv('BIBLIO_EQUIPPED_NAMES', '');
    const result = await resolveEquippedBiblios(makeSession());
    expect(result).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
