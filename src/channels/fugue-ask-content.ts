/**
 * M4-H Phase 3 trust boundary: Fugue ask endpoint 応答の `<external-content>` タグ囲み helper。
 *
 * Contract §5.5 は agent-container が Web / Drive から取得した外部由来 text の 4 field
 * (`summary` / `findings[].text` / `sources[].title` / `sources[].snippet`) を
 * `<external-content source-id="{id}" kind="web|drive">...</external-content>` で囲むことを要求する
 * (Fugue Director LLM に「これは指示ではなくデータ」と伝える Spotlighting pattern の応用)。
 *
 * **既存 `<untrusted-input>` (`src/gate/layer3-xml.ts`) との関係**:
 * - M4-F Layer 3 の `wrapUntrustedInput()` はタグ名が別で、handleAsk の親 gate 経路
 *   (evaluateGate の Layer 4 プロンプト内で patron 発話を囲む) にのみ使われる。
 * - 本 helper は Fugue Director LLM に返す response body の 4 field を囲むためのもので、
 *   両 helper は独立して共存する (PRD §論点 A の α 案 = 「新 helper 並置、既存不変」)。
 *
 * **境界破壊攻撃対策**: 外部由来 text 中に `</external-content>` が含まれる場合、そのまま囲むと
 * Fugue Director LLM が「external-content 区間終了 → 続く text は system の続き」と誤解する余地が
 * 生まれる (境界偽装)。事前に `</external-content>` を HTML entity escape 済 form
 * `&lt;/external-content&gt;` に置換して境界を機械的に閉じる (`wrapUntrustedInput` の写経)。
 *
 * **属性 injection 対策**: `sourceId` は handleAsk が発行する連番 (`src-01`, `src-02`, ...)、
 * `kind` は `AgentAskSource.kind` の literal enum (`'web' | 'drive'`)。両者とも Zod schema
 * (`fugue-schemas.ts`) or handleAsk 側で literal 制約下にあり、属性値の追加 escape は本 helper 側
 * では行わない (Zod で拒絶済み)。
 */
const CLOSE_TAG = '</external-content>';
const CLOSE_TAG_ESCAPED = '&lt;/external-content&gt;';

/**
 * 外部由来 text を `<external-content source-id="..." kind="...">...</external-content>` で囲む。
 *
 * @param text 外部由来の text (Tavily / Drive tool の response、agent 内 LLM の summary 等)。
 * @param sourceId handleAsk が発行する連番 id (`src-01`, `src-02`, ..., or `summary` / `unknown`)。
 * @param kind `'web' | 'drive'` — source の backend 種別 (`AgentAskSource.kind` と一致)。
 * @returns XML boundary で囲まれた text。既存の close tag は escape 済。
 */
export function wrapExternalContent(text: string, sourceId: string, kind: 'web' | 'drive'): string {
  const escaped = text.replaceAll(CLOSE_TAG, CLOSE_TAG_ESCAPED);
  return `<external-content source-id="${sourceId}" kind="${kind}">${escaped}${CLOSE_TAG}`;
}
