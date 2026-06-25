/**
 * biblio_settings CRUD — `@bot 設定 <KEY> <VALUE>` で patron が動的変更する設定値の
 * 永続化レイヤ (個別 PRD individual-skill-shiire Phase 5 dynamic-config)。
 *
 * 動的変更可能 key の allowlist は `src/biblio/types.ts:BIBLIO_SETTING_KEYS` に集約。
 * 本ファイルは CRUD の機械的操作のみを提供し、allowlist チェックは action handler
 * (`src/biblio/config-action.ts`) 側で行う (= 役割分離、CLI 経由の任意 key 操作は
 * verify script で必要になる)。
 *
 * `getDb()` を関数内で都度呼ぶ (= module load 時に呼ばない、`initDb` 前 import 安全性)。
 * container-configs.ts と同流儀。
 */
import { getDb } from './connection.js';

export interface BiblioSettingRow {
  key: string;
  value: string;
  updated_at: string;
}

/** key に対応する value を返す。未存在は undefined。 */
export function getBiblioSetting(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM biblio_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

/** key に value を upsert する (既存なら上書き、updated_at は now)。 */
export function setBiblioSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO biblio_settings (key, value, updated_at)
       VALUES (?, ?, ?)`,
    )
    .run(key, value, new Date().toISOString());
}

/** 全 setting 行を返す (= 運用 / debug 用、verify script で `:` 区切り全件確認に使う)。 */
export function getAllBiblioSettings(): BiblioSettingRow[] {
  return getDb().prepare('SELECT key, value, updated_at FROM biblio_settings').all() as BiblioSettingRow[];
}

/** key を削除する (存在しなくても no-op = 冪等)。 */
export function deleteBiblioSetting(key: string): void {
  getDb().prepare('DELETE FROM biblio_settings WHERE key = ?').run(key);
}
