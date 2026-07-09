import type { SlackBlock } from '@chat-adapter/slack/blocks';

import { buildReportBlocks } from './blocks-builder.js';
import { aggregateCosts, type UsageInput } from './cost-calculator.js';

// 4 種レポート結果 → Slack DM plain text + Block Kit blocks (M4-C Phase 2)。
//
// QueryOutcome<T>:
//   BQ query の「成功 (rows)」と「失敗 (error)」を型で区別する discriminated union。
//   `safeRunQuery` (scripts/reporting-cronjob.ts) が空返し正規化を止め、本 union で伝搬する
//   ように R4 (2026-07-09 review 反映) で導入。formatter は `if (!outcome.ok)` で
//   失敗セクションを「⚠️ 取得失敗 (BQ query error)」に切替え、活動なしと SQL 失敗を区別する。
export type QueryOutcome<T = unknown> = { ok: true; rows: T[] } | { ok: false };

export interface BiblioUsageRow {
  action: string;
  outcome: string;
  cnt: number;
}

export interface InspectDistributionRow {
  verdict: string;
  dangerous: string;
  cnt: number;
}

export interface ErrorTrendRow {
  day: string;
  event: string;
  cnt: number;
  p50_ms?: number;
  p95_ms?: number;
  p99_ms?: number;
}

export interface LlmCostRow {
  model: string;
  call_count: number;
  total_tokens_in: number;
  total_tokens_out: number;
  // M4-C Phase 2 で emit + SQL 列追加済。旧 log (emit 前) は NULL → normalize で undefined に落ちる。
  total_cache_read?: number;
  total_cache_creation?: number;
}

export interface ReportInput {
  windowDays: number;
  biblio: QueryOutcome;
  inspect: QueryOutcome;
  errorTrend: QueryOutcome;
  llmCost: QueryOutcome;
}

// BigQuery v8 client は default (`wrapIntegers: false`) で SUM(INT64) を plain number として返す。
// 将来 wrapIntegers を有効化した場合や、SDK 挙動変化 (BIGNUMERIC 導入等) に備えた防御的 coerce。
// SDK 実装: wrapIntegers=true 時は BigQueryInt (Number 継承 + `.value` / `.type` を持つ shape) が返る。
// R5 (2026-07-09) で silent 0 丸めを検知する warnings 経路を追加。呼出側は returned tuple を使う。
export interface NormalizeReport {
  warnings: string[];
}

function toNumber(v: unknown, warnings?: NormalizeReport['warnings']): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    warnings?.push(`row: non-numeric string coerced to 0 (raw: "${v}")`);
    return 0;
  }
  if (v && typeof v === 'object' && 'value' in v) {
    const n = Number((v as { value: unknown }).value);
    if (Number.isFinite(n)) return n;
    warnings?.push('row: BigQueryInt shape parse failed, coerced to 0');
    return 0;
  }
  if (v === null || v === undefined) {
    // BQ NULL 返却は正当 (集計対象データが 0 件のケース等)。silent 0 で処理し warning は出さない。
    return 0;
  }
  warnings?.push(`row: unexpected shape (${typeof v}) coerced to 0`);
  return 0;
}

function toStr(v: unknown, warnings?: NormalizeReport['warnings']): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) {
    warnings?.push('row: null/undefined string coerced to "(unknown)"');
    return '(unknown)';
  }
  return String(v);
}

export function normalizeBiblioRow(r: unknown, warnings: NormalizeReport['warnings']): BiblioUsageRow {
  const row = (r as Record<string, unknown>) ?? {};
  return {
    action: toStr(row.action, warnings),
    outcome: toStr(row.outcome, warnings),
    cnt: toNumber(row.cnt, warnings),
  };
}

export function normalizeInspectDistributionRow(
  r: unknown,
  warnings: NormalizeReport['warnings'],
): InspectDistributionRow {
  const row = (r as Record<string, unknown>) ?? {};
  return {
    verdict: toStr(row.verdict, warnings),
    dangerous: toStr(row.dangerous, warnings),
    cnt: toNumber(row.cnt, warnings),
  };
}

