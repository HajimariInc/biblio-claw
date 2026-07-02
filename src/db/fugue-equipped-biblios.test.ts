/**
 * `fugue_equipped_biblios.ts` CRUD のユニットテスト (M4-E Phase 3 equip-hitl)。
 *
 * - insert 新規 → true / 既存同名 → false (`already_equipped` atomic 判定)
 * - getNames が装備中の biblio_name を全て返す
 * - deleteByName → 1 件削除、再 delete → 0 件
 * - insert → delete → insert が true (再装備可) = 焼却後の再仕入れフローに耐える
 *
 * fixture は `session-equipped-biblios.test.ts` の initTestDb / runMigrations の骨格を
 * 継承。fugue 側は agent_group / session を持たないため createAgentGroup / createSession
 * は不要 (= FK なし)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from './index.js';
import {
  deleteFugueEquippedBiblioByName,
  getFugueEquippedBiblioNames,
  insertFugueEquippedBiblio,
} from './fugue-equipped-biblios.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('fugue_equipped_biblios CRUD', () => {
  it('insert 新規: true を返し、getNames に載る', () => {
    const first = insertFugueEquippedBiblio('octocat--hello', 'req-001');
    expect(first).toBe(true);
    expect(getFugueEquippedBiblioNames()).toEqual(['octocat--hello']);
  });

  it('insert 既存同名: false を返し、`already_equipped` の atomic 判定に使える', () => {
    insertFugueEquippedBiblio('octocat--hello', 'req-001');
    const second = insertFugueEquippedBiblio('octocat--hello', 'req-002');
    expect(second).toBe(false);
    // 上書きされず初回装備の状態を保持 (= 監査ログとして正)
    expect(getFugueEquippedBiblioNames()).toEqual(['octocat--hello']);
  });

  it('getNames: 装備中の biblio_name を全て返す (order 未保証、Set 消費前提)', () => {
    insertFugueEquippedBiblio('a--one', 'req-a');
    insertFugueEquippedBiblio('b--two', 'req-b');
    insertFugueEquippedBiblio('c--three', 'req-c');
    const names = getFugueEquippedBiblioNames().sort();
    expect(names).toEqual(['a--one', 'b--two', 'c--three']);
  });

  it('getNames: 未装備なら空配列', () => {
    expect(getFugueEquippedBiblioNames()).toEqual([]);
  });

  it('deleteByName: 該当行を削除、changes=1', () => {
    insertFugueEquippedBiblio('will-be--gone', 'req-x');
    const changes = deleteFugueEquippedBiblioByName('will-be--gone');
    expect(changes).toBe(1);
    expect(getFugueEquippedBiblioNames()).toEqual([]);
  });

  it('deleteByName: 未装備なら changes=0 (焼却対象が未装備でも safe)', () => {
    const changes = deleteFugueEquippedBiblioByName('nonexist--nope');
    expect(changes).toBe(0);
  });

  it('insert → delete → insert: 2 回目 insert は true (再装備可) = 焼却後の再仕入れフローに耐える', () => {
    // 初回装備
    expect(insertFugueEquippedBiblio('phoenix--rise', 'req-1')).toBe(true);
    // 焼却で削除
    expect(deleteFugueEquippedBiblioByName('phoenix--rise')).toBe(1);
    expect(getFugueEquippedBiblioNames()).toEqual([]);
    // 再仕入れ後の再装備
    expect(insertFugueEquippedBiblio('phoenix--rise', 'req-2')).toBe(true);
    expect(getFugueEquippedBiblioNames()).toEqual(['phoenix--rise']);
  });

  it('insert: request_id / equipped_at は監査用として保持される (SELECT で確認)', () => {
    insertFugueEquippedBiblio('audit--target', 'req-audit-001');
    // API 経由での再露出はしないが、監査用途で raw SELECT を叩いたとき想定通りの内容
    const row = getDb()
      .prepare('SELECT biblio_name, equipped_at, request_id FROM fugue_equipped_biblios WHERE biblio_name = ?')
      .get('audit--target') as { biblio_name: string; equipped_at: string; request_id: string };
    expect(row.biblio_name).toBe('audit--target');
    expect(row.equipped_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row.request_id).toBe('req-audit-001');
  });
});
