# Claude Agent SDK ディープダイブ

`@anthropic-ai/claude-agent-sdk` v0.2.29–0.2.34 のリバースエンジニアリングから得られた知見。`query()` がどう動くか、なぜ agent team の subagent が kill されていたか、どう直したかを理解するため。公式 SDK リファレンスドキュメントで補強した。

## アーキテクチャ

```
Agent Runner (our コード)
  └── query() → SDK (sdk.mjs)
        └── CLI サブプロセス (cli.js) を spawn
              └── Claude API 呼び出し、tool 実行
              └── Task ツール → subagent サブプロセスを spawn
```

SDK は `cli.js` を子プロセスとして `--output-format stream-json --input-format stream-json --print --verbose` フラグ付きで spawn する。通信は stdin/stdout 上の JSON-lines で行う。

`query()` は `AsyncGenerator<SDKMessage, void>` を拡張する `Query` オブジェクトを返す。内部的には:

- SDK は CLI を子プロセスとして spawn し、stdin/stdout の JSON 行で通信する
- SDK の `readMessages()` が CLI の stdout から読み、内部ストリームに enqueue する
- `readSdkMessages()` async generator がそのストリームから yield する
- `[Symbol.asyncIterator]` は `readSdkMessages()` を返す
- イテレータが `done: true` を返すのは CLI が stdout を閉じたときのみ

V1(`query()`)と V2(`createSession`/`send`/`stream`)は両方ともまったく同じ 3 層アーキテクチャを使う:

```
SDK (sdk.mjs)           CLI プロセス (cli.js)
--------------          --------------------
XX Transport  ------>   stdin リーダー (bd1)
  (cli.js を spawn)        |
$X Query      <------   stdout ライター
  (JSON-lines)             |
                        EZ() 再帰ジェネレータ
                           |
                        Anthropic Messages API
```

## コア agent ループ (EZ)

CLI の内部で、エージェントループは **`EZ()` という再帰 async generator** であり、反復的な while ループではない:

```
EZ({ messages, systemPrompt, canUseTool, maxTurns, turnCount=1, ... })
```

各呼び出し = Claude への 1 回の API 呼び出し(1 「turn」)。

### turn ごとのフロー:

1. **メッセージを準備** — context を trim し、必要なら compaction する
2. **Anthropic API を呼ぶ**(`mW1` ストリーミング関数経由)
3. **tool_use ブロックを抽出する**(レスポンスから)
4. **分岐:**
   - **tool_use ブロック無し** → 停止(stop hook を実行、return)
   - **tool_use ブロックあり** → ツールを実行、turnCount をインクリメント、再帰

すべての複雑なロジック — エージェントループ、ツール実行、バックグラウンドタスク、teammate オーケストレーション — は CLI サブプロセスの中で動く。`query()` は薄いトランスポートラッパーである。

## query() オプション

公式ドキュメントの完全な `Options` 型:

