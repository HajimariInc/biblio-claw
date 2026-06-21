/**
 * Delivery action handler — `list_biblio` (M3 Phase 4).
 *
 * agent (Claude) が `list_biblio` MCP ツールで outbound.db に system action を書く
 * (content: `{ action, category? }`) → delivery poll がここを呼ぶ → host で
 * `listBiblio()` を実行 → 整形済テキストを inbound.db に書き戻し → agent が patron
 * 向けに最終整形して Slack 応答する。
 *
 * `shelve-action.ts` と同形 (input validate / writeBack 3 retry / try-catch fail-closed)。
 * 差分は (a) `category` が optional / (b) 不正 category を `invalid_input` で蹴らず silent
 * fallback で全件 + 注記を返す (= patron が `dev` のように略記しても落ちないように) /
 * (c) 応答テキストの整形 (= 件数 + カテゴリ別内訳 + 一覧)。
 */
import { registerDeliveryAction } from '../delivery.js';
import { log } from '../log.js';

import { writeBackMessage } from './action-helpers.js';
import { listBiblio } from './list-biblio.js';
import { BIBLIO_CATEGORIES, type BiblioCategory, type ListBiblioResult } from './types.js';

/** category の合法集合 (= BiblioCategory)。`includes` で `category as BiblioCategory` を validate。 */
const VALID_CATEGORIES: readonly BiblioCategory[] = BIBLIO_CATEGORIES;

/** ListBiblioResult を patron 向けテキストに整形する。 */
function formatResult(result: ListBiblioResult): string {
  if (result.total === 0) {
    return '棚に biblio はまだ並んでいません (marketplace.json が空 or 未作成)。仕入れ → 検品 → カテゴライズ → 陳列を回してください。';
  }
  const lines: string[] = [];
  if (result.appliedFilter) {
    lines.push(
      `棚に ${result.total} 件の biblio が並んでいます (うち ${result.items.length} 件が \`${result.appliedFilter}\` カテゴリ)。`,
    );
  } else {
    lines.push(`現在 ${result.total} 件の biblio が棚に並んでいます。`);
  }
  // カテゴリ別カウント (= 全件の俯瞰、フィルタ前の数を出す)。
  const countLines: string[] = [];
  for (const cat of BIBLIO_CATEGORIES) {
    const n = result.counts[cat];
    if (n > 0) countLines.push(`📚 ${cat} (${n})`);
  }
  if (result.counts.unknown > 0) {
    countLines.push(`📚 unknown (${result.counts.unknown}) ← source 解析不能、要確認`);
  }
  if (countLines.length > 0) {
    lines.push(countLines.join(' / '));
  }
  // 一覧 (フィルタ適用後)。category ごとにグループ化して読みやすさを上げる。
  if (result.items.length > 0) {
    lines.push('');
    lines.push('一覧:');
    const byCategory = new Map<string, string[]>();
    for (const item of result.items) {
      const bucket = byCategory.get(item.category) ?? [];
      bucket.push(item.name);
      byCategory.set(item.category, bucket);
    }
    for (const [cat, names] of byCategory) {
      lines.push(`  [${cat}] ${names.join(', ')}`);
    }
  }
  if (!result.appliedFilter) {
    lines.push('');
    lines.push('カテゴリで絞るには `@bot 蔵書 biblio-dev` (or art/bf/ai) のように指定してください。');
  }
  return lines.join('\n');
}

registerDeliveryAction('list_biblio', async (content, session, inDb) => {
  // category は optional。空文字 / null / undefined / 不正値は「全件」として扱う (= patron が
  // 適当に書いても落ちないように silent fallback。完全に不正なら情報提示)。
  const rawCategory = typeof content.category === 'string' ? content.category.trim() : '';

  let category: BiblioCategory | undefined;
  let invalidNotice = '';
  if (rawCategory) {
    if (VALID_CATEGORIES.includes(rawCategory as BiblioCategory)) {
      category = rawCategory as BiblioCategory;
    } else {
      invalidNotice = `\n\n(注: 指定されたカテゴリ "${rawCategory}" は biblio-dev|art|bf|ai のいずれでもないため、全件を返しました)`;
      log.warn('list_biblio invalid category — falling back to all', {
        category: rawCategory,
        sessionId: session.id,
      });
    }
  }

  log.info('list_biblio from agent', { category: category ?? null, sessionId: session.id });

  try {
    const result = await listBiblio({ category });
    const text = formatResult(result) + invalidNotice;
    await writeBackMessage(inDb, text, 'list-resp', 'list_biblio');
    log.info('list_biblio done', {
      category: category ?? null,
      total: result.total,
      filtered: result.items.length,
      sessionId: session.id,
    });
  } catch (err) {
    // listBiblio() は fetchMarketplace / readShelveEnv の throw 等で抜けることがある。
    // 想定外例外も握って patron に通知 (host を落とさない、`shelve-action.ts` 流儀)。
    log.error('list_biblio threw', { sessionId: session.id, err });
    const detail = err instanceof Error ? err.message : String(err);
    await writeBackMessage(inDb, `蔵書一覧取得エラー (internal): ${detail}`, 'list-resp', 'list_biblio');
  }
});
