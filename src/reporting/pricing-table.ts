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

// Vertex regional endpoint premium (Anthropic のみ適用、Gemini は単価に組込済)
export const VERTEX_REGIONAL_PREMIUM = 1.1;

// Gemini pricing (2026-07-01 non-global +10% 発動済み、今日 2026-07-09)
// biblio-claw の実運用モデル:
//   - INSPECT_DANGEROUS_MODEL=gemini-2.5-flash (k8s/10-orchestrator-statefulset.yaml:184)
//   - GATE_MODEL=gemini-3.1-flash-lite (k8s/10-orchestrator-statefulset.yaml:238)
export const GEMINI_PRICING = {
  'gemini-2.5-flash': { input: 0.3, output: 2.5 }, // Vertex regional 実効値
  'gemini-3.1-flash-lite': { input: 0.275, output: 1.65 }, // non-global (2026-07-01〜)
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
