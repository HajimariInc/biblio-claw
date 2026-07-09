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
  // review R6 (I1): reason 列追加 = system_failure (HOLD+inspect_error) と policy 保留の区別可能化。
  return {
    type: 'table',
    headers: ['verdict', 'reason', 'dangerous', 'cnt'],
    rows: rows.map((r) => [r.verdict, r.reason, r.dangerous, String(r.cnt)]),
  };
}

function errorTrendTable(rows: ErrorTrendRow[]): SlackTableElement {
  return {
    type: 'table',
    // review R6 (C1): severity 列を追加して CRITICAL (host crash / startup failed) を patron が
    // 一目で識別可能に。ERROR/CRITICAL の混在を隠さない。
    headers: ['day', 'severity', 'event', 'cnt', 'p50_ms', 'p95_ms', 'p99_ms'],
    rows: rows.map((r) => [
      r.day,
      r.severity,
      r.event,
      String(r.cnt),
      r.p50_ms != null ? String(r.p50_ms) : '',
      r.p95_ms != null ? String(r.p95_ms) : '',
      r.p99_ms != null ? String(r.p99_ms) : '',
    ]),
  };
}

function llmCostTable(rows: LlmCostRow[]): SlackTableElement {
  // review R6 (C2/S8): total_cache_read/total_cache_creation は真の undefined (SQL 列不在) と
  // BQ NULL/0 を区別可能に。undefined は「未捕捉 (未計測)」を意味する `?` 表示。0 は「実測 0」。
  return {
    type: 'table',
    headers: ['model', 'call_count', 'tokens_in', 'tokens_out', 'cache_read', 'cache_creation'],
    rows: rows.map((r) => [
      r.model,
      String(r.call_count),
      String(r.total_tokens_in),
      String(r.total_tokens_out),
      r.total_cache_read != null ? String(r.total_cache_read) : '?',
      r.total_cache_creation != null ? String(r.total_cache_creation) : '?',
    ]),
  };
}

/**
 * outcome が失敗経路のとき「⚠️ 取得失敗」 text child を返し、
 * 成功 + rows 非空なら supplied table child を、rows 空なら「活動なし」text child を返す。
 * silent failure 撲滅: normalize は呼出側で完了させ、本関数は shape only にする。
 */
// review R6 (S2): `outcome: QueryOutcome<unknown>` 固定にして「呼出前の rows は unknown」という
// 実態を型で正直に示す。domain 型 T は tableBuilder + normalizer の生成型としてのみ束縛する
// (unsafe cast を排除、buildReportBlocks の 4 箇所 `as QueryOutcome<X>` も削除)。
function withOutcomeGuard<T>(
  outcome: QueryOutcome<unknown>,
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

function buildBiblioCard(outcome: QueryOutcome<unknown>, warnings: NormalizeReport['warnings']): SlackCardElement {
  return {
    type: 'card',
    title: '📚 biblio 利用',
    children: [withOutcomeGuard(outcome, '活動なし', biblioTable, warnings, normalizeBiblioRow)],
  };
}

function buildInspectCard(outcome: QueryOutcome<unknown>, warnings: NormalizeReport['warnings']): SlackCardElement {
  return {
    type: 'card',
    title: '⚠️ 検品分布',
    children: [withOutcomeGuard(outcome, '検品実行なし', inspectTable, warnings, normalizeInspectDistributionRow)],
  };
}

function buildErrorTrendCard(outcome: QueryOutcome<unknown>, warnings: NormalizeReport['warnings']): SlackCardElement {
  return {
    type: 'card',
    title: '🚨 エラー傾向',
    children: [
      withOutcomeGuard(outcome, 'ERROR / CRITICAL なし (順調)', errorTrendTable, warnings, normalizeErrorTrendRow),
    ],
  };
}

function buildLlmCostCard(outcome: QueryOutcome<unknown>, warnings: NormalizeReport['warnings']): SlackCardElement {
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
  // review R6 (I2): 移行週や SDK 差で usage 欠落が発生した call 数を独立集計。
  // cache_captured=false の call 数を SUM した SQL 列を formatter で拾い、cost 過小推定の可能性を可視化。
  const uncapturedTotal = rows.reduce((s, r) => s + (r.uncaptured_cache_calls ?? 0), 0);
  const children: SlackCardChild[] = [
    {
      type: 'text',
      content: `合計: ${fmtUsd(agg.total_usd)} (Anthropic ${fmtUsd(agg.anthropic_usd)} / Gemini ${fmtUsd(agg.gemini_usd)})`,
    },
    llmCostTable(rows),
  ];
  if (uncapturedTotal > 0) {
    children.push({
      type: 'text',
      content: `⚠️ ${uncapturedTotal} 件は usage 未捕捉 (SDK 差 or 移行週の旧ログ = cost は過小推定の可能性)`,
    });
  }
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
  // review R6 (S2): `ReportInput` の 4 field は `QueryOutcome<unknown>` = build*Card も同型で受けるため
  // unsafe cast が不要 (旧版は `as QueryOutcome<X>` 4 箇所で型と実態を偽っていた)。
  const cards: SlackCardElement[] = [
    buildBiblioCard(input.biblio, warnings),
    buildInspectCard(input.inspect, warnings),
    buildErrorTrendCard(input.errorTrend, warnings),
    buildLlmCostCard(input.llmCost, warnings),
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