export function normalizeErrorTrendRow(r: unknown, warnings: NormalizeReport['warnings']): ErrorTrendRow {
  const row = (r as Record<string, unknown>) ?? {};
  const p50 = 'p50_ms' in row ? row.p50_ms : undefined;
  const p95 = 'p95_ms' in row ? row.p95_ms : undefined;
  const p99 = 'p99_ms' in row ? row.p99_ms : undefined;
  return {
    day: toStr(row.day, warnings),
    event: toStr(row.event, warnings),
    cnt: toNumber(row.cnt, warnings),
    p50_ms: p50 == null ? undefined : toNumber(p50, warnings),
    p95_ms: p95 == null ? undefined : toNumber(p95, warnings),
    p99_ms: p99 == null ? undefined : toNumber(p99, warnings),
  };
}

export function normalizeLlmCostRow(r: unknown, warnings: NormalizeReport['warnings']): LlmCostRow {
  const row = (r as Record<string, unknown>) ?? {};
  return {
    model: toStr(row.model, warnings),
    call_count: toNumber(row.call_count, warnings),
    total_tokens_in: toNumber(row.total_tokens_in, warnings),
    total_tokens_out: toNumber(row.total_tokens_out, warnings),
    total_cache_read: 'total_cache_read' in row ? toNumber(row.total_cache_read, warnings) : undefined,
    total_cache_creation: 'total_cache_creation' in row ? toNumber(row.total_cache_creation, warnings) : undefined,
  };
}

function formatBiblio(outcome: QueryOutcome, warnings: NormalizeReport['warnings']): string {
  if (!outcome.ok)
    return '📚 biblio 利用: ⚠️ 取得失敗 (BQ query error、Cloud Logging の reporting.biblio-usage_failed を確認)';
  const rows = outcome.rows.map((r) => normalizeBiblioRow(r, warnings));
  if (rows.length === 0) return '📚 biblio 利用: 活動なし';
  const perAction = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!perAction.has(r.action)) perAction.set(r.action, new Map());
    perAction.get(r.action)!.set(r.outcome, (perAction.get(r.action)!.get(r.outcome) ?? 0) + r.cnt);
  }
  const parts: string[] = [];
  const sortedActions = Array.from(perAction.keys()).sort();
  for (const action of sortedActions) {
    const outcomes = perAction.get(action)!;
    const total = Array.from(outcomes.values()).reduce((a, b) => a + b, 0);
    const outcomeStr = Array.from(outcomes.entries())
      .map(([o, c]) => `${o} ${c}`)
      .join(', ');
    parts.push(`${action} ${total} 件 (${outcomeStr})`);
  }
  return `📚 biblio 利用: ${parts.join(' / ')}`;
}

function formatInspectDistribution(outcome: QueryOutcome, warnings: NormalizeReport['warnings']): string {
  if (!outcome.ok) return '⚠️ 検品分布: ⚠️ 取得失敗 (BQ query error)';
  const rows = outcome.rows.map((r) => normalizeInspectDistributionRow(r, warnings));
  if (rows.length === 0) return '⚠️ 検品分布: 検品実行なし';
  // verdict × dangerous を "ACCEPT/false 4, HOLD/false 2, REJECT/true 1" の 1 行に集約。
  const parts = rows.map((r) => `${r.verdict}/${r.dangerous} ${r.cnt}`);
  return `⚠️ 検品分布: ${parts.join(', ')}`;
}