| プロパティ | 型 | デフォルト | 説明 |
|----------|------|---------|-------------|
| `abortController` | `AbortController` | `new AbortController()` | 操作をキャンセルするための controller |
| `additionalDirectories` | `string[]` | `[]` | Claude がアクセス可能な追加ディレクトリ |
| `agents` | `Record<string, AgentDefinition>` | `undefined` | subagent をプログラマティックに定義(agent team ではない — オーケストレーションなし) |
| `allowDangerouslySkipPermissions` | `boolean` | `false` | `permissionMode: 'bypassPermissions'` 使用時に必須 |
| `allowedTools` | `string[]` | すべてのツール | 許可するツール名のリスト |
| `betas` | `SdkBeta[]` | `[]` | ベータ機能(例:1M context 用の `['context-1m-2025-08-07']`) |
| `canUseTool` | `CanUseTool` | `undefined` | ツール使用のカスタム permission 関数 |
| `continue` | `boolean` | `false` | 最新の会話を継続する |
| `cwd` | `string` | `process.cwd()` | カレントワーキングディレクトリ |
| `disallowedTools` | `string[]` | `[]` | 禁止ツール名のリスト |
| `enableFileCheckpointing` | `boolean` | `false` | rewind 用のファイル変更追跡を有効化 |
| `env` | `Dict<string>` | `process.env` | 環境変数 |
| `executable` | `'bun' \| 'deno' \| 'node'` | 自動検出 | JavaScript ランタイム |
| `fallbackModel` | `string` | `undefined` | 主要モデルが失敗したときに使うモデル |
| `forkSession` | `boolean` | `false` | resume 時、元を継続せず新しいセッション ID で fork する |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | `{}` | イベント向けの hook コールバック |
| `includePartialMessages` | `boolean` | `false` | partial message イベント(ストリーミング)を含める |
| `maxBudgetUsd` | `number` | `undefined` | クエリの最大予算(USD) |
| `maxThinkingTokens` | `number` | `undefined` | thinking プロセスの最大トークン数 |
| `maxTurns` | `number` | `undefined` | 会話の最大 turn 数 |
| `mcpServers` | `Record<string, McpServerConfig>` | `{}` | MCP server の設定 |
| `model` | `string` | CLI のデフォルト | 使う Claude モデル |
| `outputFormat` | `{ type: 'json_schema', schema: JSONSchema }` | `undefined` | 構造化出力フォーマット |
| `pathToClaudeCodeExecutable` | `string` | 組み込みを使用 | Claude Code 実行可能ファイルへのパス |
| `permissionMode` | `PermissionMode` | `'default'` | Permission モード |
| `plugins` | `SdkPluginConfig[]` | `[]` | ローカルパスからカスタムプラグインを読む |
| `resume` | `string` | `undefined` | 再開するセッション ID |
| `resumeSessionAt` | `string` | `undefined` | 特定のメッセージ UUID でセッション再開 |
| `sandbox` | `SandboxSettings` | `undefined` | サンドボックス挙動設定 |
| `settingSources` | `SettingSource[]` | `[]`(なし) | どのファイルシステム設定を load するか。CLAUDE.md を load するには `'project'` を含める必要がある |
| `stderr` | `(data: string) => void` | `undefined` | stderr 出力用コールバック |
| `systemPrompt` | `string \| { type: 'preset'; preset: 'claude_code'; append?: string }` | `undefined` | System prompt。preset で Claude Code のプロンプトを得る、`append` はオプション |
| `tools` | `string[] \| { type: 'preset'; preset: 'claude_code' }` | `undefined` | ツール設定 |

### PermissionMode

```typescript
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
```

### SettingSource

```typescript
type SettingSource = 'user' | 'project' | 'local';
// 'user'    → ~/.claude/settings.json
// 'project' → .claude/settings.json (バージョン管理対象)
// 'local'   → .claude/settings.local.json (gitignore 対象)
```

省略時、SDK はファイルシステム設定を一切 load しない(デフォルトで分離)。優先順位:local > project > user。プログラマティックなオプションは常にファイルシステム設定を上書きする。

### AgentDefinition

プログラマティックな subagent(agent team ではない — こちらはシンプル、agent 間の調整なし):

```typescript
type AgentDefinition = {
  description: string;  // この agent をいつ使うか
  tools?: string[];     // 許可するツール(省略時は全部継承)
  prompt: string;       // agent の system prompt
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
}
```

### McpServerConfig

```typescript
type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sdk'; name: string; instance: McpServer }  // in-process
```

### SdkBeta

```typescript
type SdkBeta = 'context-1m-2025-08-07';
// Opus 4.6、Sonnet 4.5、Sonnet 4 で 1M トークンのコンテキストウィンドウを有効化
```

### CanUseTool

```typescript
type CanUseTool = (
  toolName: string,
  input: ToolInput,
  options: { signal: AbortSignal; suggestions?: PermissionUpdate[] }
) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput: ToolInput; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };
```

