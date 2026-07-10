import {
  ANTHROPIC_PRICING,
  GEMINI_PRICING,
  PROVIDER_APPLIES_VERTEX_PREMIUM,
  isAnthropicModel,
  isGeminiModel,
  resolveVertexPremium,
  type PricingProvider,
} from './pricing-table.js';

export interface UsageInput {
  model: string;
  tokens_in: number;
  tokens_out: number;
  // M4-C Phase 2 で emit + SQL 列追加済。
  //   emit: AnthropicVertexLlm.ts + vertex-client.ts の log.info('vertex.call', ...) payload に
  //         `cache_read: usage.cache_read_input_tokens ?? 0` / `cache_creation: ... ?? 0` を追加。
  //   SQL:  llm-cost.sql に `SUM(CAST(jsonPayload.cache_read AS INT64)) AS total_cache_read` /
  //         同 cache_creation の列を追加。
  //   両者を経由することで、Anthropic 経路の cache コストが cost 集計に載る。
  //   undefined になるのは (a) 単体テストで row literal が該当キーを持たない case、(b) BQ NULL 経路
  //   (`normalizeLlmCostRow` の null ガード対称化により、旧ログの部分カバレッジ = undefined、
  //   normalizeLlmCostRow の null ガード対称化)。両 case で warnings 経路が発火する。
  cache_read?: number;
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
  provider: PricingProvider | 'unknown';
  warnings: string[];
}

const CACHE_CREATION_UNCAPTURED_WARNING = 'cache_creation.input_tokens not captured, cost is underestimated';
const CACHE_READ_UNCAPTURED_WARNING = 'cache_read.input_tokens not captured, cost is underestimated';

// pure fn: usage → cost。throw しない、未知 model は cost_usd: 0 + warnings で返す (silent failure 撲滅)。
// Vertex premium の適用は `PROVIDER_APPLIES_VERTEX_PREMIUM` map で provider 別に強制
// (Anthropic のみ ×1.10 の runtime 分岐を型で保証、新 provider 追加時は map エントリを強制)。
// `regionMode`/`premiumOverride` を optional で受け取ることで、cronjob 側で `CLOUD_ML_REGION` env を
// 解決した値を注入できる (test での env 依存を最小化)。
export interface ComputeCostOptions {
  // 未指定なら `resolveVertexPremium()` で env から解決 (default)
  premiumOverride?: number;
}

export function computeCost(usage: UsageInput, opts: ComputeCostOptions = {}): CostResult {
  const warnings: string[] = [];
  const zeroBreakdown: CostBreakdown = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const providerPremium = (provider: PricingProvider): number => {
    if (!PROVIDER_APPLIES_VERTEX_PREMIUM[provider]) return 1.0;
    return opts.premiumOverride ?? resolveVertexPremium();
  };

  if (isAnthropicModel(usage.model)) {
    const p = ANTHROPIC_PRICING[usage.model];
    const cacheRead = usage.cache_read ?? 0;
    const cacheCreation = usage.cache_creation ?? 0;
    if (usage.cache_read === undefined) {
      warnings.push(CACHE_READ_UNCAPTURED_WARNING);
    }
    if (usage.cache_creation === undefined) {
      warnings.push(CACHE_CREATION_UNCAPTURED_WARNING);
    }
    const rawBreakdown: CostBreakdown = {
      input: (usage.tokens_in * p.input) / 1_000_000,
      output: (usage.tokens_out * p.output) / 1_000_000,
      cache_read: (cacheRead * p.cache_read) / 1_000_000,
      cache_write: (cacheCreation * p.cache_write) / 1_000_000,
    };
    const premium = providerPremium('anthropic');
    return {
      cost_usd:
        (rawBreakdown.input + rawBreakdown.output + rawBreakdown.cache_read + rawBreakdown.cache_write) * premium,
      breakdown: {
        input: rawBreakdown.input * premium,
        output: rawBreakdown.output * premium,
        cache_read: rawBreakdown.cache_read * premium,
        cache_write: rawBreakdown.cache_write * premium,
      },
      provider: 'anthropic',
      warnings,
    };
  }

  if (isGeminiModel(usage.model)) {
    // Gemini 単価は pricing-table 側で Vertex Global 単価 (base 値) を hardcode 済、
    // premium は map で 1.0 固定 (二重乗算しない不変条件を PROVIDER_APPLIES_VERTEX_PREMIUM
    // で強制)。biblio-claw Prod は `CLOUD_ML_REGION=global` 明示指定のため Global 経路と一致。
    const p = GEMINI_PRICING[usage.model];
    const breakdown: CostBreakdown = {
      input: (usage.tokens_in * p.input) / 1_000_000,
      output: (usage.tokens_out * p.output) / 1_000_000,
      cache_read: 0,
      cache_write: 0,
    };
    const premium = providerPremium('gemini'); // 常に 1.0、明示化のため呼出は残す
    return {
      cost_usd: (breakdown.input + breakdown.output) * premium,
      breakdown,
      provider: 'gemini',
      warnings,
    };
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

export interface AggregateCostsOptions extends ComputeCostOptions {}

export function aggregateCosts(rows: UsageInput[], opts: AggregateCostsOptions = {}): AggregatedCost {
  const warningSet = new Set<string>();
  let anthropic = 0;
  let gemini = 0;
  let unknown = 0;
  for (const row of rows) {
    const r = computeCost(row, opts);
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