function formatErrorTrend(outcome: QueryOutcome, warnings: NormalizeReport['warnings']): string {
  if (!outcome.ok) return '🚨 エラー傾向: ⚠️ 取得失敗 (BQ query error)';
  const rows = outcome.rows.map((r) => normalizeErrorTrendRow(r, warnings));
  if (rows.length === 0) return '🚨 エラー傾向: ERROR なし (順調)';
  // day + event 別集計。text 経路は「先頭 3 行 + total 件数」だけ表示 (詳細は Data Table Block に委任)。
  const totalCnt = rows.reduce((s, r) => s + r.cnt, 0);
  const preview = rows.slice(0, 3).map((r) => {
    const percentiles: string[] = [];
    if (r.p50_ms != null) percentiles.push(`p50 ${r.p50_ms}ms`);
    if (r.p95_ms != null) percentiles.push(`p95 ${r.p95_ms}ms`);
    if (r.p99_ms != null) percentiles.push(`p99 ${r.p99_ms}ms`);
    const tail = percentiles.length > 0 ? ` [${percentiles.join(', ')}]` : '';
    return `${r.day} ${r.event} ${r.cnt}${tail}`;
  });
  const suffix = rows.length > 3 ? `\n  ... 他 ${rows.length - 3} 行` : '';
  return `🚨 エラー傾向 (総 ${totalCnt} 件):\n  ${preview.join('\n  ')}${suffix}`;
}

function formatLlmCost(outcome: QueryOutcome, warnings: NormalizeReport['warnings']): string {
  if (!outcome.ok)
    return '💰 LLM コスト: ⚠️ 取得失敗 (BQ query error、Cloud Logging の reporting.llm-cost_failed を確認)';
  const rows = outcome.rows.map((r) => normalizeLlmCostRow(r, warnings));
  if (rows.length === 0) return '💰 LLM コスト: 呼出記録なし';
  const usages: UsageInput[] = rows.map((r) => ({
    model: r.model,
    tokens_in: r.total_tokens_in,
    tokens_out: r.total_tokens_out,
    cache_read: r.total_cache_read,
    cache_creation: r.total_cache_creation,
  }));
  const agg = aggregateCosts(usages);
  const fmt = (n: number) => `$${n.toFixed(4)}`;
  const callCount = rows.reduce((s, r) => s + r.call_count, 0);
  const modelCount = new Set(rows.map((r) => r.model)).size;
  const lines = [
    `💰 LLM コスト: ${fmt(agg.total_usd)} (Anthropic ${fmt(agg.anthropic_usd)} / Gemini ${fmt(agg.gemini_usd)})`,
    `  呼出 ${callCount} 回、${modelCount} model`,
  ];
  // 未知 model は computeCost 経路で cost_usd: 0 に落ちるため unknown_usd 判定では拾えない。
  // warnings に含まれる `unknown_model:` prefix で「単価表未登録の model を検知した」ことを
  // 明示的に patron に伝える (silent 0 コスト計上を可視化)。
  const hasUnknownModel = agg.warnings.some((w) => w.startsWith('unknown_model:'));
  if (hasUnknownModel) {
    lines.push('  ⚠️ 未知 model 検知 (単価表未登録)');
  }
  if (agg.warnings.length > 0) {
    lines.push(`  ※ ${agg.warnings.join(' / ')}`);
  }
  return lines.join('\n');
}

/**
 * 4 種レポート結果 → Slack DM 用の text (fallback) + Block Kit blocks の 2 shape。
 * Slack API の contract 上、`blocks` を送っても fallback 表示 / モバイルプッシュ通知 / 検索索引に
 * `text` が使われるため、text 側は変わらず有意な要約を返す必要がある。
 */
export function formatBiblioUsageSummary(input: ReportInput): { text: string; blocks: SlackBlock[] } {
  const warnings: string[] = [];
  const header = `📊 biblio-claw 週次レポート (直近 ${input.windowDays} 日)`;
  const biblio = formatBiblio(input.biblio, warnings);
  const inspect = formatInspectDistribution(input.inspect, warnings);
  const errorTrend = formatErrorTrend(input.errorTrend, warnings);
  const llmCost = formatLlmCost(input.llmCost, warnings);
  const sections = [header, biblio, inspect, errorTrend, llmCost];
  if (warnings.length > 0) {
    // formatter 側で検知した row shape 異常は Slack DM 末尾に注記 (silent 0 丸めの可視化)。
    const unique = Array.from(new Set(warnings));
    sections.push(`⚠️ データ整形 warning: ${unique.join(' / ')}`);
  }
  const text = sections.join('\n\n');
  const blocks = buildReportBlocks(input, warnings);
  return { text, blocks };
}
