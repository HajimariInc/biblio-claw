import { aggregateCosts, type UsageInput } from './cost-calculator.js';

// 4 種レポート結果 → Slack DM plain text (Phase 1 スコープ。Phase 2 で Data Table Block 化)。
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

function normalizeBiblioRow(r: unknown, warnings: NormalizeReport['warnings']): BiblioUsageRow {
  const row = (r as Record<string, unknown>) ?? {};
  return {
    action: toStr(row.action, warnings),
    outcome: toStr(row.outcome, warnings),
    cnt: toNumber(row.cnt, warnings),
  };
}

function normalizeLlmCostRow(r: unknown, warnings: NormalizeReport['warnings']): LlmCostRow {
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

function sectionPlaceholder(kind: '検品分布' | 'エラー傾向', outcome: QueryOutcome, icon: string): string {
  // 雛形 (Phase 2 で完成予定) だが、SQL 失敗経路は「Phase 2 実装予定」ではなく実障害として扱う。
  if (!outcome.ok) return `${icon} ${kind}: ⚠️ 取得失敗 (BQ query error)`;
  return `${icon} ${kind}: Phase 2 で実装`;
}

export function formatBiblioUsageSummary(input: ReportInput): string {
  const warnings: string[] = [];
  const header = `📊 biblio-claw 週次レポート (直近 ${input.windowDays} 日)`;
  const biblio = formatBiblio(input.biblio, warnings);
  const inspect = sectionPlaceholder('検品分布', input.inspect, '⚠️');
  const errorTrend = sectionPlaceholder('エラー傾向', input.errorTrend, '🚨');
  const llmCost = formatLlmCost(input.llmCost, warnings);
  const sections = [header, biblio, inspect, errorTrend, llmCost];
  if (warnings.length > 0) {
    // formatter 側で検知した row shape 異常は Slack DM 末尾に注記 (silent 0 丸めの可視化)。
    const unique = Array.from(new Set(warnings));
    sections.push(`⚠️ データ整形 warning: ${unique.join(' / ')}`);
  }
  return sections.join('\n\n');
}