## SDKMessage の型

`query()` は 16 のメッセージタイプを yield しうる。公式ドキュメントは 7 種類の簡略 union を示しているが、`sdk.d.ts` には完全セットがある:

| 型 | サブタイプ | 役割 |
|------|---------|---------|
| `system` | `init` | セッション初期化、session_id、tools、model を含む |
| `system` | `task_notification` | バックグラウンド agent の completed/failed/stopped |
| `system` | `compact_boundary` | 会話が compact された |
| `system` | `status` | ステータス変化(例:compacting) |
| `system` | `hook_started` | Hook 実行開始 |
| `system` | `hook_progress` | Hook 進捗出力 |
| `system` | `hook_response` | Hook 完了 |
| `system` | `files_persisted` | ファイル保存 |
| `assistant` | — | Claude のレスポンス(text + tool 呼び出し) |
| `user` | — | ユーザメッセージ(内部) |
| `user` (replay) | — | 再開時に再生されるユーザメッセージ |
| `result` | `success` / `error_*` | プロンプト処理ラウンドの最終結果 |
| `stream_event` | — | partial ストリーミング(includePartialMessages 時) |
| `tool_progress` | — | 長時間ツールの進捗 |
| `auth_status` | — | 認証状態の変化 |
| `tool_use_summary` | — | 先行する tool 使用のサマリ |

### SDKTaskNotificationMessage (sdk.d.ts:1507)

```typescript
type SDKTaskNotificationMessage = {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  status: 'completed' | 'failed' | 'stopped';
  output_file: string;
  summary: string;
  uuid: UUID;
  session_id: string;
};
```

### SDKResultMessage (sdk.d.ts:1375)

共有フィールドを持つ 2 バリアント:

```typescript
// 両バリアント共通フィールド:
// uuid, session_id, duration_ms, duration_api_ms, is_error, num_turns,
// total_cost_usd, usage: NonNullableUsage, modelUsage, permission_denials

// 成功:
type SDKResultSuccess = {
  type: 'result';
  subtype: 'success';
  result: string;
  structured_output?: unknown;
  // ...共有フィールド
};

// エラー:
type SDKResultError = {
  type: 'result';
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
  errors: string[];
  // ...共有フィールド
};
```

result の有用なフィールド:`total_cost_usd`、`duration_ms`、`num_turns`、`modelUsage`(モデルごとの内訳、`costUSD`、`inputTokens`、`outputTokens`、`contextWindow` を含む)。

### SDKAssistantMessage

```typescript
type SDKAssistantMessage = {
  type: 'assistant';
  uuid: UUID;
  session_id: string;
  message: APIAssistantMessage; // Anthropic SDK から
  parent_tool_use_id: string | null; // subagent から来た場合は non-null
};
```

### SDKSystemMessage (init)

```typescript
type SDKSystemMessage = {
  type: 'system';
  subtype: 'init';
  uuid: UUID;
  session_id: string;
  apiKeySource: ApiKeySource;
  cwd: string;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  model: string;
  permissionMode: PermissionMode;
  slash_commands: string[];
  output_style: string;
};
```

## Turn の挙動:エージェントが停止する vs 継続する

### エージェントが停止するとき(API 呼び出し終了)

**1. レスポンスに tool_use ブロックなし(主要ケース)**

Claude がテキストだけで応答した — タスクが完了したと判断した。API の `stop_reason` は `"end_turn"` になる。SDK はこの判断をしない — 完全に Claude のモデル出力で駆動される。

**2. Max turns 超過** — `subtype: "error_max_turns"` 付き `SDKResultError` になる。

**3. Abort シグナル** — `abortController` 経由のユーザ割り込み。

**4. 予算超過** — `totalCost >= maxBudgetUsd` → `"error_max_budget_usd"`。

**5. Stop hook が継続を阻止** — Hook が `{preventContinuation: true}` を返す。

