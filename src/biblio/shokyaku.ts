/**
 * 焼却 (shokyaku) — 棚から除去 + 装備源物理削除 (= 再装備不可)。
 *
 * `unshelve()` で shelf PR を作った後、`<DATA_DIR>/biblio-equipped/<biblioName>/` を `fs.rmSync` で
 * 物理削除し、`session_equipped_biblios` から該当 biblio を **全 session** で個別削除する
 * (= `equip.ts` の skip warn が次回 spawn 以降に再発しないようにする)。
 *
 * 設計方針:
 *   - shelf PR 作成 (= unshelve) が成功すれば、後続の host 側 cleanup (= rmSync + DB delete) が
 *     失敗しても `ok=true` を返す (= patron への通知は PR URL を優先、cleanup 失敗は log.warn で
 *     可視化のみ)。理由: PR が立った時点で patron 側の意思決定 (= merge) が走るため、host 側の
 *     後処理失敗を ok=false に倒すと patron 体験が「禁書/焼却の区別が曖昧」になる。
 *   - `BIBLIO_NAME_RE` 通過済の `biblioName` を使う以上 path traversal は成立しない
 *     (= `/` を含めないため `path.join(equipRoot, name)` は equipRoot の prefix 内で確定)。
 *     paranoid な `path.resolve(equipDir).startsWith(path.resolve(equipRoot))` の追加 assert
 *     は **入れない** (= 既存パターン非対応 + 余剰防御で過剰抽象、memory feedback 整合)。
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { deleteEquippedBiblioByName } from '../db/session-equipped-biblios.js';
import { log } from '../log.js';
import { unshelve } from './unshelve.js';
import type { BiblioCategory, ShokyakuResult } from './types.js';

/** 焼却の入力 (= 棚から除去 + 装備源物理削除)。 */
export interface ShokyakuRequest {
  biblioName: string;
  category: BiblioCategory;
}

/** テスト用フック: const 束縛された DATA_DIR を上書きするために root path を渡す。 */
export interface ShokyakuOptions {
  /** `<root>/<biblioName>/` を `fs.rmSync` する。既定 `${DATA_DIR}/biblio-equipped`。 */
  equipmentRoot?: string;
}

/** 装備源 dir を冪等に削除 (= force:true で不在でも no-op、try/catch + warn で続行)。 */
function removeEquipDir(equipDir: string, biblioName: string): boolean {
  try {
    fs.rmSync(equipDir, { recursive: true, force: true });
    return true;
  } catch (err) {
    log.warn('shokyaku: equip dir cleanup failed', { biblioName, equipDir, err });
    return false;
  }
}

/**
 * 焼却 = `unshelve()` + `fs.rmSync` + `deleteEquippedBiblioByName`。
 *
 * 1. `unshelve()` で shelf PR を作る (= 失敗なら早期 return、host 側 cleanup は走らない)
 * 2. 装備源 dir を物理削除 (= 失敗しても warn のみで続行)
 * 3. 全 session の装備リストから該当 biblio を消す (= equip.ts の skip warn ノイズ抑制)
 */
export async function shokyaku(req: ShokyakuRequest, opts?: ShokyakuOptions): Promise<ShokyakuResult> {
  const { biblioName, category } = req;
  const equipmentRoot = opts?.equipmentRoot ?? path.join(DATA_DIR, 'biblio-equipped');

  const unshelveResult = await unshelve({
    biblioName,
    category,
    opLabel: '焼却',
    branchPrefix: 'shokyaku',
  });
  if (!unshelveResult.ok) {
    return unshelveResult;
  }

  // 装備源物理削除 (= 失敗しても warn のみで続行、shelf PR は既に立っている)
  const equipDir = path.join(equipmentRoot, biblioName);
  const removed = removeEquipDir(equipDir, biblioName);
  if (removed) {
    log.info('shokyaku: equip dir removed', { biblioName, equipDir });
  }

  // 全 session の装備リストから個別削除 (= equip.ts:79 skip warn のノイズ抑制)
  try {
    const changes = deleteEquippedBiblioByName(biblioName);
    if (changes > 0) {
      log.info('shokyaku: removed from N session equip lists', { biblioName, changes });
    }
  } catch (err) {
    log.warn('shokyaku: DB delete from session_equipped_biblios failed', { biblioName, err });
  }

  return unshelveResult;
}
