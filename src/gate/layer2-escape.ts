/**
 * gate Layer 2: markdown escaping / neutralized formatting (shell + TODO)。
 *
 * Phase 2 shell: identity return。将来 Phase 3+ で拡張予定 (PRD §gate agent 仕様 §Layer 2:
 * 「関数 shell + TODO の骨格のみ置く、将来の拡張点を構造として確保する」明記)。
 *
 * TODO(Phase 3+): 以下を検討:
 *   - fenced code block (```) の escape (indirect injection 経由の instruction 埋込対策)
 *   - inline code (`...`) の escape
 *   - HTML tag の decode ('&#65;&#66;' → 'AB' 等) 後の再検査
 *
 * これらは pattern detection の false negative rate と trade-off、Phase 3 の Web 検索経路
 * (取得コンテンツの indirect injection 対策) で本格実装。
 */
export function escapeMarkdown(text: string): string {
  return text; // Phase 2: identity return
}
