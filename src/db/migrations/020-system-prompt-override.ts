/**
 * M4-H Phase 3.5 = `system-prompt-override`.
 *
 * `container_configs.system_prompt_override TEXT` 列を追加する。
 * agent-runner (`providers/claude.ts`) が SDK に `systemPrompt: <string>` を直渡しする
 * custom mode を選択可能にするため、per-agent-group で system prompt full 文を持たせる。
 *
 * fugue-ask-biblio-shisho agent group のみに fugue-ask.md (~300 行) を投入する運用で、
 * 他の group は NULL のまま = 既存 preset 経路 (`{type:'preset', preset:'claude_code',
 * append: instructions}`) を継続。
 *
 * ALTER TABLE ADD COLUMN は FK-safe (migration 011 の table rebuild で踏んだ罠を回避)。
 * DEFAULT 指定なし = 既存 row は NULL (regression zero)。
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration020: Migration = {
  version: 20,
  name: 'system-prompt-override',
  up: (db: Database.Database) => {
    const cols = db.prepare("PRAGMA table_info('container_configs')").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'system_prompt_override')) {
      db.exec(`ALTER TABLE container_configs ADD COLUMN system_prompt_override TEXT`);
    }
  },
};