### エージェントが継続するとき(もう 1 回 API 呼び出し)

**1. レスポンスに tool_use ブロックを含む(主要ケース)** — ツールを実行、turnCount をインクリメント、EZ に再帰。

**2. max_output_tokens のリカバリ** — 「作業をより小さな piece に分割せよ」というコンテキストメッセージ付きで最大 3 回リトライ。

**3. Stop hook のブロックエラー** — エラーをコンテキストメッセージとしてフィードバック、ループ継続。

**4. モデルフォールバック** — フォールバックモデルでリトライ(一度きり)。

### 判断表

| 条件 | アクション | 結果タイプ |
|-----------|--------|-------------|
| レスポンスに `tool_use` ブロックあり | ツール実行、`EZ` に再帰 | continues |
| レスポンスに `tool_use` ブロック無し | stop hook を実行、return | `success` |
| `turnCount > maxTurns` | max_turns_reached を yield | `error_max_turns` |
| `totalCost >= maxBudgetUsd` | 予算エラーを yield | `error_max_budget_usd` |
| `abortController.signal.aborted` | interrupted msg を yield | コンテキスト依存 |
| `stop_reason === "max_tokens"`(出力) | リカバリプロンプトで最大 3 回リトライ | continues |
| Stop hook `preventContinuation` | 即 return | `success` |
| Stop hook ブロックエラー | エラーをフィードバック、再帰 | continues |
| モデルフォールバックエラー | フォールバックモデルでリトライ(一度) | continues |

## Subagent 実行モード

### Case 1: 同期 subagent(`run_in_background: false`) — BLOCKS

親エージェントが Task ツールを呼ぶ → `VR()` が subagent 用の `EZ()` を走らせる → 親はフル結果を待つ → ツール結果が親に返される → 親が継続する。

Subagent は完全な再帰 EZ ループを走らせる。親のツール実行は `await` 経由で停止する。実行中の「昇格」メカニズムがある:同期 subagent は `backgroundSignal` プロミスに対する `Promise.race()` 経由でバックグラウンドに昇格できる。

### Case 2: バックグラウンドタスク(`run_in_background: true`) — 待たない

- **Bash ツール:** コマンドを spawn し、ツールは空の結果 + `backgroundTaskId` をすぐ返す
- **Task/Agent ツール:** Subagent を fire-and-forget ラッパー(`g01()`)で起動し、ツールは `status: "async_launched"` + `outputFile` パスをすぐ返す

`type: "result"` メッセージを emit する前に「バックグラウンドタスクを待つ」ロジックはゼロ。バックグラウンドタスクが完了したら、`SDKTaskNotificationMessage` が別途 emit される。

### Case 3: Agent team(TeammateTool / SendMessage) — 結果が先、その後ポーリング

チームリーダーは通常の EZ ループを走らせる(teammate の spawn を含む)。リーダーの EZ ループが終わると `type: "result"` が emit される。その後、リーダーは結果後のポーリングループに入る:

```javascript
while (true) {
    // アクティブな teammate が無く、走っているタスクも無ければ → break
    // teammate からの未読メッセージをチェック → 新プロンプトとして再注入、EZ ループ再開
    // アクティブな teammate がいる状態で stdin が閉じれば → シャットダウンプロンプトを注入
    // 500ms ごとにポーリング
}
```

SDK 消費者の視点では:最初の `type: "result"` を受け取るが、チームリーダーが teammate のレスポンスを処理してエージェントループに再突入するにつれ、AsyncGenerator はさらにメッセージを yield しうる。Generator が本当に終わるのは、すべての teammate がシャットダウンした時のみ。

## isSingleUserTurn 問題

sdk.mjs から:

```javascript
QK = typeof X === "string"  // isSingleUserTurn = prompt が文字列のとき true
```

`isSingleUserTurn` が true で最初の `result` メッセージが届くと:

