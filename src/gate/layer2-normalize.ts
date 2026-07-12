/**
 * gate Layer 2: 入力側 Unicode 正規化 (invisible / visual bypass 対策)。
 *
 * cheap-to-expensive の合成順序上、`evaluateGate` では **Layer 1 の直前**に呼ばれ、
 * patron 発話の生 text を「意味的に等価かつ pattern 検出が効きやすい canonical form」に
 * 潰す。これにより Layer 1 の ASCII regex (`INSTRUCTION_OVERRIDE_RE` 等) が
 * fullwidth 迂回・zero-width 挟み・bidi override 経由 Trojan Source 型・Unicode Tag block
 * 経由の invisible instruction の 4 種 bypass を「見える形」で捕捉できるようになる。
 * Layer 4 (LLM evaluator) も正規化済 text を見るため、invisible unicode 経由の
 * 意味論撹乱に対しても判定精度が上がる。
 *
 * 4 種処理:
 *   1. NFKC 正規化       — Unicode Standard Annex #15 の compatibility form。
 *                          fullwidth Latin `Ｉｇｎｏｒｅ` → 半角 `Ignore`、ligature 展開等
 *   2. Zero-width strip  — U+200B ZWSP / U+200C ZWNJ / U+200D ZWJ / U+FEFF BOM の 4 種
 *                          (Word Joiner U+2060 は改行禁止マーカー等の正当用途があるため意図的に対象外)
 *   3. Bidi override strip — U+202A-E (LRE/RLE/PDF/LRO/RLO 5 種) + U+2066-9
 *                          (LRI/RLI/FSI/PDI 4 種) の計 9 種 (CVE-2021-42574 Trojan Source 対策)
 *   4. Unicode Tag block strip — U+E0000-E007F (astral plane、surrogate pair)。
 *                          Claude 系直撃の invisible instruction 経路 (詳細と実測値は
 *                          docs/gate-4-layer.md §Layer 2 の参考文献参照)
 *
 * 契約: **pure + throw なし + 副作用なし**。呼出元 `evaluateGate` は本関数の戻り値を
 * Layer 1 / Layer 3 に渡す。audit log の `utterance` と span digest の `text_digest` は
 * router / fugue-http 側で **生 text** を保持し続ける (本関数は経由しない独立経路)、
 * 運用者可視性を優先。
 *
 * 副作用 (trade-off、許容):
 *   - NFKC 副作用: `①②③` → `123`、`㍿` → `株式会社`、半角カナ `ｱｲｳ` → 全角カナ `アイウ`
 *     (半角カナ→全角の canonical 方向は Unicode 仕様、逆ではない)
 *   - ZWJ 絵文字破壊: 家族絵文字 `👨‍👩‍👧‍👦` は ZWJ 除去で個別絵文字にバラける
 *     (context-aware 保護は業界に確立実装なし、biblio-claw は日本語/英語主体で実害少)
 *   - 地域旗絵文字破壊: `🏴󠁧󠁢󠁳󠁣󠁴󠁿` (Wales 等) は Tag block sequence で構成されるため
 *     Tag block strip で破壊される (biblio 用途で実害少、trade-off 明記で許容)
 *   - homoglyph 非対応: Cyrillic `а` (U+0430) → Latin `a` の視覚類似字は NFKC 対象外
 *     (`unicode-confusables` 系 npm dep は 2026-07 時点で決定版不在、Phase 3+ 検討)
 */

/**
 * zero-width 4 種 (U+200B / U+200C / U+200D / U+FEFF)。
 * ZWSP / ZWNJ / ZWJ / BOM のいずれも「見えない挟み込みで pattern 分断」型 bypass に使われる。
 * `u` flag + `\u{...}` で明示 (inline invisible char は lint `no-irregular-whitespace` に触れる)。
 *
 * `no-misleading-character-class` は ZWNJ (U+200C) + ZWJ (U+200D) の隣接を「結合して 1 文字を
 * 成す可能性」として警告するが、本 regex は **意図的に個別 code point として strip する目的**
 * で、結合した grapheme 単位のマッチングは望まないため disable する。
 */
// eslint-disable-next-line no-misleading-character-class
const ZERO_WIDTH_RE = /[\u{200B}\u{200C}\u{200D}\u{FEFF}]/gu;

/**
 * bidi override 9 種 (U+202A-E: LRE/RLE/PDF/LRO/RLO + U+2066-9: LRI/RLI/FSI/PDI)。
 * CVE-2021-42574 Trojan Source 攻撃で悪用される text 順序偽装制御文字。
 */
const BIDI_OVERRIDE_RE = /[\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;

/**
 * Unicode Tag block (U+E0000-U+E007F、astral plane)。
 * BMP 外のため `u` flag + `\u{...}` syntax で書く (単純 `[]` では文字クラス誤解釈)。
 * Claude 系モデル tool use 有効時に高い compliance を示す invisible instruction 経路
 * (実測値・論文出典は docs/gate-4-layer.md §Layer 2 参考文献の single source を参照)。
 */
const UNICODE_TAG_BLOCK_RE = /[\u{E0000}-\u{E007F}]/gu;

/**
 * 入力側 Unicode 正規化 pure 関数。
 *
 * 処理順: NFKC → zero-width strip → bidi strip → Tag block strip。順序は
 * 「先に NFKC で canonical 化してから invisible char を落とす」ことで、
 * 想定外の compatibility 展開後に残る invisible を確実に除去する意図。
 *
 * @param text patron 発話の生 text (Layer 1 に渡す前段で呼ばれる)
 * @returns 4 種正規化済 text。副作用なし、throw なし。
 */
export function normalizeInput(text: string): string {
  return text
    .normalize('NFKC')
    .replace(ZERO_WIDTH_RE, '')
    .replace(BIDI_OVERRIDE_RE, '')
    .replace(UNICODE_TAG_BLOCK_RE, '');
}
