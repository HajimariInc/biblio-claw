/**
 * 禁書 (kinsho / enkin) — 棚から除去 + 装備源残置 (= 再装備可)。
 *
 * `unshelve()` の薄ラッパ。commit message / PR title / branch prefix を「禁書」用に差し替えるだけで、
 * shelf 側の動作 (= GitHub Git Data API + Pulls API 経由の削除 draft PR 作成) は完全に共通。
 * 「装備源残置」は **物理的に何もしない** ことで実現される (= `<DATA_DIR>/biblio-equipped/<name>/` を
 * 削除しない、shokyaku.ts との対称設計)。
 */
import { unshelve } from './unshelve.js';
import type { GhFetchCtx } from './shelf-gh.js';
import type { BiblioCategory, EnkinResult } from './types.js';

/** 禁書の入力 (= 棚から除去するだけ、装備源は残す)。 */
export interface EnkinRequest {
  biblioName: string;
  category: BiblioCategory;
}

/**
 * 禁書 = `unshelve()` のみ (throw しない、失敗は `EnkinResult.ok=false` で返す)。
 *
 * `<DATA_DIR>/biblio-equipped/<biblioName>/` は **意図的に残置** する (= 再装備可)。
 */
export async function enkin(req: EnkinRequest, opts: { ctx?: GhFetchCtx } = {}): Promise<EnkinResult> {
  return unshelve(
    {
      biblioName: req.biblioName,
      category: req.category,
      opLabel: '禁書',
      branchPrefix: 'enkin',
    },
    { ctx: opts.ctx },
  );
}
