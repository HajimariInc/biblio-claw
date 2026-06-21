/**
 * 蔵書一覧 (catalog) 本体 — `@bot 蔵書` Feature の host 側ロジック (M3 Phase 4)。
 *
 * 棚 (HajimariInc/biblio-shelf) の marketplace.json から蔵書一覧を取得する。
 * fetchMarketplace() で取得 → pluginsOf() で plugins[] を取り出し → 各エントリの
 * `source` (= `./<category>/<name>` 形式、`shelve.ts:293` 契約) を split して
 * category を抽出 → counts を集計 → category filter (引数指定時のみ) → ListBiblioResult を返す。
 *
 * `fetchMarketplace` は ~500ms で安定なので cache は持たない (= 都度 fetch、
 * PRD §未解決質問 #4 の既定方針)。404 (marketplace.json 未存在) は「棚が空」として
 * 正常応答 (ok:true / items:[] / total:0)。`source` が想定外形式 (旧形式 / 手動編集 /
 * null) のエントリは category='unknown' に振り、`log.warn` で痕跡を残す
 * (= silent drop しない方針、旧形式が固定化するのを防ぐ)。
 */
import { log } from '../log.js';

import { fetchMarketplace, pluginsOf, readShelveEnv } from './shelf-gh.js';
import {
  BIBLIO_CATEGORIES,
  type BiblioCategory,
  type ListBiblioItem,
  type ListBiblioParams,
  type ListBiblioResult,
} from './types.js';

type CategoryKey = BiblioCategory | 'unknown';

/** counts の初期値 — 4 namespace + unknown を 0 で埋める。 */
function emptyCounts(): Record<CategoryKey, number> {
  return { 'biblio-dev': 0, 'biblio-art': 0, 'biblio-bf': 0, 'biblio-ai': 0, unknown: 0 };
}

/** plugins[] の 1 件を ListBiblioItem に投影する。source 解析失敗は category='unknown' に bucket。 */
function projectItem(plugin: Record<string, unknown>): ListBiblioItem {
  const name = typeof plugin.name === 'string' ? plugin.name : '';
  const description = typeof plugin.description === 'string' ? plugin.description : '';
  const version = typeof plugin.version === 'string' ? plugin.version : '';
  const source = typeof plugin.source === 'string' ? plugin.source : '';

  // `./biblio-dev/foo--bar` のように 2 番目セグメントが category。
  // `noUncheckedIndexedAccess` 対策で `?? ''` を入れる。
  const segments = source.split('/');
  const rawCategory = segments[1] ?? '';
  let category: CategoryKey;
  if ((BIBLIO_CATEGORIES as readonly string[]).includes(rawCategory)) {
    category = rawCategory as BiblioCategory;
  } else {
    log.warn('list-biblio: plugin source has unrecognized category — bucketing to unknown', {
      name,
      source,
    });
    category = 'unknown';
  }
  return { name, category, description, version };
}

/**
 * 蔵書一覧を取得する。
 *
 * @param params.category 絞り込みカテゴリ (未指定 = 全件)。`counts` は常に全件のカウントを返す
 *                       (= フィルタ前の俯瞰を patron が見たいケースがある)。`items` のみフィルタ適用。
 */
export async function listBiblio(params: ListBiblioParams): Promise<ListBiblioResult> {
  const env = readShelveEnv();
  const { raw } = await fetchMarketplace(env);
  if (raw === null) {
    // 404 = marketplace.json 未存在 = 棚が空。
    return {
      ok: true,
      items: [],
      counts: emptyCounts(),
      total: 0,
      appliedFilter: params.category ?? null,
    };
  }
  const plugins = pluginsOf(raw);
  const counts = emptyCounts();
  const allItems: ListBiblioItem[] = [];
  for (const p of plugins) {
    const item = projectItem(p);
    // 名前が空 (= 不正データ) のエントリは skip + warn。
    if (!item.name) {
      log.warn('list-biblio: skipping plugin with empty name', {
        source: typeof p.source === 'string' ? p.source : null,
      });
      continue;
    }
    counts[item.category] += 1;
    allItems.push(item);
  }
  const items = params.category ? allItems.filter((i) => i.category === params.category) : allItems;
  return {
    ok: true,
    items,
    counts,
    total: allItems.length,
    appliedFilter: params.category ?? null,
  };
}
