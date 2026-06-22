import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'session-equipped-biblios',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE session_equipped_biblios (
        session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        biblio_name  TEXT NOT NULL,
        order_index  INTEGER NOT NULL,
        equipped_at  TEXT NOT NULL,
        PRIMARY KEY (session_id, biblio_name)
      );
      CREATE INDEX idx_session_equipped_biblios_session
        ON session_equipped_biblios(session_id, order_index);
    `);
  },
};
