/**
 * `session_equipped_biblios` テーブルの CRUD (M3 Phase 2)。
 *
 * 装備リストは session 単位で永続化し、`order_index` ASC で順序を保つ。
 * 更新は全置換 semantics (= `upsertEquippedBiblios` は DELETE + INSERT トランザクション)
 * に固定する。部分更新 = `deleteEquippedBiblioByName` (Phase 3、焼却で全 session から個別行を消す
 * = `equip.ts:79` の `fs.existsSync` skip 経路で warn が残るノイズを抑制)。1 件追加 / 1 件解除
 * の MCP tool (`equip_biblio` / `disequip_biblio`) は Phase 3.5 で `addEquippedBiblio` /
 * `removeEquippedBiblio` を別途足す。
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
 *
 * 入力に重複した biblio_name が含まれていても PK violation で throw せず、
 * 先着順で dedupe して INSERT する (= 呼び出し元に余計な責任を持たせない設計)。
 */
export function upsertEquippedBiblios(sessionId: string, biblioNames: string[]): void {
  const uniqueNames = [...new Set(biblioNames)];
  const db = getDb();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM session_equipped_biblios WHERE session_id = ?').run(sessionId);
    const ins = db.prepare(
      `INSERT INTO session_equipped_biblios (session_id, biblio_name, order_index, equipped_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const [i, name] of uniqueNames.entries()) ins.run(sessionId, name, i, now);
  })();
}

/** session の装備リストを全削除。`upsertEquippedBiblios(sessionId, [])` と等価。 */
export function clearEquippedBiblios(sessionId: string): void {
  getDb().prepare('DELETE FROM session_equipped_biblios WHERE session_id = ?').run(sessionId);
}

/**
 * 全 session から該当 `biblio_name` の行を削除する (= 焼却で全 session の装備リストから個別除去)。
 *
 * `biblioName` の validate は呼び出し側 (`shokyaku.ts` で `BIBLIO_NAME_RE.test` を通過済) に
 * 委ねる (= DB 層に validate を入れる設計を採らない、循環依存回避方針)。`order_index` の
 * 連番は意図的に詰めない (= 1 件削除で全 reindex すると `clearEquippedBiblios` 後の再装備
 * フローと semantics が混在するため、装備リストの順序はあくまで `upsertEquippedBiblios` の
 * 全置換 semantics に閉じる)。
 *
 * @returns 削除された行数 (= 該当 biblio が装備中だった session 数)。
 */
export function deleteEquippedBiblioByName(biblioName: string): number {
  const info = getDb().prepare('DELETE FROM session_equipped_biblios WHERE biblio_name = ?').run(biblioName);
  return info.changes;
}
