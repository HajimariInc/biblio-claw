/**
 * gate Layer 1: pattern detection (pure 正規表現)。
 *
 * cheap-to-expensive の最上流、副作用なし・依存なし・LLM 呼出なしで
 * 「明らかな英語 prompt injection」を早期 in-secure に落とす。日本語 pattern は
 * FP リスク (「前のことは忘れてください」等日常表現との衝突) が高いため追加しない
 * (Layer 4 の言語非依存 catch-all に委譲、詳細は plan §補足 C)。
 *
 * 5 pattern (OWASP LLM01:2025 + Prompt Injection Prevention Cheat Sheet 準拠):
 *   1. instruction override  — 「ignore/disregard/forget previous instructions」等
 *   2. role hijack          — 「you are now / act as / pretend to be」等
 *   3. system prompt extract — 「reveal/show/print system prompt」等
 *   4. fake delimiter       — `</system>` / `<|im_end|>` / `### new instructions:` 等
 *   5. encoded payload + exfiltration — base64/hex 長文字列 + 外部 URL POST 誘導
 *
 * 判定は「いずれか 1 pattern matched」で in-secure 確定 (short-circuit)。matched=false の
 * 場合、Layer 4 で意味論評価される。
 */

/** Layer 1 が確定させる判定結果。matched=true 時のみ `pattern` / `reason` を返す。 */
export interface Layer1Result {
  matched: boolean;
  /** matched=true 時、どの pattern に該当したか (log / audit の keying 用)。 */
  pattern?:
    | 'instruction_override'
    | 'role_hijack'
    | 'system_prompt_extraction'
    | 'fake_delimiter'
    | 'encoded_payload_with_exfiltration';
  /** matched=true 時、短い理由文 (span / audit に載る、80 文字以下目安)。 */
  reason?: string;
}

/** 1. instruction override — 「ignore/disregard/forget/override + previous/prior/above + instructions」等 */
const INSTRUCTION_OVERRIDE_RE =
  /\b(ignore|disregard|forget|override)\b(?:\s+\w+){0,3}?\s+\b(all|any|previous|prior|above|earlier)\b(?:\s+\w+){0,2}?\s+\b(instructions?|rules?|guidelines?|prompts?|directives?)\b/i;

/** 2. role hijack — 「you are now / act as / pretend to be / from now on you are」等 */
const ROLE_HIJACK_RE = /\b(you are now|act as (?:a|an)?|pretend (?:to be|you are)|from now on,? you are)\b/i;

/** 3. system prompt extraction — 「reveal/show/print + system prompt / initial instructions」等 */
const SYSTEM_PROMPT_EXTRACTION_RE =
  /\b(reveal|show|print|output|repeat|what (?:is|are|were))\b(?:\s+\w+){0,3}?\s+\b(system prompt|initial instructions?|original instructions?|your instructions?)\b/i;

/** 4. fake delimiter — `</system>` / `<|im_end|>` / `### new instructions:` 等の境界偽装 */
const FAKE_DELIMITER_RE =
  /<\/?\s*(system|user|assistant)\s*>|^\s*(system|assistant)\s*:|^\s*#{2,3}\s*(new|updated)\s+instructions?\b|<\|im_(start|end)\|>/im;

/**
 * 5. encoded payload (base64 40+ char / hex 20+ byte)。
 *
 * git SHA / UUID / `<owner>--<repo>` 形式 skill 名で誤ヒットしうるため、必ず
 * `EXFILTRATION_RE` (外部 URL への POST 誘導) と共起した場合のみ in-secure と判定する。
 * このガードは `detectInjectionPattern` 内で行う。
 */
const ENCODED_PAYLOAD_RE = /\b[A-Za-z0-9+/]{40,}={0,2}\b|\b(?:[0-9a-fA-F]{2}\s?){20,}\b/;

/**
 * exfiltration URL 誘導 (「send/post/curl + http(s)://...」)。
 *
 * allowlist: `github.com` / `raw.githubusercontent.com` / `*.googleapis.com` は除外
 * (shelve 結果 PR URL / OneCLI proxy 経由 GCP API との自己衝突回避)。
 */
const EXFILTRATION_RE =
  /\b(send|post|make a request to|curl)\b[\s\S]{0,30}(https?:\/\/(?!(?:github\.com|raw\.githubusercontent\.com|[\w.-]*\.googleapis\.com))\S+)/i;

/**
 * Layer 1 pattern detection の pure 関数。副作用なし・throw なし。
 *
 * 実行順序: instruction_override → role_hijack → system_prompt_extraction →
 * fake_delimiter → (encoded_payload AND exfiltration)。いずれか matched で
 * short-circuit return する。matched=false は Layer 4 委譲を意味する。
 *
 * @param text patron 発話の生 text (Layer 3 XML 囲みの**前**、生 text で走らせる)
 * @returns matched=true 時 pattern 名 + reason、matched=false 時は他 field undefined
 */
export function detectInjectionPattern(text: string): Layer1Result {
  if (INSTRUCTION_OVERRIDE_RE.test(text)) {
    return { matched: true, pattern: 'instruction_override', reason: 'instruction override phrase detected' };
  }
  if (ROLE_HIJACK_RE.test(text)) {
    return { matched: true, pattern: 'role_hijack', reason: 'role hijack phrase detected' };
  }
  if (SYSTEM_PROMPT_EXTRACTION_RE.test(text)) {
    return {
      matched: true,
      pattern: 'system_prompt_extraction',
      reason: 'system prompt extraction attempt detected',
    };
  }
  if (FAKE_DELIMITER_RE.test(text)) {
    return { matched: true, pattern: 'fake_delimiter', reason: 'fake conversation delimiter detected' };
  }
  // encoded payload は exfiltration URL 誘導と共起した場合のみ in-secure
  // (git SHA / UUID との FP 回避、詳細は §Layer 1 pattern 5 コメント)
  if (ENCODED_PAYLOAD_RE.test(text) && EXFILTRATION_RE.test(text)) {
    return {
      matched: true,
      pattern: 'encoded_payload_with_exfiltration',
      reason: 'encoded payload with exfiltration URL detected',
    };
  }
  return { matched: false };
}
