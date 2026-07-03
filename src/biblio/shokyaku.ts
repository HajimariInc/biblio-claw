/**
 * 焼却 (shokyaku) — 棚から除去 + 装備源物理削除 (= 再装備不可)。
 *
 * `unshelve()` で shelf PR を作った後、`<DATA_DIR>/biblio-equipped/<biblioName>/` を `fs.rmSync` で
 * 物理削除し、`session_equipped_biblios` から該当 biblio を **全 session** で個別削除する
 * (= `equip.ts` の `equipped biblio dir not found, skipping` warn が次回 spawn 以降に再発しないようにする)。
 * M4-E Phase 3 追加: `fugue_equipped_biblios` (channel-scoped store) からも並置削除する
 * (= 焼却→再仕入れ→再 shelve 後の Fugue equip が `already_equipped` を誤返答する ghost row 問題の防止)。
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
import { deleteFugueEquippedBiblioByName } from '../db/fugue-equipped-biblios.js';
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
 * 装備ストア (session 側 / Fugue 側) から個別 biblio を削除する共通ヘルパ (提案 11、code-simplifier)。
 *
 * session 側 (`deleteEquippedBiblioByName`) と Fugue 側 (`deleteFugueEquippedBiblioByName`) は
 * 呼出先 DB 関数と log message / warn 文言以外は同型の try/catch。ヘルパ化することで:
 *   - `session -> log fixed / warn fixed` の 4 箇所を「fn + 3 string」引数化して 1 箇所に集約
 *   - warning 文字列 (`装備リスト DB の個別削除に失敗: ...` / `Fugue 装備状態 DB の削除に失敗: ...`)
 *     は完全に refactor 前と一致 (`shokyaku.test.ts` の cleanupWarning 内容 assert は無変更で PASS)
 *   - 将来 3 つ目の装備ストア (仮に channel 別が増えても) が追加された時、呼出 1 行で追随可能
 *
 * @returns 成功 (changes=0 の no-op 含む) 時は null、失敗時は patron に伝える warning 文字列。
 */
function deleteFromEquipStore(
  biblioName: string,
  deleteFn: (name: string) => number,
  successLogMessage: string,
  failureLogMessage: string,
  warnPrefix: string,
): string | null {
  try {
    const changes = deleteFn(biblioName);
    if (changes > 0) {
      log.info(successLogMessage, {
        event: 'biblio.shokyaku',
        outcome: 'success',
        biblio_name: biblioName,
        changes,
      });
    }
    return null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(failureLogMessage, {
      event: 'biblio.shokyaku',
      outcome: 'failure',
      biblio_name: biblioName,
      err,
    });
    return `${warnPrefix}: ${detail}`;
  }
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
 * 焼却 = `unshelve()` + `fs.rmSync` + `deleteEquippedBiblioByName` + `deleteFugueEquippedBiblioByName`。
 *
 * 1. `unshelve()` で shelf PR を作る (= 失敗なら早期 return、host 側 cleanup は走らない)
 * 2. 装備源 dir を物理削除 (= 失敗しても warn のみで続行、`cleanupWarning` に蓄積)
 * 3. 全 session の装備リストから該当 biblio を消す (= equip.ts skip warn ノイズ抑制、失敗時は `cleanupWarning` に追記)
 * 4. Fugue channel-scoped 装備状態からも削除する (M4-E Phase 3、ghost row 問題防止、失敗時は `cleanupWarning` に追記)
 *
 * 2-4 の失敗は ok=true を維持しつつ `cleanupWarning` で patron に伝える。
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
  const sessionWarning = deleteFromEquipStore(
    biblioName,
    deleteEquippedBiblioByName,
    'shokyaku: removed from N session equip lists',
    'shokyaku: DB delete from session_equipped_biblios failed',
    '装備リスト DB の個別削除に失敗',
  );
  if (sessionWarning) warnings.push(sessionWarning);

  // Fugue channel-scoped 装備状態からも除去 (M4-E Phase 3 判断 J、session 側と対称)。
  // 焼却 = 物理削除 + 全装備リストからの除去、が M3 で確立した意味論。fugue store に ghost 行が
  // 残ると、焼却→再仕入れ→再 shelve 後の equip が already_equipped を誤返答する問題を防ぐ。
  // enkin (禁書) には追加しない = 装備状態残置で再装備可の対称性 (session 側と同じ)。
  const fugueWarning = deleteFromEquipStore(
    biblioName,
    deleteFugueEquippedBiblioByName,
    'shokyaku: removed from fugue equipped biblios',
    'shokyaku: DB delete from fugue_equipped_biblios failed',
    'Fugue 装備状態 DB の削除に失敗',
  );
  if (fugueWarning) warnings.push(fugueWarning);

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
