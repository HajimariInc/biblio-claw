/**
 * M4-F Phase 4: tool 名 → 日本語 progress-status 文言 の pure mapper。
 *
 * agent-runner 側 `container_state.current_tool` (SDK 組み込み tool 名 or MCP
 * `mcp__<server>__<tool>` 形式) と、ADK dispatcher が扱う `functionCall.name` (mcp__ prefix
 * なしの ADK ネイティブ tool 名) の両方を扱う。未知 tool 名は generic fallback
 * (`作業中 (${toolName})`) で silent 化しない (gate.ts の event 命名方針と対称)。
 *
 * MCP server 名は container/agent-runner/src/providers/claude.ts:64-66 の mcpAllowPattern が
 * `[^a-zA-Z0-9_-]` を `_` に置換するため、seedMcpServers() で登録される 3 サーバ
 * (`nanoclaw` / `tavily` / `drive`) はサニタイズ前後で同名 (英数のみ) = server 名側に
 * `_` を含めない運用を継続する。
 */

/** SDK 組み込み tool (agent-runner TOOL_ALLOWLIST の主要 9 種) の日本語文言 */
const BUILTIN_STATUS: Record<string, string> = {
  Bash: 'bash 実行中',
  Read: 'ファイル読取中',
  Write: 'ファイル書込中',
  Edit: 'ファイル編集中',
  Glob: 'ファイル検索中',
  Grep: 'コード検索中',
  WebSearch: 'Web 検索中',
  WebFetch: 'Web ページ取得中',
  Task: 'サブエージェント実行中',
};

/**
 * ADK 経路で LLM が発火する biblio tool 名 (mcp__ prefix なし)。
 * dispatcher.ts が扱う `functionCall.name` はここに来る。
 * `container/agent-runner/src/mcp-tools/biblio.ts` の 9 tool と一致。
 */
const ADK_BIBLIO_STATUS: Record<string, string> = {
  acquire_biblio: '仕入れ中',
  inspect_biblio: '検品中',
  categorize_biblio: 'カテゴライズ中',
  shelve_biblio: '陳列中',
  shelve_biblio_multi: '陳列中 (複数)',
  enkin_biblio: '禁書処理中',
  shokyaku_biblio: '焼却処理中',
  list_biblio: '蔵書一覧取得中',
  update_config: '設定変更中',
};

/** MCP nanoclaw (biblio) tool 名 → 日本語文言。ADK_BIBLIO_STATUS と対称 */
const MCP_NANOCLAW_STATUS: Record<string, string> = ADK_BIBLIO_STATUS;

/**
 * tool 名を Slack assistant status 欄に表示する日本語文言に変換する。
 *
 * @param toolName container_state.current_tool の値 (agent-runner 経路) or
 *                 functionCall.name の値 (ADK dispatcher 経路)。null / undefined /
 *                 空文字 は null を返す (= updateTypingStatus 側で「作業終了」と解釈)。
 * @returns 日本語文言、または null (入力が空の場合)
 */
export function toolNameToStatus(toolName: string | null | undefined): string | null {
  if (!toolName) return null;

  // 1. SDK 組み込み tool
  const builtin = BUILTIN_STATUS[toolName];
  if (builtin) return builtin;

  // 2. ADK ネイティブ tool 名 (mcp__ prefix なしの biblio 9 tool)。
  //    dispatcher.ts の functionCall.name はここに来る。
  const adkBiblio = ADK_BIBLIO_STATUS[toolName];
  if (adkBiblio) return adkBiblio;

  // 3. MCP tool: `mcp__<server>__<tool>` 形式 (agent-runner container_state 経路)
  //    正規表現は server 名側に `_` を許可しない = seedMcpServers() で登録の 3 サーバは全て英数のみ。
  //    `mcp____tool` (server 名部分空) は match しない = generic fallback へ落ちる。
  const mcpMatch = toolName.match(/^mcp__([^_]+)__(.+)$/);
  if (mcpMatch) {
    const [, server, tool] = mcpMatch;
    if (server === 'nanoclaw') {
      const biblio = MCP_NANOCLAW_STATUS[tool];
      if (biblio) return biblio;
    }
    // 生活機能 (M4-F Phase 3): tavily = Web 検索、drive = ファイル参照
    if (server === 'tavily') return 'Web 検索中';
    if (server === 'drive') return 'ファイル参照中';
    // 未知 MCP server は server 名を提示 (silent 化しない)
    return `${server} 呼出中 (${tool})`;
  }

  // 4. 完全に未知 → generic fallback (silent 化しない、gate.ts event 命名方針と対称)
  return `作業中 (${toolName})`;
}
