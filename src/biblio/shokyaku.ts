/**
 * 焼却 (shokyaku) — 棚から除去 + 装備源物理削除 (= 再装備不可)。
 *
 * `unshelve()` で shelf PR を作った後、`<DATA_DIR>/biblio-equipped/<biblioName>/` を `fs.rmSync` で
 * 物理削除し、`session_equipped_biblios` から該当 biblio を **全 session** で個別削除する
 * (= `equip.ts` の `equipped biblio dir not found, skipping` warn が次回 spawn 以降に再発しないようにする)。
 *
 * 設計方針:
 *   - shelf PR 作成 (= unshelve) が成功すれば、後続の host 側 cleanup (= rmSync + DB delete) が
 *     失敗しても `ok=true` を返す (= patron への通知は PR URL を優先、cleanup 失敗は warn のみで
 *     可視化)。理由: PR が立った時点で patron 側の意思決定 (= merge) が走るため、host 側の
 *     後処理失敗を ok=false に倒すと patron 体験が「禁書/焼却の区別が曖昧」になる。
 *   - **ただし cleanup 失敗を patron に隠さない**: `ShokyakuResult.cleanupWarning` に失敗内容を
 *     立てて action handler 側で通知文言を切替える (= 「物理削除しました」と無条件通知すると
 *     焼却の意味 = 再装備不可 を誤認させるため。PR #15 silent-failure-hunter HIGH 2 対応)。
 *   - `BIBLIO_NAME_RE` 通過済の `biblioName` は `/` を含まないため `path.join(equipRoot, name)` は
 *     equipRoot の prefix 内で確定する。paranoid な startsWith assert は入れない
 *     (= 既存コードとの整合性 + 同じ正規表現防御が他箇所でも採用されているため余剰防御になる)。
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { deleteEquippedBiblioByName } from '../db/session-equipped-biblios.js';
import { log } from '../log.js';
import { unshelve } from './unshelve.js';
import type { GhFetchCtx } from './shelf-gh.js';
import type { BiblioCategory, ShokyakuResult } from './types.js';

/** 焼却の入力 (= 棚から除去 + 装備源物理削除)。 */
export interface ShokyakuRequest {
  biblioName: string;
  category: BiblioCategory;
}

/** テスト用フック: 装備源 dir の root を差し替える (= const 束縛された DATA_DIR 依存を回避)。 */
export interface ShokyakuOptions {
  /** 装備源 dir の root (`<root>/<biblioName>/` が削除対象)。省略時は `${DATA_DIR}/biblio-equipped`。 */
  equipmentRoot?: string;
  /** Vertex / ghFetch 呼び出しに propagate する追跡 context。 */
  ctx?: GhFetchCtx;
}

/**
 * 装備源 dir を冪等に削除 (= force:true で不在でも no-op、try/catch + warn で続行)。
 *
 * 戻り値は失敗時の警告文 (= action handler が patron 通知に含めるため)。成功時は null。
 */
function removeEquipDir(equipDir: string, biblioName: string): string | null {
  try {
    fs.rmSync(equipDir, { recursive: true, force: true });
    return null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('shokyaku: equip dir cleanup failed', {
      event: 'biblio.shokyaku',
      outcome: 'failure',
      biblio_name: biblioName,
      equipDir,
      err,
    });
    return `装備源 dir の物理削除に失敗 (${equipDir}): ${detail}`;
  }
}

/**
 * 焼却 = `unshelve()` + `fs.rmSync` + `deleteEquippedBiblioByName`。
 *
 * 1. `unshelve()` で shelf PR を作る (= 失敗なら早期 return、host 側 cleanup は走らない)
 * 2. 装備源 dir を物理削除 (= 失敗しても warn のみで続行、`cleanupWarning` に蓄積)
 * 3. 全 session の装備リストから該当 biblio を消す (= equip.ts skip warn ノイズ抑制、失敗時は `cleanupWarning` に追記)
 *
 * 2-3 の失敗は ok=true を維持しつつ `cleanupWarning` で patron に伝える。
 */
export async function shokyaku(req: ShokyakuRequest, opts?: ShokyakuOptions): Promise<ShokyakuResult> {
  const { biblioName, category } = req;
  const equipmentRoot = opts?.equipmentRoot ?? path.join(DATA_DIR, 'biblio-equipped');

  const unshelveResult = await unshelve(
    {
      biblioName,
      category,
      opLabel: '焼却',
      branchPrefix: 'shokyaku',
    },
    { ctx: opts?.ctx },
  );
  if (!unshelveResult.ok) {
    return unshelveResult;
  }

  const warnings: string[] = [];

  // 装備源物理削除 (= 失敗しても shelf PR は既に立っているため ok=true 維持、cleanupWarning に蓄積)
  const equipDir = path.join(equipmentRoot, biblioName);
  const equipWarning = removeEquipDir(equipDir, biblioName);
  if (equipWarning) {
    warnings.push(equipWarning);
  } else {
    log.info('shokyaku: equip dir removed', {
      event: 'biblio.shokyaku',
      outcome: 'success',
      biblio_name: biblioName,
      equipDir,
    });
  }

  // 全 session の装備リストから個別削除 (= equip.ts の skip warn ノイズ抑制)
  try {
    const changes = deleteEquippedBiblioByName(biblioName);
    if (changes > 0) {
      log.info('shokyaku: removed from N session equip lists', {
        event: 'biblio.shokyaku',
        outcome: 'success',
        biblio_name: biblioName,
        changes,
      });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('shokyaku: DB delete from session_equipped_biblios failed', {
      event: 'biblio.shokyaku',
      outcome: 'failure',
      biblio_name: biblioName,
      err,
    });
    warnings.push(`装備リスト DB の個別削除に失敗: ${detail}`);
  }

  return {
    ok: true,
    biblioName: unshelveResult.biblioName,
    category: unshelveResult.category,
    prUrl: unshelveResult.prUrl,
    prNumber: unshelveResult.prNumber,
    branchName: unshelveResult.branchName,
    ...(warnings.length > 0 ? { cleanupWarning: warnings.join(' / ') } : {}),
  };
}
