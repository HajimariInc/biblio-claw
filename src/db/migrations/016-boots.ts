import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * boots テーブル + 初期行 (id=1, count=0) を作成する。
 *
 * Phase 2 verify 用の決定的指紋 (PoC-13 写経): Pod 再作成跨ぎで count が
 * monotonic increment することで PVC + SQLite の永続化が機能していることを
 * assertion する。テーブルは「同 PVC を再 attach した orchestrator が必ず
 * 1 行だけ持つ」ように id を CHECK で 1 固定にする。
 *
 * 初期行を migration で挿入しておけば、boot-counter.ts は単純な UPDATE で
 * count を増分できる (INSERT...ON CONFLICT を持たない古い SQLite でも安全)。
 */
export const migration016: Migration = {
  version: 16,
  name: 'boots',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS boots (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        count        INTEGER NOT NULL DEFAULT 0,
        last_boot_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO boots (id, count, last_boot_at)
      VALUES (1, 0, datetime('now'));
    `);
  },
};
