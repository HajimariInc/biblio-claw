import { aggregateCosts, type UsageInput } from './cost-calculator.js';

// 4 種レポート結果 → Slack DM plain text (Phase 1 スコープ。Phase 2 で Data Table Block 化)。

export interface BiblioUsageRow {
  action: string;
  outcome: string;
  cnt: number;
}

export interface LlmCostRow {
  model: string;
  call_count: number;
  total_tokens_in: number;
  total_tokens_out: number;
  // cache_read / cache_creation は現行 emit で捕捉されておらず、SQL 側で SUM 対象データなし。
  // 将来 emit 追加時に SQL 列と共に有効化。
  total_cache_read?: number;
  total_cache_creation?: number;
}

export interface ReportInput {
  windowDays: number;
  biblio: unknown[];
  inspect: unknown[];
  errorTrend: unknown[];
  llmCost: unknown[];
}

// BigQuery v8 client は SUM(INT64) を number で返すが、BIGNUM や BIGINT の場合は
// {value: string} 形式の BigQueryInt が返るケースがある。両対応するための coerce。
function toNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (v && typeof v === 'object' && 'value' in v) {
    const n = Number((v as { value: unknown }).value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '');
}

function normalizeBiblioRow(r: unknown): BiblioUsageRow {
  const row = (r as Record<string, unknown>) ?? {};
  return {
    action: toStr(row.action),
    outcome: toStr(row.outcome),
    cnt: toNumber(row.cnt),
  };
}

function normalizeLlmCostRow(r: unknown): LlmCostRow {
  const row = (r as Record<string, unknown>) ?? {};
  return {
    model: toStr(row.model),
    call_count: toNumber(row.call_count),
    total_tokens_in: toNumber(row.total_tokens_in),
    total_tokens_out: toNumber(row.total_tokens_out),
    total_cache_read: 'total_cache_read' in row ? toNumber(row.total_cache_read) : undefined,
    total_cache_creation: 'total_cache_creation' in row ? toNumber(row.total_cache_creation) : undefined,
  };
}

function formatBiblio(rows: BiblioUsageRow[]): string {
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

function formatLlmCost(rows: LlmCostRow[]): string {
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

export function formatBiblioUsageSummary(input: ReportInput): string {
  const header = `📊 biblio-claw 週次レポート (直近 ${input.windowDays} 日)`;
  const biblio = formatBiblio(input.biblio.map(normalizeBiblioRow));
  const inspect = '⚠️ 検品分布: Phase 2 で実装';
  const errorTrend = '🚨 エラー傾向: Phase 2 で実装';
  const llmCost = formatLlmCost(input.llmCost.map(normalizeLlmCostRow));
  return [header, biblio, inspect, errorTrend, llmCost].join('\n\n');
}
