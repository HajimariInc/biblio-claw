/**
 * tool 名 → 日本語 progress-status 文言 の pure mapper。
 *
 * agent-runner 側 `container_state.current_tool` (SDK 組み込み tool 名 or MCP
 * `mcp__<server>__<tool>` 形式) と、ADK dispatcher が扱う `functionCall.name` (mcp__ prefix
 * なしの ADK ネイティブ tool 名) の両方を扱う。未知 tool 名は generic fallback
 * (`作業中 (${toolName})`) で silent 化しない (gate.ts の event 命名方針と対称)。
 *
 * MCP server 名は container/agent-runner/src/providers/claude.ts:64-66 の mcpAllowPattern が
 * `[^a-zA-Z0-9_-]` を `_` に置換するため、以下 3 サーバはサニタイズ前後で同名 (英数のみ):
 *   - `nanoclaw` = **container/agent-runner/src/index.ts:88-93 の built-in MCP server**
 *     (host 側 biblio 9 tool = acquire/inspect/categorize/shelve 系)
 *   - `tavily` / `drive` = `scripts/init-hybrid-agent.ts:seedMcpServers()` の DB seed 登録
 *     (生活機能として追加、`container_config.mcp_servers` 経由で agent-runner に注入)
 * (`seedMcpServers()` は tavily/drive の 2 サーバのみ扱う点に注意 = nanoclaw は
 *  agent-runner 内蔵で seed 経路とは別建て)
 * 運用上、server 名側に `_` を含めない = 上記正規表現の match 前提が成立する慣習を継続。
 */

/**
 * router.ts の pre-spawn / cold-start 段階で使う進行ステージ文言。
 *
 * tool 名マップ (BUILTIN_STATUS / ADK_BIBLIO_STATUS / MCP_NANOCLAW_STATUS) とは
 * 別枠 = gate 分類中 / container 起動中は「tool」ではなく「pipeline stage」。
 * `as const` で literal 型で export し、router.ts の呼出箇所と単一源化する
 * (typo による表記ゆれ + runbook「既知の罠」記述の行番号 hardcode リスクを
 * 構造的に削減する)。
 *
 * テスト側 (typing/index.test.ts 等) はあえてこの定数を import せず独立した
 * 文字列 literal (`'container 起動中'`) を書くこと = 本番文言が silent に変わっても
 * テストが気づかない退化を防ぐ。
 */
export const PIPELINE_STATUS = {
  GATE_CLASSIFYING: '分類中',
  CONTAINER_STARTING: 'container 起動中',
} as const;

/**
 * SDK 組み込み tool の日本語文言。
 *
 * `container/agent-runner/src/providers/claude.ts` の `TOOL_ALLOWLIST` (18 種) と対称。
 * 当初は主要 9 種のみだったが、高頻度 tool (`TodoWrite` 等) が generic fallback に落ちて
 * patron に「作業中 (TodoWrite)」表示されていた (test 自身が `TodoWrite` を未知 tool の
 * 例として使い網羅性不足を固定化していた実測経路)。
 * 全 18 種を明示マップし、fallback は本当に未知の tool 名だけに限定する。
 */
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
  TaskOutput: 'サブエージェント出力取得中',
  TaskStop: 'サブエージェント停止中',
  TeamCreate: 'チーム作成中',
  TeamDelete: 'チーム削除中',
  SendMessage: 'メッセージ送信中',
  TodoWrite: 'タスク管理中',
  ToolSearch: 'ツール検索中',
  Skill: 'スキル呼出中',
  NotebookEdit: 'ノートブック編集中',
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
    // 生活機能: tavily = Web 検索、drive = ファイル参照
    if (server === 'tavily') return 'Web 検索中';
    if (server === 'drive') return 'ファイル参照中';
    // 未知 MCP server は server 名を提示 (silent 化しない)
    return `${server} 呼出中 (${tool})`;
  }

  // 4. 完全に未知 → generic fallback (silent 化しない、gate.ts event 命名方針と対称)
  return `作業中 (${toolName})`;
}
