import {
  cardToSlackBlocks,
  type SlackBlock,
  type SlackCardChild,
  type SlackCardElement,
  type SlackTableElement,
} from '@chat-adapter/slack/blocks';

import type {
  BiblioUsageRow,
  ErrorTrendRow,
  InspectDistributionRow,
  LlmCostRow,
  NormalizeReport,
  QueryOutcome,
  ReportInput,
} from './formatter.js';
import {
  normalizeBiblioRow,
  normalizeErrorTrendRow,
  normalizeInspectDistributionRow,
  normalizeLlmCostRow,
} from './formatter.js';
import { aggregateCosts, type UsageInput } from './cost-calculator.js';

// M4-C Phase 2: 週次レポート 4 セクションを Slack Data Table Block に整形する。
//
// `@chat-adapter/slack/blocks` の `cardToSlackBlocks(card)` 経由で SlackCardElement を Block Kit に変換する。
// library 内部の `tableToBlocks` は非 export、`state.usedTable` で 1 card 1 table 制約が入っているため、
// 4 セクション全て table 化するなら **必ず 4 card 分割** で cardToSlackBlocks を 4 回呼ぶ。
// rows/cols が 100/20 を超えると library 内で自動 ASCII fallback (section text block) に落ちる。

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** SUM(...) が NULL → normalize で 0 になり silent 0 として集計に載る。集計外にしたい場合は呼出側で除外。 */
function biblioTable(rows: BiblioUsageRow[]): SlackTableElement {
  return {
    type: 'table',
    headers: ['action', 'outcome', 'cnt'],
    rows: rows.map((r) => [r.action, r.outcome, String(r.cnt)]),
  };
}

function inspectTable(rows: InspectDistributionRow[]): SlackTableElement {
  return {
    type: 'table',
    headers: ['verdict', 'dangerous', 'cnt'],
    rows: rows.map((r) => [r.verdict, r.dangerous, String(r.cnt)]),
  };
}

function errorTrendTable(rows: ErrorTrendRow[]): SlackTableElement {
  return {
    type: 'table',
    headers: ['day', 'event', 'cnt', 'p50_ms', 'p95_ms', 'p99_ms'],
    rows: rows.map((r) => [
      r.day,
      r.event,
      String(r.cnt),
      r.p50_ms != null ? String(r.p50_ms) : '',
      r.p95_ms != null ? String(r.p95_ms) : '',
      r.p99_ms != null ? String(r.p99_ms) : '',
    ]),
  };
}

function llmCostTable(rows: LlmCostRow[]): SlackTableElement {
  return {
    type: 'table',
    headers: ['model', 'call_count', 'tokens_in', 'tokens_out', 'cache_read', 'cache_creation'],
    rows: rows.map((r) => [
      r.model,
      String(r.call_count),
      String(r.total_tokens_in),
      String(r.total_tokens_out),
      r.total_cache_read != null ? String(r.total_cache_read) : '0',
      r.total_cache_creation != null ? String(r.total_cache_creation) : '0',
    ]),
  };
}

/**
 * outcome が失敗経路のとき「⚠️ 取得失敗」 text child を返し、
 * 成功 + rows 非空なら supplied table child を、rows 空なら「活動なし」text child を返す。
 * silent failure 撲滅: normalize は呼出側で完了させ、本関数は shape only にする。
 */
function withOutcomeGuard<T>(
  outcome: QueryOutcome<T>,
  emptyMsg: string,
  tableBuilder: (rows: T[]) => SlackTableElement,
  warnings: NormalizeReport['warnings'],
  normalizer: (r: unknown, w: NormalizeReport['warnings']) => T,
): SlackCardChild {
  if (!outcome.ok) return { type: 'text', content: '⚠️ 取得失敗 (BQ query error)' };
  const rows = outcome.rows.map((r) => normalizer(r, warnings));
  if (rows.length === 0) return { type: 'text', content: emptyMsg };
  return tableBuilder(rows);
}

