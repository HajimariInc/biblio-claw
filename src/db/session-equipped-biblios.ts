/**
 * `session_equipped_biblios` テーブルの CRUD (M3 Phase 2)。
 *
 * 装備リストは session 単位で永続化し、`order_index` ASC で順序を保つ。
 * 更新は全置換 semantics (= `upsertEquippedBiblios` は DELETE + INSERT トランザクション)
 * に固定する。部分更新 (= 1 件追加 / 1 件解除) は Phase 3 で別 API を足す。
 */
import { getDb } from './connection.js';

export interface EquippedBiblioRow {
  session_id: string;
  biblio_name: string;
  order_index: number;
  equipped_at: string;
}

/** session の装備リストを `order_index` ASC で返す。装備なしなら空配列。 */
export function getEquippedBibliosBySession(sessionId: string): EquippedBiblioRow[] {
  return getDb()
    .prepare('SELECT * FROM session_equipped_biblios WHERE session_id = ? ORDER BY order_index ASC')
    .all(sessionId) as EquippedBiblioRow[];
}

/**
 * session の装備リストを全置換する。
 *
 * 既存行を DELETE してから新しい `biblioNames` を `order_index` 0, 1, 2, ... で
 * INSERT する。空配列を渡せば全解除と同義。トランザクションで包むので中途半端な
 * 状態は残らない。
 */
export function upsertEquippedBiblios(sessionId: string, biblioNames: string[]): void {
  const db = getDb();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM session_equipped_biblios WHERE session_id = ?').run(sessionId);
    const ins = db.prepare(
      `INSERT INTO session_equipped_biblios (session_id, biblio_name, order_index, equipped_at)
       VALUES (?, ?, ?, ?)`,
    );
    biblioNames.forEach((name, i) => ins.run(sessionId, name, i, now));
  });
  tx();
}

/** session の装備リストを全削除。`upsertEquippedBiblios(sessionId, [])` と等価。 */
export function clearEquippedBiblios(sessionId: string): void {
  getDb().prepare('DELETE FROM session_equipped_biblios WHERE session_id = ?').run(sessionId);
}
