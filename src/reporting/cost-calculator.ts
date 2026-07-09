import {
  ANTHROPIC_PRICING,
  GEMINI_PRICING,
  VERTEX_REGIONAL_PREMIUM,
  isAnthropicModel,
  isGeminiModel,
} from './pricing-table.js';

export interface UsageInput {
  model: string;
  tokens_in: number;
  tokens_out: number;
  // cache_read.input_tokens (`vertex-client.ts` の現行 emit で捕捉可能な場合のみ非 undefined)
  cache_read?: number;
  // cache_creation.input_tokens (biblio-claw 現行未捕捉 = 常に undefined)。
  // 将来 emit が追加されたら optional を required にリファクタする anchor。
  cache_creation?: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface CostResult {
  cost_usd: number;
  breakdown: CostBreakdown;
  provider: 'anthropic' | 'gemini' | 'unknown';
  warnings: string[];
}

const CACHE_CREATION_UNCAPTURED_WARNING = 'cache_creation.input_tokens not captured, cost is underestimated';

// pure fn: usage → cost。throw しない、未知 model は cost_usd: 0 + warnings で返す (silent failure 撲滅)。
export function computeCost(usage: UsageInput): CostResult {
  const warnings: string[] = [];
  const zeroBreakdown: CostBreakdown = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

  if (isAnthropicModel(usage.model)) {
    const p = ANTHROPIC_PRICING[usage.model];
    const cacheRead = usage.cache_read ?? 0;
    const cacheCreation = usage.cache_creation ?? 0;
    if (usage.cache_creation === undefined) {
      warnings.push(CACHE_CREATION_UNCAPTURED_WARNING);
    }
    const breakdown: CostBreakdown = {
      input: (usage.tokens_in * p.input) / 1_000_000,
      output: (usage.tokens_out * p.output) / 1_000_000,
      cache_read: (cacheRead * p.cache_read) / 1_000_000,
      cache_write: (cacheCreation * p.cache_write) / 1_000_000,
    };
    const rawCost = breakdown.input + breakdown.output + breakdown.cache_read + breakdown.cache_write;
    const cost_usd = rawCost * VERTEX_REGIONAL_PREMIUM;
    return {
      cost_usd,
      breakdown: {
        input: breakdown.input * VERTEX_REGIONAL_PREMIUM,
        output: breakdown.output * VERTEX_REGIONAL_PREMIUM,
        cache_read: breakdown.cache_read * VERTEX_REGIONAL_PREMIUM,
        cache_write: breakdown.cache_write * VERTEX_REGIONAL_PREMIUM,
      },
      provider: 'anthropic',
      warnings,
    };
  }

  if (isGeminiModel(usage.model)) {
    // Gemini 単価は既に Vertex regional 経路の実効値 (pricing-table.ts の comment 参照)。
    // VERTEX_REGIONAL_PREMIUM を再乗算しない。
    const p = GEMINI_PRICING[usage.model];
    const breakdown: CostBreakdown = {
      input: (usage.tokens_in * p.input) / 1_000_000,
      output: (usage.tokens_out * p.output) / 1_000_000,
      cache_read: 0,
      cache_write: 0,
    };
    const cost_usd = breakdown.input + breakdown.output;
    return { cost_usd, breakdown, provider: 'gemini', warnings };
  }

  warnings.push(`unknown_model: ${usage.model}`);
  return { cost_usd: 0, breakdown: zeroBreakdown, provider: 'unknown', warnings };
}

// 複数行の usage を集計 (SQL 集計結果 → 合算 cost + provider 別 breakdown)。
export interface AggregatedCost {
  total_usd: number;
  anthropic_usd: number;
  gemini_usd: number;
  unknown_usd: number;
  warnings: string[];
}

export function aggregateCosts(rows: UsageInput[]): AggregatedCost {
  const warningSet = new Set<string>();
  let anthropic = 0;
  let gemini = 0;
  let unknown = 0;
  for (const row of rows) {
    const r = computeCost(row);
    for (const w of r.warnings) warningSet.add(w);
    if (r.provider === 'anthropic') anthropic += r.cost_usd;
    else if (r.provider === 'gemini') gemini += r.cost_usd;
    else unknown += r.cost_usd;
  }
  return {
    total_usd: anthropic + gemini + unknown,
    anthropic_usd: anthropic,
    gemini_usd: gemini,
    unknown_usd: unknown,
    warnings: Array.from(warningSet),
  };
}
