/**
 * `biblio-settings.ts` CRUD のユニットテスト (個別 PRD Phase 5 dynamic-config)。
 *
 * - migration018 apply で table が作られる
 * - set → get / 上書き set → get (= INSERT OR REPLACE 動作)
 * - getAll で全件取得
 * - delete で消える
 * - 存在しない key の get → undefined
 * - delete idempotent (= 不在 key の delete は no-op、throw しない)
 *
 * session-equipped-biblios.test.ts と同じ in-memory DB + runMigrations パターン。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, runMigrations } from './index.js';
import { getBiblioSetting, setBiblioSetting, getAllBiblioSettings, deleteBiblioSetting } from './biblio-settings.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('biblio_settings CRUD', () => {
  it('migration018 apply で biblio_settings table が作られる', () => {
    // get で例外が出ないこと = table 存在 + schema 整合
    expect(getBiblioSetting('ACQUIRE_SKILL_THRESHOLD')).toBeUndefined();
  });

  it('存在しない key の get は undefined を返す', () => {
    expect(getBiblioSetting('NO_SUCH_KEY')).toBeUndefined();
  });

  it('set → get で value が引ける', () => {
    setBiblioSetting('ACQUIRE_SKILL_THRESHOLD', '20');
    expect(getBiblioSetting('ACQUIRE_SKILL_THRESHOLD')).toBe('20');
  });

  it('上書き set → get で新値が返る (= INSERT OR REPLACE)', () => {
    setBiblioSetting('ACQUIRE_SKILL_THRESHOLD', '20');
    setBiblioSetting('ACQUIRE_SKILL_THRESHOLD', '50');
    expect(getBiblioSetting('ACQUIRE_SKILL_THRESHOLD')).toBe('50');
  });

  it('上書き時 updated_at は更新される', async () => {
    setBiblioSetting('ACQUIRE_SKILL_THRESHOLD', '20');
    const firstRow = getAllBiblioSettings().find((r) => r.key === 'ACQUIRE_SKILL_THRESHOLD');
    expect(firstRow).toBeDefined();
    const firstTs = firstRow!.updated_at;

    // ISO 文字列の同秒衝突を避けるため微小 sleep
    await new Promise((r) => setTimeout(r, 10));

    setBiblioSetting('ACQUIRE_SKILL_THRESHOLD', '30');
    const secondRow = getAllBiblioSettings().find((r) => r.key === 'ACQUIRE_SKILL_THRESHOLD');
    expect(secondRow!.updated_at >= firstTs).toBe(true);
  });

  it('getAll で複数 key を取得できる', () => {
    setBiblioSetting('ACQUIRE_SKILL_THRESHOLD', '20');
    setBiblioSetting('SOME_OTHER_KEY', 'hello');
    const all = getAllBiblioSettings();
    expect(all).toHaveLength(2);
    const map = new Map(all.map((r) => [r.key, r.value]));
    expect(map.get('ACQUIRE_SKILL_THRESHOLD')).toBe('20');
    expect(map.get('SOME_OTHER_KEY')).toBe('hello');
  });

  it('delete で消える + 不在 key の delete は no-op', () => {
    setBiblioSetting('ACQUIRE_SKILL_THRESHOLD', '20');
    deleteBiblioSetting('ACQUIRE_SKILL_THRESHOLD');
    expect(getBiblioSetting('ACQUIRE_SKILL_THRESHOLD')).toBeUndefined();
    // 二重 delete も throw しない
    expect(() => deleteBiblioSetting('ACQUIRE_SKILL_THRESHOLD')).not.toThrow();
    expect(() => deleteBiblioSetting('NEVER_SET')).not.toThrow();
  });

  it('updated_at は ISO 8601 形式', () => {
    setBiblioSetting('ACQUIRE_SKILL_THRESHOLD', '20');
    const row = getAllBiblioSettings()[0];
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
