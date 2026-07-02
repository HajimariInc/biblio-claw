import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * fugue_equipped_biblios table — Fugue channel の装備状態を channel-scoped で永続化する
 * (M4-E Phase 3 equip-hitl)。
 *
 * `session_equipped_biblios` (M3 Phase 2) は `sessions(id)` への FK NOT NULL + `foreign_keys=ON`
 * enforced (`src/db/connection.ts:18,26`) のため、`supportsThreads: false` (= session 概念なし)
 * の Fugue からは書けない。channel-scoped な独立テーブルを新設することで、Fugue Director の
 * 装備セットを 1 つに閉じる。
 *
 * カラム:
 *   - `biblio_name`  TEXT PRIMARY KEY  — 棚 item の name (`BIBLIO_NAME_RE` 通過済、handler 側 guard)
 *   - `equipped_at`  TEXT NOT NULL     — ISO8601 UTC 時刻 (equip 実行時)
 *   - `request_id`   TEXT NOT NULL     — 監査用 (どの Fugue リクエストが装備したか)
 *
 * FK なし = sessions/agent_groups への依存なし (判断 A、`session_equipped_biblios` との対照)。
 * order_index / trigger_rules 等の順序概念は持たない (= consult は membership 判定のみに使う)。
 */
export const migration019: Migration = {
  version: 19,
  name: 'fugue-equipped-biblios',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE fugue_equipped_biblios (
        biblio_name  TEXT PRIMARY KEY,
        equipped_at  TEXT NOT NULL,
        request_id   TEXT NOT NULL
      );
    `);
  },
};
