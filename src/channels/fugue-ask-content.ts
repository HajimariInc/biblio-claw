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
 * agent 応答値の先頭・末尾に既に `<external-content ...>...</external-content>` が付いている場合、
 * その 1 段だけを剥がして中身を返す (二重 wrap 防止の defensive strip、M4-H Phase 3.5 で追加)。
 *
 * fugue-ask.md §5 で「agent は JSON payload の値に `<external-content>` タグを付けない」と
 * 指示しているが、LLM が守らないケース (2026-07-08 Q2 実測で判明) を silent に吸収する。
 *
 * - text 全体が 1 個の外側 tag で囲まれているケースだけを剥がす (中間に散在する tag は残す)
 * - open tag は属性 (source-id / kind) を持つため regex は非貪欲マッチ
 * - close tag は EOF or trailing whitespace のみ
 * - マッチしない場合は元の text をそのまま返す
 */
const OUTER_EXTERNAL_CONTENT_RE = /^<external-content\b[^>]*>([\s\S]*?)<\/external-content>\s*$/;

function stripOuterExternalContent(text: string): string {
  const match = text.trim().match(OUTER_EXTERNAL_CONTENT_RE);
  return match?.[1] ?? text;
}

/**
 * 外部由来 text を `<external-content source-id="..." kind="...">...</external-content>` で囲む。
 *
 * 二重 wrap 防止: text が既に外側 `<external-content ...>...</external-content>` で囲まれている
 * 場合は先に剥がしてから新しいタグで包み直す (`stripOuterExternalContent`)。agent が fugue-ask.md
 * §5 の指示を守らずタグ付き値を返したケース (2026-07-08 Q2 実測) を silent に吸収する defensive
 * layer。剥がしても attribute (source-id / kind) は handleAsk 側の新しいものが正 = 情報損失なし。
 *
 * @param text 外部由来の text (Tavily / Drive tool の response、agent 内 LLM の summary 等)。
 * @param sourceId handleAsk が発行する連番 id (`src-01`, `src-02`, ..., or `summary` / `unknown`)。
 * @param kind `'web' | 'drive'` — source の backend 種別 (`AgentAskSource.kind` と一致)。
 * @returns XML boundary で囲まれた text。既存の close tag は escape 済、外側二重 wrap は剥がし済。
 */
export function wrapExternalContent(text: string, sourceId: string, kind: 'web' | 'drive'): string {
  const stripped = stripOuterExternalContent(text);
  const escaped = stripped.replaceAll(CLOSE_TAG, CLOSE_TAG_ESCAPED);
  return `<external-content source-id="${sourceId}" kind="${kind}">${escaped}${CLOSE_TAG}`;
}
