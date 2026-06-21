/**
 * `session_equipped_biblios.ts` CRUD のユニットテスト (M3 Phase 2)。
 *
 * - 空 session → 空配列
 * - upsert 3 件 → `order_index` 0/1/2 順で取得
 * - 再 upsert → 全置換 (= 前回分は消える)、`equipped_at` も上書き
 * - `clearEquippedBiblios` → 0 件
 * - 別 session に影響なし (= session 単位の独立性)
 * - session 削除で cascade delete (= migration の ON DELETE CASCADE)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createSession, deleteSession } from './index.js';
import {
  getEquippedBibliosBySession,
  upsertEquippedBiblios,
  clearEquippedBiblios,
  deleteEquippedBiblioByName,
} from './session-equipped-biblios.js';
import type { Session } from '../types.js';

function now() {
  return new Date().toISOString();
}

function makeSession(id: string): Session {
  return {
    id,
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: now(),
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: 'ag-test',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
});

describe('session_equipped_biblios CRUD', () => {
  it('未 upsert の session は空配列を返す', () => {
    createSession(makeSession('sess-empty'));
    expect(getEquippedBibliosBySession('sess-empty')).toEqual([]);
  });

  it('upsert 3 件は order_index 0/1/2 の順で取得できる', () => {
    createSession(makeSession('sess-1'));
    upsertEquippedBiblios('sess-1', ['octocat--hello', 'wf--alpha', 'biblio--zeta']);

    const rows = getEquippedBibliosBySession('sess-1');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.biblio_name)).toEqual(['octocat--hello', 'wf--alpha', 'biblio--zeta']);
    expect(rows.map((r) => r.order_index)).toEqual([0, 1, 2]);
    for (const r of rows) {
      expect(r.session_id).toBe('sess-1');
      expect(r.equipped_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('再 upsert は前回分を全置換する (= 全置換 semantics)', () => {
    createSession(makeSession('sess-2'));
    upsertEquippedBiblios('sess-2', ['a--one', 'b--two', 'c--three']);
    upsertEquippedBiblios('sess-2', ['d--four', 'e--five']);

    const rows = getEquippedBibliosBySession('sess-2');
    expect(rows.map((r) => r.biblio_name)).toEqual(['d--four', 'e--five']);
    expect(rows.map((r) => r.order_index)).toEqual([0, 1]);
  });

  it('clearEquippedBiblios で 0 件に戻る', () => {
    createSession(makeSession('sess-3'));
    upsertEquippedBiblios('sess-3', ['x--one', 'y--two']);
    expect(getEquippedBibliosBySession('sess-3')).toHaveLength(2);

    clearEquippedBiblios('sess-3');
    expect(getEquippedBibliosBySession('sess-3')).toEqual([]);
  });

  it('別 session の装備は影響を受けない (= session 単位の独立性)', () => {
    createSession(makeSession('sess-a'));
    createSession(makeSession('sess-b'));
    upsertEquippedBiblios('sess-a', ['only-a--biblio']);
    upsertEquippedBiblios('sess-b', ['only-b--one', 'only-b--two']);

    expect(getEquippedBibliosBySession('sess-a').map((r) => r.biblio_name)).toEqual(['only-a--biblio']);
    expect(getEquippedBibliosBySession('sess-b').map((r) => r.biblio_name)).toEqual(['only-b--one', 'only-b--two']);

    // clear 1 side だけで他方は残る
    clearEquippedBiblios('sess-a');
    expect(getEquippedBibliosBySession('sess-a')).toEqual([]);
    expect(getEquippedBibliosBySession('sess-b')).toHaveLength(2);
  });

  it('session 削除で cascade delete される (= ON DELETE CASCADE)', () => {
    createSession(makeSession('sess-cascade'));
    upsertEquippedBiblios('sess-cascade', ['will-be--gone']);
    expect(getEquippedBibliosBySession('sess-cascade')).toHaveLength(1);

    deleteSession('sess-cascade');
    expect(getEquippedBibliosBySession('sess-cascade')).toEqual([]);
  });

  it('upsert 入力に重複した biblio_name があっても先着順で dedupe して INSERT する', () => {
    createSession(makeSession('sess-dup'));
    // 重複 'a--one' を含む配列 → 先着順 dedup で [a--one, b--two] になり、
    // PK violation (= UNIQUE constraint failed) で throw しない
    upsertEquippedBiblios('sess-dup', ['a--one', 'b--two', 'a--one', 'c--three', 'b--two']);
    const rows = getEquippedBibliosBySession('sess-dup');
    expect(rows.map((r) => r.biblio_name)).toEqual(['a--one', 'b--two', 'c--three']);
    expect(rows.map((r) => r.order_index)).toEqual([0, 1, 2]);
  });

  // PR #21 pr-test-analyzer 重要 — 焼却の「全 session 装備リストから個別削除」設計の DB レベル保証。
  it('deleteEquippedBiblioByName: 複数 session を横断して同名 biblio を削除する (= shokyaku の全 session clear)', () => {
    createSession(makeSession('sess-x'));
    createSession(makeSession('sess-y'));
    upsertEquippedBiblios('sess-x', ['shared--biblio', 'only-x--one']);
    upsertEquippedBiblios('sess-y', ['shared--biblio', 'only-y--two']);

    const changes = deleteEquippedBiblioByName('shared--biblio');
    expect(changes).toBe(2); // 2 session から削除

    expect(getEquippedBibliosBySession('sess-x').map((r) => r.biblio_name)).toEqual(['only-x--one']);
    expect(getEquippedBibliosBySession('sess-y').map((r) => r.biblio_name)).toEqual(['only-y--two']);
  });

  it('deleteEquippedBiblioByName: 該当 entry が無くても 0 件削除で safe (= 焼却対象が装備されていない session を持つ場合)', () => {
    createSession(makeSession('sess-noequip'));
    // session はあるが装備なし
    const changes = deleteEquippedBiblioByName('not-equipped--anywhere');
    expect(changes).toBe(0);
  });
});
