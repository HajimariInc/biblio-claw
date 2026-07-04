/**
 * M4-F Phase 2 gate-and-defense の型定義。
 *
 * gate は cheap-to-expensive の 4 層 (`layer1` pattern → `layer2` escape shell →
 * `layer3` XML boundary → `layer4` LLM evaluator) で patron 発話を評価し、
 * `biblio-adk` / `biblio-other` / `in-secure` の 3 分類のいずれかを返す。
 *
 * routing 判定 (biblio 操作 → ADK / 一般会話 → hybrid) と injection 遮断
 * (in-secure) の 2 課題を 1 つの evaluator (Layer 4) で兼ねる。
 */

/**
 * Vertex Gemini responseSchema (`layer4-evaluator.ts:RESPONSE_SCHEMA`) と一致させる closed union。
 *
 * - `biblio-adk`: biblio 9 tool の**確定的操作** (仕入れ / 検品 / カテゴライズ /
 *   陳列 / 蔵書一覧 / 設定変更 / 禁書 / 焼却 / 複数陳列)。ADK dispatcher へ routing。
 * - `biblio-other`: 上記以外の**正当な発話全て** (一般会話 / 質問 / 実行力仕事)。
 *   agent-container (hybrid, provider=null) へ routing。**fallback = biblio-other**
 *   (対話が既定の受け皿、PRD §意思決定ログ)。
 * - `in-secure`: prompt injection 疑いの遮断対象。3 点セット発火。
 */
export const CLASSIFICATIONS = ['biblio-adk', 'biblio-other', 'in-secure'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/**
 * どの層で分類が確定したか。log / span 属性で観測し、誤分類調整時の起点となる。
 * Layer 1 で in-secure 確定なら Layer 4 は未呼出 (早期 return)。
 */
export type GateLayer = 'layer1' | 'layer2' | 'layer3' | 'layer4';

/**
 * evaluateGate の戻り値。
 *
 * `latencyMs` は Layer 1 → Layer 4 の合計 (Layer 1 早期 return 時は Layer 1 分のみ)。
 * `model` は Layer 4 使用モデル (`gemini-3.1-flash-lite` 等)、Layer 1-3 で確定した場合 undefined。
 */
export interface GateResult {
  classification: Classification;
  /** 判定理由 (短文、log / span 属性 / audit log で観測)。日本語 or 英語混在許容。 */
  reason: string;
  /** 分類確定層。早期 return 時は `layer1`、Layer 4 通過時は `layer4`。 */
  layerHit: GateLayer;
  /** 合計 latency (ms)。`performance.now()` 差分。 */
  latencyMs: number;
  /** Layer 4 使用モデル。Layer 1-3 で確定した場合 undefined。 */
  model?: string;
}