```javascript
if (this.isSingleUserTurn) {
  this.transport.endInput();  // CLI への stdin を閉じる
}
```

これが連鎖反応をトリガーする:

1. SDK が CLI の stdin を閉じる
2. CLI が stdin の close を検知
3. ポーリングループがアクティブな teammate と共に `D = true`(stdin 閉じた)を見る
4. シャットダウンプロンプトを注入 → リーダーが全 teammate に `shutdown_request` を送る
5. **Teammate が研究の途中で kill される**

シャットダウンプロンプト(minified cli.js の `BGq` 変数経由で発見):

```
You are running in non-interactive mode and cannot return a response
to the user until your team is shut down.

You MUST shut down your team before preparing your final response:
1. Use requestShutdown to ask each team member to shut down gracefully
2. Wait for shutdown approvals
3. Use the cleanup operation to clean up the team
4. Only then provide your final response to the user
```

### 実際の問題

V1 `query()` + 文字列プロンプト + agent team の組合せで:

1. リーダーが teammate を spawn、彼らが研究を始める
2. リーダーの EZ ループが終わる(「チームを派遣した、彼らが取り組んでいる」)
3. `type: "result"` emit
4. SDK が `isSingleUserTurn = true` を見る → 即 stdin を閉じる
5. ポーリングループが stdin 閉じた + アクティブな teammate を検知 → シャットダウンプロンプト注入
6. リーダーが全 teammate に `shutdown_request` を送る
7. **Teammate は 5 分の研究タスクの 10 秒目にいるかもしれないのに止められる**

## 修正:ストリーミング入力モード

文字列プロンプトを渡す(`isSingleUserTurn = true` になる)代わりに、`AsyncIterable<SDKUserMessage>` を渡す:

```typescript
// 前(agent team で壊れる):
query({ prompt: "do something" })

// 後(CLI を生かしておく):
query({ prompt: asyncIterableOfMessages })
```

Prompt が `AsyncIterable` のとき:
- `isSingleUserTurn = false`
- SDK は最初の結果後に stdin を閉じない
- CLI は生き続け、処理を続ける
- バックグラウンドエージェントは走り続ける
- `task_notification` メッセージがイテレータを流れる
- iterable をいつ終わらせるかは我々が制御する

### 追加の利点:新メッセージのストリーミング

非同期イテラブルアプローチでは、エージェントがまだ作業中の間に、新規受信した WhatsApp メッセージを iterable にプッシュできる。コンテナが exit してから新コンテナを spawn するまでメッセージをキューするのではなく、走っているセッションに直接ストリームする。

### Agent team 利用時の意図したライフサイクル

非同期 iterable 修正(`isSingleUserTurn = false`)で stdin が開いたままになるので、CLI は teammate チェックやシャットダウンプロンプト注入に決して当たらない:

```
1. system/init          → セッション初期化
2. assistant/user       → Claude reasoning、tool 呼び出し、tool 結果
3. ...                  → さらに assistant/user turn(subagent spawn 等)
4. result #1            → リードエージェントの最初のレスポンス(キャプチャ)
5. task_notification(s) → バックグラウンドエージェントの complete/fail/stop
6. assistant/user       → リードエージェントが継続(subagent 結果を処理)
7. result #2            → リードエージェントのフォローアップレスポンス(キャプチャ)
8. [iterator done]      → CLI が stdout を閉じた、すべて完了
```

すべての結果は意味がある — 最初のだけでなく、全部キャプチャする。

## V1 vs V2 API

### V1: `query()` — ワンショット async generator

```typescript
const q = query({ prompt: "...", options: {...} });
for await (const msg of q) { /* イベント処理 */ }
```

- `prompt` が文字列のとき:`isSingleUserTurn = true` → 最初の結果後に stdin が自動で閉じる
- マルチターン:`AsyncIterable<SDKUserMessage>` を渡し、調整を自前で管理する必要がある

