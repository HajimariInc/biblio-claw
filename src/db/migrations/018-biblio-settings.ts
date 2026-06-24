import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * biblio_settings table — patron が `@bot 設定 <KEY> <VALUE>` で動的変更する設定値を
 * persist する key-value store (個別 PRD individual-skill-shiire Phase 5 dynamic-config)。
 *
 * `acquire.ts:resolveSkillThreshold` 等の resolve 関数が DB → env → DEFAULT の 3 層
 * fallback で値を引くため、初期行は不要 (= 空 table = env fallback で動く)。
 * 動的変更対象の key は `src/biblio/types.ts:BIBLIO_SETTING_KEYS` で allowlist 管理
 * (= delivery action handler 側で whitelist チェック、許可外 key は reject)。
 *
 * 016-boots.ts と同じ global singleton 系 table パターンだが、こちらは複数 key を
 * 並べる前提のため `id INTEGER PRIMARY KEY CHECK (id = 1)` ではなく `key TEXT PRIMARY KEY`。
 */
export const migration018: Migration = {
  version: 18,
  name: 'biblio-settings',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS biblio_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
};