function buildBiblioCard(
  outcome: QueryOutcome<BiblioUsageRow>,
  warnings: NormalizeReport['warnings'],
): SlackCardElement {
  return {
    type: 'card',
    title: '📚 biblio 利用',
    children: [withOutcomeGuard(outcome, '活動なし', biblioTable, warnings, normalizeBiblioRow)],
  };
}

function buildInspectCard(
  outcome: QueryOutcome<InspectDistributionRow>,
  warnings: NormalizeReport['warnings'],
): SlackCardElement {
  return {
    type: 'card',
    title: '⚠️ 検品分布',
    children: [withOutcomeGuard(outcome, '検品実行なし', inspectTable, warnings, normalizeInspectDistributionRow)],
  };
}

function buildErrorTrendCard(
  outcome: QueryOutcome<ErrorTrendRow>,
  warnings: NormalizeReport['warnings'],
): SlackCardElement {
  return {
    type: 'card',
    title: '🚨 エラー傾向',
    children: [withOutcomeGuard(outcome, 'ERROR なし (順調)', errorTrendTable, warnings, normalizeErrorTrendRow)],
  };
}

function buildLlmCostCard(outcome: QueryOutcome<LlmCostRow>, warnings: NormalizeReport['warnings']): SlackCardElement {
  if (!outcome.ok) {
    return {
      type: 'card',
      title: '💰 LLM コスト',
      children: [{ type: 'text', content: '⚠️ 取得失敗 (BQ query error)' }],
    };
  }
  const rows = outcome.rows.map((r) => normalizeLlmCostRow(r, warnings));
  if (rows.length === 0) {
    return { type: 'card', title: '💰 LLM コスト', children: [{ type: 'text', content: '呼出記録なし' }] };
  }
  const usages: UsageInput[] = rows.map((r) => ({
    model: r.model,
    tokens_in: r.total_tokens_in,
    tokens_out: r.total_tokens_out,
    cache_read: r.total_cache_read,
    cache_creation: r.total_cache_creation,
  }));
  const agg = aggregateCosts(usages);
  const children: SlackCardChild[] = [
    {
      type: 'text',
      content: `合計: ${fmtUsd(agg.total_usd)} (Anthropic ${fmtUsd(agg.anthropic_usd)} / Gemini ${fmtUsd(agg.gemini_usd)})`,
    },
    llmCostTable(rows),
  ];
  const hasUnknownModel = agg.warnings.some((w) => w.startsWith('unknown_model:'));
  if (hasUnknownModel) {
    children.push({ type: 'text', content: '⚠️ 未知 model 検知 (単価表未登録)' });
  }
  if (agg.warnings.length > 0) {
    children.push({ type: 'text', content: `※ ${agg.warnings.join(' / ')}` });
  }
  return { type: 'card', title: '💰 LLM コスト', children };
}

/**
 * ReportInput → Slack Block Kit blocks 配列。
 * 先頭 header (plain_text) + 4 card (biblio / inspect / errorTrend / llmCost) + warnings section
 * を平坦化した Block Kit 配列を返す。呼出元 (scripts/reporting-cronjob.ts) は `postReport` に
 * `blocks` を渡すだけで良い (`postSlackMessage` が既に blocks を尊重する)。
 */
export function buildReportBlocks(input: ReportInput, warnings: NormalizeReport['warnings']): SlackBlock[] {
  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📊 biblio-claw 週次レポート (直近 ${input.windowDays} 日)` },
    },
  ];
  const cards: SlackCardElement[] = [
    buildBiblioCard(input.biblio as QueryOutcome<BiblioUsageRow>, warnings),
    buildInspectCard(input.inspect as QueryOutcome<InspectDistributionRow>, warnings),
    buildErrorTrendCard(input.errorTrend as QueryOutcome<ErrorTrendRow>, warnings),
    buildLlmCostCard(input.llmCost as QueryOutcome<LlmCostRow>, warnings),
  ];
  for (const card of cards) {
    blocks.push(...cardToSlackBlocks(card));
  }
  if (warnings.length > 0) {
    const unique = Array.from(new Set(warnings));
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `⚠️ データ整形 warning: ${unique.join(' / ')}` },
    });
  }
  return blocks;
}