### V2: `createSession()` + `send()` / `stream()` — 永続セッション

```typescript
await using session = unstable_v2_createSession({ model: "..." });
await session.send("first message");
for await (const msg of session.stream()) { /* イベント */ }
await session.send("follow-up");
for await (const msg of session.stream()) { /* イベント */ }
```

- `isSingleUserTurn = false` 常に → stdin は開いたまま
- `send()` は非同期キュー(`QX`)に enqueue する
- `stream()` は同じメッセージジェネレータから yield し、`result` タイプで停止する
- マルチターンは自然 — `send()` / `stream()` を交互に呼ぶだけ
- V2 は内部で V1 `query()` を呼ばない — 両方とも独立に Transport + Query を作る

### 比較表

| 観点 | V1 | V2 |
|--------|----|----|
| `isSingleUserTurn` | 文字列プロンプトで `true` | 常に `false` |
| マルチターン | `AsyncIterable` の管理が必要 | `send()`/`stream()` を呼ぶだけ |
| stdin ライフサイクル | 最初の結果後に自動で閉じる | `close()` まで開いたまま |
| エージェントループ | 同じ `EZ()` | 同じ `EZ()` |
| 停止条件 | 同じ | 同じ |
| セッション永続性 | 新 `query()` に `resume` を渡す必要 | セッションオブジェクト経由で組み込み |
| API 安定性 | Stable | Unstable プレビュー(`unstable_v2_*` プレフィックス) |

**主要発見:turn 挙動に差はゼロ。** 両方とも同じ CLI プロセス、同じ `EZ()` 再帰ジェネレータ、同じ判断ロジックを使う。

## Hook イベント

```typescript
type HookEvent =
  | 'PreToolUse'         // ツール実行前
  | 'PostToolUse'        // ツール実行成功後
  | 'PostToolUseFailure' // ツール実行失敗後
  | 'Notification'       // 通知メッセージ
  | 'UserPromptSubmit'   // ユーザプロンプト送信
  | 'SessionStart'       // セッション開始(startup/resume/clear/compact)
  | 'SessionEnd'         // セッション終了
  | 'Stop'               // エージェント停止
  | 'SubagentStart'      // subagent spawn
  | 'SubagentStop'       // subagent 停止
  | 'PreCompact'         // 会話 compaction 前
  | 'PermissionRequest'; // permission 要求中
```

### Hook 設定

```typescript
interface HookCallbackMatcher {
  matcher?: string;      // オプションのツール名マッチャ
  hooks: HookCallback[];
}

type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;
```

### Hook の戻り値

```typescript
type HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput;

type AsyncHookJSONOutput = { async: true; asyncTimeout?: number };

type SyncHookJSONOutput = {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: 'approve' | 'block';
  systemMessage?: string;
  reason?: string;
  hookSpecificOutput?:
    | { hookEventName: 'PreToolUse'; permissionDecision?: 'allow' | 'deny' | 'ask'; updatedInput?: Record<string, unknown> }
    | { hookEventName: 'UserPromptSubmit'; additionalContext?: string }
    | { hookEventName: 'SessionStart'; additionalContext?: string }
    | { hookEventName: 'PostToolUse'; additionalContext?: string };
};
```

### Subagent Hook(sdk.d.ts から)

```typescript
type SubagentStartHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStart';
  agent_id: string;
  agent_type: string;
};

type SubagentStopHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStop';
  stop_hook_active: boolean;
  agent_id: string;
  agent_transcript_path: string;
  agent_type: string;
};

// BaseHookInput = { session_id, transcript_path, cwd, permission_mode? }
```

## Query インターフェースのメソッド

`Query` オブジェクト(sdk.d.ts:931)。公式ドキュメントが list する public メソッド:

