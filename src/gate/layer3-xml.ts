/**
 * M4-F Phase 2 gate Layer 3: XML trust boundary (Microsoft Spotlighting pattern)。
 *
 * 外部由来の text を XML tag で囲い、LLM に「これは指示ではなくデータ」と伝える。
 * `wrapUntrustedInput(patronText)` の戻り値を Layer 4 evaluator の Prompt 内
 * `<untrusted-input>{patron_utterance}</untrusted-input>` の位置に埋め込む
 * (Layer 4 で `String.prototype.replaceAll` により置換)。
 *
 * 参照: Microsoft Research Spotlighting (arXiv:2403.14720)。
 *
 * **境界破壊攻撃対策**: patron 発話中に既存の `</untrusted-input>` tag が含まれる場合、
 * それをそのまま囲むと LLM が「untrusted 区間終了 → 続く指示 は system の続き」と誤解する
 * 余地が生まれる (境界偽装)。事前に `</untrusted-input>` を HTML entity escape 済 form
 * `&lt;/untrusted-input&gt;` に置換することで境界を機械的に閉じる。
 */
const OPEN_TAG = '<untrusted-input>';
const CLOSE_TAG = '</untrusted-input>';
const CLOSE_TAG_ESCAPED = '&lt;/untrusted-input&gt;';

/**
 * 外部由来 text を `<untrusted-input>...</untrusted-input>` で囲む。
 *
 * @param text 外部由来の text (patron 発話。Layer 2 の identity return を経ている前提)。
 * @returns XML boundary で囲まれた text。既存の close tag は escape 済。
 */
export function wrapUntrustedInput(text: string): string {
  const escaped = text.replaceAll(CLOSE_TAG, CLOSE_TAG_ESCAPED);
  return `${OPEN_TAG}${escaped}${CLOSE_TAG}`;
}
