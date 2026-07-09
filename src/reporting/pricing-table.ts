// Anthropic Claude + Gemini pricing table (2026-07-09 時点、per MTok = per 1,000,000 tokens)
//
// SOURCE (Anthropic):
//   https://platform.claude.com/docs/en/about-claude/pricing#model-pricing
//   base 単価 (US region、Vertex 込みではない生値)
//
// SOURCE (Vertex regional premium):
//   https://docs.cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude
//   regional/multi-region endpoint = base × 1.10 (10% premium)
//   global endpoint = base 価格
//   biblio-claw は regional 経路 (CLOUD_ML_REGION 明示指定) = 1.10 倍計上
//
// SOURCE (Gemini):
//   https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-flash-lite/
//   Global $0.25/$1.50、non-global $0.275/$1.65 (+10%)、2026-07-01 発動済み
//   Gemini 単価は既に regional 経路の実効値で hardcode (cost 側で ×1.10 しない)
//
// GOTCHA:
// - Opus 4.7 Fast mode ($30/$150) は 2026-07-24 廃止予定 = 単価表に含めない (通常 Opus 4.7 のみ)
// - Gemini 3.1 Flash-Lite Preview (`-preview` サフィックス) は 2026-07-09 (今日) 廃止 = non-preview のみ
// - `cache_creation.input_tokens` は biblio-claw で未捕捉 (emit されていない)。
//   cache_write 単価は存在するが SQL 側で SUM 対象データが常に NULL、cost 計算からは欠落する。
//   将来 emit が追加されたら cost-calculator.ts の cache_creation optional を required にリファクタする anchor。
// - Cache TTL 現況: `AnthropicVertexLlm.ts` / `vertex-client.ts` で cache_control.ttl 明示なし
//   → Anthropic API default = 5 分キャッシュ = cache_write は base × 1.25 の単一係数で近似可 (1 時間 = 2.0 は未使用)

export const ANTHROPIC_PRICING = {
  'claude-sonnet-4-6': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  'claude-opus-4-7': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'claude-haiku-4-5': { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
} as const;

// Vertex regional endpoint premium 定数 (base × 10%)
// Global endpoint (base 価格) 経路では premium を適用しないため 1.0 を返す。
// 適用判断は `resolveVertexPremium` を経由し、`CLOUD_ML_REGION` env で切替する。
export const VERTEX_REGIONAL_PREMIUM = 1.1;
export const VERTEX_GLOBAL_PREMIUM = 1.0;

// Provider ごとの premium 適用マップ (不変条件を型で強制、3 つ目の provider 追加時に
// TS の Record が compile error で強制させる)。Gemini 単価は pricing-table 側で
// Vertex Global 単価を hardcode 済のため二重乗算しない = 常に 1.0。
export type PricingProvider = 'anthropic' | 'gemini';
export const PROVIDER_APPLIES_VERTEX_PREMIUM: Record<PricingProvider, boolean> = {
  anthropic: true,
  gemini: false,
};

// resolveVertexPremium: `CLOUD_ML_REGION` env に基づき Anthropic 経路への premium 係数を決定。
// - `global` → 1.0 (Global endpoint、base 価格経路)
// - それ以外 (未設定 / 明示 regional / multi-region) → 1.10 (regional premium 経路)
//
// biblio-claw Prod は `CLOUD_ML_REGION=global` を明示指定
// (k8s/10-orchestrator-statefulset.yaml:179,375 参照)。
// M4-C review 前の実装は無条件 ×1.10 適用でコストを ~10% 過大計上していた
// (2026-07-09 review 反映)。
export function resolveVertexPremium(): number {
  const region = (process.env.CLOUD_ML_REGION ?? '').trim().toLowerCase();
  return region === 'global' ? VERTEX_GLOBAL_PREMIUM : VERTEX_REGIONAL_PREMIUM;
}

// Gemini pricing (M4-C Phase 2: 2026-07-09 pinning)
// biblio-claw の実運用モデル:
//   - INSPECT_DANGEROUS_MODEL=gemini-2.5-flash (k8s/10-orchestrator-statefulset.yaml:184)
//   - GATE_MODEL=gemini-3.1-flash-lite (k8s/10-orchestrator-statefulset.yaml:238)
//
// Gemini は `PROVIDER_APPLIES_VERTEX_PREMIUM.gemini = false` で cost-calculator の premium
// 適用対象外。biblio-claw の Prod は `CLOUD_ML_REGION=global` 明示指定のため、
// 本 table は **Vertex Global 単価** (base 値、+10% 前) を hardcode する。
// 将来 non-global 経路に切替える場合は本 table を +10% or PROVIDER_APPLIES_VERTEX_PREMIUM を
// true に切替 (両建ては禁止、二重乗算になる)。
export const GEMINI_PRICING = {
  // SOURCE を Vertex 公式 pricing ページと Google Developer API pricing の
  // 2 出典で交差検証。数値が両方で一致することを Prod 請求書 1-2 週分蓄積後 (Phase 3) に突合予定。
  // SOURCE (primary): https://cloud.google.com/vertex-ai/generative-ai/pricing (Vertex AI Generative AI pricing 公式)
  // SOURCE (secondary): https://ai.google.dev/gemini-api/docs/pricing (Gemini Developer API pricing、Vertex とは別課金体系だが Global 単価は現状一致)
  // Vertex regional (asia-northeast1 等) は +10% 想定、biblio-claw は CLOUD_ML_REGION=global 明示のため base 値
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  // URL typo fix (旧: `/gemini-3-1-flash-lite/` 直下、正: `/gemini-models/gemini-3-1-flash-lite/`)
  // SOURCE (primary): https://cloud.google.com/vertex-ai/generative-ai/pricing (Vertex AI Generative AI pricing 公式)
  // SOURCE (secondary): https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-flash-lite/
  // Global $0.25/$1.50、non-global $0.275/$1.65 (+10%、2026-07-01 発動済)
  // biblio-claw は CLOUD_ML_REGION=global 明示のため Global 値。Prod 請求書 1-2 週分蓄積後
  // (Phase 3 送り) で実測突合予定、精密化差分は runbook §M4-C Phase 2 運用 memo に記録
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
} as const;

export type AnthropicModelId = keyof typeof ANTHROPIC_PRICING;
export type GeminiModelId = keyof typeof GEMINI_PRICING;
export type ModelId = AnthropicModelId | GeminiModelId;

export function isAnthropicModel(model: string): model is AnthropicModelId {
  return model in ANTHROPIC_PRICING;
}

export function isGeminiModel(model: string): model is GeminiModelId {
  return model in GEMINI_PRICING;
}