```typescript
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;                     // 現在の実行を停止(ストリーミング入力モードのみ)
  rewindFiles(userMessageUuid: string): Promise<void>; // メッセージ時点のファイル状態に復元(enableFileCheckpointing が必要)
  setPermissionMode(mode: PermissionMode): Promise<void>; // permission を変更(ストリーミング入力モードのみ)
  setModel(model?: string): Promise<void>;        // モデル変更(ストリーミング入力モードのみ)
  setMaxThinkingTokens(max: number | null): Promise<void>; // thinking トークン変更(ストリーミング入力モードのみ)
  supportedCommands(): Promise<SlashCommand[]>;   // 利用可能な slash コマンド
  supportedModels(): Promise<ModelInfo[]>;         // 利用可能なモデル
  mcpServerStatus(): Promise<McpServerStatus[]>;  // MCP server 接続状態
  accountInfo(): Promise<AccountInfo>;             // 認証済ユーザ情報
}
```

sdk.d.ts にあるが公式ドキュメントには無いもの(内部かもしれない):
- `streamInput(stream)` — 追加のユーザメッセージをストリーム
- `close()` — クエリを強制終了
- `setMcpServers(servers)` — MCP server を動的に追加 / 削除

## サンドボックス設定

```typescript
type SandboxSettings = {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  excludedCommands?: string[];
  allowUnsandboxedCommands?: boolean;
  network?: {
    allowLocalBinding?: boolean;
    allowUnixSockets?: string[];
    allowAllUnixSockets?: boolean;
    httpProxyPort?: number;
    socksProxyPort?: number;
  };
  ignoreViolations?: {
    file?: string[];
    network?: string[];
  };
};
```

`allowUnsandboxedCommands` が true のとき、モデルは Bash ツール入力で `dangerouslyDisableSandbox: true` を設定でき、それは `canUseTool` permission ハンドラにフォールバックする。

## MCP Server ヘルパー

### tool()

Zod スキーマで型安全な MCP ツール定義を作る:

```typescript
function tool<Schema extends ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: z.infer<ZodObject<Schema>>, extra: unknown) => Promise<CallToolResult>
): SdkMcpToolDefinition<Schema>
```

### createSdkMcpServer()

in-process な MCP server を作る(私たちは subagent の継承のため stdio を使う):

```typescript
function createSdkMcpServer(options: {
  name: string;
  version?: string;
  tools?: Array<SdkMcpToolDefinition<any>>;
}): McpSdkServerConfigWithInstance
```

## 内部リファレンス

### 主要 minified 識別子(sdk.mjs)

| Minified | 役割 |
|----------|---------|
| `s_` | V1 `query()` export |
| `e_` | `unstable_v2_createSession` |
| `Xx` | `unstable_v2_resumeSession` |
| `Qx` | `unstable_v2_prompt` |
| `U9` | V2 Session クラス(`send`/`stream`/`close`) |
| `XX` | ProcessTransport(cli.js を spawn) |
| `$X` | Query クラス(JSON-line ルーティング、async iterable) |
| `QX` | AsyncQueue(入力ストリームバッファ) |

### 主要 minified 識別子(cli.js)

| Minified | 役割 |
|----------|---------|
| `EZ` | コア再帰エージェントループ(async generator) |
| `_t4` | Stop hook ハンドラ(tool_use ブロック無しのとき走る) |
| `PU1` | ストリーミングツール executor(API レスポンス中に並列) |
| `TP6` | 標準ツール executor(API レスポンス後) |
| `GU1` | 個別ツール executor |
| `lTq` | SDK セッションランナー(EZ を直接呼ぶ) |
| `bd1` | stdin リーダー(transport からの JSON-lines) |
| `mW1` | Anthropic API ストリーミング呼び出し |

## 主要ファイル

- `sdk.d.ts` — すべての型定義(1777 行)
- `sdk-tools.d.ts` — ツール入力スキーマ
- `sdk.mjs` — SDK ランタイム(minified、376KB)
- `cli.js` — CLI 実行可能ファイル(minified、サブプロセスとして走る)
