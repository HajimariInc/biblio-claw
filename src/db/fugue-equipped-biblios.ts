/**
 * `fugue_equipped_biblios` テーブルの CRUD (M4-E Phase 3 equip-hitl)。
 *
 * Fugue channel は `supportsThreads: false` = session 概念なしのため、`session_equipped_biblios`
 * (session FK NOT NULL) には書けない。channel-scoped で 1 つの装備セット (Fugue Director の view)
 * を持つ設計 (判断 A、`019-fugue-equipped-biblios.ts` 参照)。
 *
 * 用途:
 *   - `insertFugueEquippedBiblio`: equip endpoint の実行本体 (`INSERT OR IGNORE` + `changes` 判定で
 *     `equipped` / `already_equipped` を atomic に判別、race-free)
 *   - `getFugueEquippedBiblioNames`: **consult 応答のみ**で `SkillRef.equipped` を実データ化する
 *     ための membership 判定用 (Fugue 契約 §5.2)。equip 応答は `insertFugueEquippedBiblio` 成功
 *     直後に「対象 skill_id を装備した」既知の状態を `new Set([skill_id])` で直接構築するため、
 *     equip 経路では本関数を呼ばない (DB 再読み出し不要)
 *   - `deleteFugueEquippedBiblioByName`: 焼却 (shokyaku) 時の cleanup (`shokyaku.ts` から呼出、
 *     `deleteEquippedBiblioByName` (session 側) と並置)
 *
 * biblio_name の validate は呼び出し側 (fugue-http.ts の `handleEquip` で `BIBLIO_NAME_RE` guard を
 * 通過済) に委ねる = DB 層に validate を入れる設計を採らない (循環依存回避、
 * `session-equipped-biblios.ts:59` の設計方針と同じ)。
 */
import { getDb } from './connection.js';

export interface FugueEquippedBiblioRow {
  biblio_name: string;
  equipped_at: string;
  request_id: string;
}

/**
 * INSERT OR IGNORE で装備を記録する。既に同名の行があれば ignore (= 上書きしない、
 * `equipped_at` / `request_id` は初回装備時の値を保持する = 監査ログとして正)。
 *
 * @param biblioName BIBLIO_NAME_RE 通過済の棚 item 名 (呼び出し側 handler で guard 済)
 * @param requestId Fugue リクエストの `request_id` (監査用、Zod で max 64 chars)
 * @returns true = 新規装備 (`equipped`) / false = 既装備 (`already_equipped`)
 *
 * `info.changes === 0` が already_equipped の atomic 判定 (SELECT→INSERT の 2 段にしない、
 * race-free、判断 C)。
 */
export function insertFugueEquippedBiblio(biblioName: string, requestId: string): boolean {
  const info = getDb()
    .prepare('INSERT OR IGNORE INTO fugue_equipped_biblios (biblio_name, equipped_at, request_id) VALUES (?, ?, ?)')
    .run(biblioName, new Date().toISOString(), requestId);
  return info.changes > 0;
}

/**
 * 装備中の biblio_name 一覧を返す (= **consult 応答**で `SkillRef.equipped` を実データ化するため)。
 *
 * 順序保証なし (fugue 側は order 概念を持たないため、consult は `Set` に投入して membership 判定
 * のみに使う)。0 件なら空配列。
 *
 * **equip 経路は呼ばない**: equip は `insertFugueEquippedBiblio` 成功直後に「対象 skill_id が
 * 装備された」既知の状態を持つため、`new Set([skill_id])` を直接構築して `toSkillRefs` に渡す
 * (`fugue-http.ts:handleEquip` 成功パス参照)。DB 再読み出しは不要 = round-trip 節約 + 直後の
 * 別リクエストが並列に走っていても本 equip 応答の `SkillRef.equipped` は自身の書き込みを
 * 反映する構造。
 */
export function getFugueEquippedBiblioNames(): string[] {
  // 型 cast は `FugueEquippedBiblioRow` (biblio_name / equipped_at / request_id) に結線 =
  // migration 019 のカラム定義が変わったとき Row 型の追従漏れを compile-time で検知する
  // (PR #117 review、type-design-analyzer 案 (b))。SELECT は biblio_name のみだが、Row 型は
  // 全カラムを持つため .map の r.biblio_name アクセスは narrow 型で保証される。
  return (getDb().prepare('SELECT biblio_name FROM fugue_equipped_biblios').all() as FugueEquippedBiblioRow[]).map(
    (r) => r.biblio_name,
  );
}

/**
 * 該当 biblio_name の行を削除する (= 焼却 cleanup)。
 *
 * `deleteEquippedBiblioByName` (session 側) と並置する呼出。焼却 (shokyaku) は物理削除 + 装備状態除去
 * = 再装備不可を担保する意味論。禁書 (enkin) は装備状態を残置する = 再装備可 (session 側と同じ対称性)。
 *
 * @returns 削除された行数 (0 or 1、biblio_name は PK)
 */
export function deleteFugueEquippedBiblioByName(biblioName: string): number {
  const info = getDb().prepare('DELETE FROM fugue_equipped_biblios WHERE biblio_name = ?').run(biblioName);
  return info.changes;
}
