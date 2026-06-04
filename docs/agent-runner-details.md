# NanoClaw Agent-Runner 詳細

コンテナ内 agent-runner の実装レベル詳細。高レベル設計は [architecture.md](architecture.md) を参照。

## 関心の分離

Agent-runner は 2 つのレイヤを持つ:

1. **Agent-runner コア** — ポーリングループ、メッセージフォーマット、DB 読み書き、MCP ツール実装、ルーティング、状態管理、メディア処理を所有する。これは NanoClaw 固有で全 provider で共有される。

2. **Agent provider** — SDK との対話を所有する。フォーマット済プロンプトを受け取り、SDK にプッシュし、イベントを yield して返す。Trunk は `claude` provider を出荷;追加 provider(OpenCode、Codex 等)は `providers` ブランチから `/add-<provider>` skill によってインストールされる。

境界:agent-runner は **何を** 送り、結果で **何をするか** を決める。Provider は SDK と **どう** 話すかを決める。

## AgentProvider インターフェース

```typescript
interface AgentProvider {
  /** 新しいクエリを開始する。入力と出力をストリームするハンドルを返す。 */
  query(input: QueryInput): AgentQuery;
}

interface QueryInput {
  /** 初期プロンプト(agent-runner が既にフォーマット済)。
   *  テキストのみなら string。マルチモーダル(画像、PDF、音声)なら ContentBlock[]。 */
  prompt: string | ContentBlock[];

  /** 再開するセッション ID(あれば) */
  sessionId?: string;

  /** セッションの特定地点から再開(provider 固有、無視されうる) */
  resumeAt?: string;

  /** コンテナ内のワーキングディレクトリ */
  cwd: string;

  /** MCP server 設定(正規化フォーマット — provider が変換する) */
  mcpServers: Record<string, McpServerConfig>;

  /** System prompt / 開発者命令 */
  systemPrompt?: string;

  /** SDK プロセス用の環境変数 */
  env: Record<string, string | undefined>;

  /** agent がアクセス可能な追加ディレクトリ */
  additionalDirectories?: string[];
}

interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface AgentQuery {
  /** アクティブなクエリにフォローアップメッセージをプッシュ */
  push(message: string): void;

  /** これ以上入力を送らないことを通知 */
  end(): void;

  /** 出力イベントストリーム */
  events: AsyncIterable<ProviderEvent>;

  /** クエリを強制停止(例:コンテナシャットダウン) */
  abort(): void;
}

type ProviderEvent =
  | { type: 'init'; sessionId: string }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string };
```

### インターフェースに含まれないもの

- **メッセージフォーマット** — agent-runner が provider に渡す前にメッセージをフォーマットする。Provider は送信準備済プロンプト文字列を受け取る。
- **Hook** — Claude 固有。Claude provider が内部で hook(PreCompact、PreToolUse 等)を登録する。他の provider には不要。
- **ツール allowlist** — Claude は `allowedTools` を使う。Codex は `approvalPolicy`。OpenCode は `permission`。各 provider が同じ意図(「すべてを許可、プロンプトしない」)に基づいて内部で設定する。
- **セッション永続化** — Claude はセッションを自動でディスクに永続化する。Codex と OpenCode は独自のセッション状態を管理する。Agent-runner はこれを制御しない — `sessionId` と `resumeAt` を渡すだけ。
- **サンドボックス設定** — provider 固有。各 provider が内部で自身のサンドボックスを設定する。

### Provider イベントの意味論

- **`init`** — Provider がセッションを確立または再開するときクエリごとに 1 回 emit される。Agent-runner は将来の再開のため `sessionId` をキャプチャする。
- **`result`** — Agent が完全なレスポンスを生成したとき emit される。クエリごとに複数回 emit されうる(例:subagent 付きの Claude のマルチターン)。Agent-runner は各結果を messages_out に書く。
- **`error`** — 失敗時に emit される。`retryable` は agent-runner がリトライすべきかを示す。`classification` はオプションの詳細(例:'quota'、'auth'、'transport')。
- **`progress`** — オプション、ロギング用。Agent-runner はこれをログするがそれ以上行動しない。

## Provider 実装

Trunk に同梱されるのは `claude` provider のみ。下記の Codex と OpenCode セクションは、参考用および追加 provider をインストールする skill のため provider インターフェースをドキュメント化する — コアイメージには焼き込まれていない。

### Claude Provider

`@anthropic-ai/claude-agent-sdk` の `query()` をラップする。

```typescript
class ClaudeProvider implements AgentProvider {
  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();  // AsyncIterable<SDKUserMessage>
    stream.push(input.prompt);

    const sdkQuery = query({
      prompt: stream,
      options: {
        cwd: input.cwd,
        resume: input.sessionId,
        resumeSessionAt: input.resumeAt,
        systemPrompt: input.systemPrompt
          ? { type: 'preset', preset: 'claude_code', append: input.systemPrompt }
          : undefined,
        mcpServers: input.mcpServers,  // 既に正しい形
        additionalDirectories: input.additionalDirectories,
        env: input.env,
        allowedTools: NANOCLAW_TOOL_ALLOWLIST,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        hooks: {
          PreCompact: [{ hooks: [preCompactHook] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [sanitizeBashHook] }],
        },
      },
    });

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      abort: () => sdkQuery.close(),
      events: translateClaudeEvents(sdkQuery),
    };
  }
}
```

`translateClaudeEvents` は SDK メッセージを `ProviderEvent` にマップする async generator:
- `message.type === 'system' && message.subtype === 'init'` → `{ type: 'init', sessionId }`
- `message.type === 'result'` → `{ type: 'result', text }`
- `message.type === 'system' && message.subtype === 'api_retry'` → `{ type: 'error', retryable: true }`
- `message.type === 'system' && message.subtype === 'rate_limit_event'` → `{ type: 'error', retryable: false, classification: 'quota' }`
- `message.type === 'system' && message.subtype === 'task_notification'` → `{ type: 'progress', message }`
- それ以外 → ログするが emit しない

**Provider 内で保たれる Claude 固有機能:**
- 非同期 iterable 入力用の `MessageStream`(push ベース)
- 特定のメッセージ UUID で再開する `resumeSessionAt`
- トランスクリプトアーカイブ用の PreCompact hook
- Bash env var をサニタイズする PreToolUse hook
- フルツール allowlist
- 複数ディレクトリアクセスの `additionalDirectories`

### Codex Provider

`@openai/codex-sdk` をラップする。

```typescript
class CodexProvider implements AgentProvider {
  query(input: QueryInput): AgentQuery {
    const codex = new Codex(this.buildOptions(input));
    const thread = input.sessionId
      ? codex.resumeThread(input.sessionId, this.threadOptions(input))
      : codex.startThread(this.threadOptions(input));

    const abortController = new AbortController();
    let pendingFollowUp: string | null = null;

    return {
      push: (msg) => {
        // Codex はストリーミング入力をサポートしない。
        // フォローアップを保存して現在の turn を abort。
        pendingFollowUp = msg;
        abortController.abort();
      },
      end: () => { /* no-op — Codex の turn は自然に終わる */ },
      abort: () => abortController.abort(),
      events: this.run(thread, input.prompt, abortController, () => pendingFollowUp),
    };
  }

  private async *run(thread, prompt, abortController, getPendingFollowUp): AsyncIterable<ProviderEvent> {
    let currentPrompt = prompt;

    while (true) {
      try {
        const streamed = await thread.runStreamed(currentPrompt, {
          signal: abortController.signal,
        });

        let sessionId: string | undefined;
        let resultText = '';

        for await (const event of streamed.events) {
          if (event.type === 'thread.started') {
            sessionId = event.thread_id;
            yield { type: 'init', sessionId };
          }
          if (event.type === 'item.completed' && event.item.type === 'agent_message') {
            resultText = event.item.text || resultText;
          }
          if (event.type === 'turn.failed') {
            yield { type: 'error', message: event.error.message, retryable: false };
            return;
          }
        }

        yield { type: 'result', text: resultText || null };

        // この turn 中にフォローアップがキューされたか確認
        const followUp = getPendingFollowUp();
        if (followUp) {
          currentPrompt = followUp;
          // 次のイテレーションのためリセット
          continue;
        }

        return;
      } catch (err) {
        if (abortController.signal.aborted && getPendingFollowUp()) {
          // フォローアップで abort されたので、新プロンプトで再開
          currentPrompt = getPendingFollowUp();
          abortController = new AbortController();
          continue;
        }
        throw err;
      }
    }
  }
}
```

**Provider 内の Codex 固有挙動:**
- System prompt 用の `developer_instructions`(CLAUDE.md から load)
- ワークスペースで `git init`(Codex は git repo を要求する)
- フォローアップメッセージのため abort+restart パターン
- env var からの `sandboxMode`、`approvalPolicy`、`networkAccessEnabled`
- 会話アーカイブ(Codex に PreCompact は無い)

### OpenCode Provider

`@opencode-ai/sdk` をラップする。

```typescript
class OpenCodeProvider implements AgentProvider {
  query(input: QueryInput): AgentQuery {
    // OpenCode はローカルサーバを走らせる — 一度作ってクエリ間で再利用
    const { client, server } = await createOpencode({ config: this.buildConfig(input) });
    const { stream } = await client.event.subscribe();

    let aborted = false;
    let pendingFollowUp: string | null = null;

    return {
      push: (msg) => {
        pendingFollowUp = msg;
        server.close();  // 現在のクエリを中断
      },
      end: () => { /* no-op */ },
      abort: () => { aborted = true; server.close(); },
      events: this.run(client, server, stream, input, () => pendingFollowUp),
    };
  }

  private async *run(client, server, stream, input, getPendingFollowUp): AsyncIterable<ProviderEvent> {
    const session = await client.session.create();
    yield { type: 'init', sessionId: session.data.id };

    await client.session.promptAsync({
      path: { id: session.data.id },
      body: { parts: [{ type: 'text', text: input.prompt }] },
    });

    for await (const event of stream) {
      if (event.type === 'session.idle') {
        // 累積したメッセージ部分から結果テキストを集める
        const resultText = this.extractResult(event);
        yield { type: 'result', text: resultText };

        const followUp = getPendingFollowUp();
        if (followUp) {
          await client.session.promptAsync({
            path: { id: session.data.id },
            body: { parts: [{ type: 'text', text: followUp }] },
          });
          continue;
        }

        return;
      }

      if (event.type === 'session.error') {
        yield { type: 'error', message: event.properties?.error?.data?.message, retryable: false };
        return;
      }
    }
  }
}
```

**Provider 内の OpenCode 固有挙動:**
- ローカル gRPC/HTTP サーバライフサイクル(`server.close()`)
- 出力用 SSE イベントストリーム
- Config 経由の provider / model 選択(`OPENCODE_PROVIDER`、`OPENCODE_MODEL`)
- MCP config フォーマット変換(`type: 'local'`、`command: [cmd, ...args]`、`environment`)
- プロンプトテキスト内の `<system>` プレフィックス経由で system prompt 注入
- Resume サポート無し(セッションは常に新規または ID で再利用)

## Agent-Runner コア

以下はすべて agent-runner が扱うもので、provider ではない。

### ポーリングループ

```
┌─────────────────────────────────────────┐
│                                         │
│  1. messages_in を pending 行で query   │
│     WHERE status = 'pending'            │
│     AND (process_after IS NULL          │
│          OR process_after <= now())     │
│                                         │
│  2. 行が見つかったら:                    │
│     a. status = 'processing' に設定     │
│     b. kind ごとにメッセージをフォーマット │
│     c. ルーティングフィールドを strip   │
│     d. provider.query(prompt) を呼ぶ   │
│     e. provider イベントを処理         │
│     f. 結果を messages_out に書く      │
│     g. status = 'completed' に設定     │
│                                         │
│  3. クエリがアクティブの間:              │
│     - messages_in を polling し続ける  │
│     - 新メッセージ → provider.push()   │
│                                         │
│  4. クエリが終わったら:                  │
│     - step 1 に戻る                    │
│     - メッセージが無ければ sleep + 再 poll │
│                                         │
└─────────────────────────────────────────┘
```

**アクティブクエリ中の並行ポーリング:** Provider がクエリを走らせている間、agent-runner は短間隔(~500ms)で messages_in を polling し続ける。新しい pending メッセージはフォーマットされ、`provider.push()` 経由でアクティブクエリにプッシュされる。これによりエージェントが処理中にフォローアップメッセージが到着できる — Claude はこれをネイティブに扱い、Codex/OpenCode は内部で abort+restart で扱う。

**Idle 挙動:** メッセージが pending でなく、クエリがアクティブでないとき、agent-runner は短く sleep(1s)して再 poll する。コンテナは host が kill する(idle timeout)まで warm に保たれる。

**Idle 検知の例外:** コンテナは次の場合 idle と見なすべきではない:
- `ask_user_question` ツール呼び出しが pending(messages_in でユーザ応答待ち)
- エージェントがアクティブに作業中(ツール呼び出し進行中、subagent が走っている)

Agent-runner は host に「busy」状態を通知する。仕組みは provider 固有 — Claude では、クエリ AsyncGenerator が依然イベントを yield している。他の provider では、agent-runner は host が kill する前にチェックする heartbeat や状態インジケータをセッション DB に書ける。

### メッセージフォーマット

Agent-runner は messages_in 行をプロンプト文字列に変換する。Provider は送信準備済の文字列を受け取る — メッセージの kind やルーティングは知らない。

**ルーティングフィールドの strip:** `platform_id`、`channel_type`、`thread_id` はプロンプトに決して含まれない。messages_out を書くためのコンテキストとして保存される。

**kind による単一メッセージフォーマット:**

- **`chat`** — メッセージ XML にフォーマット:
  ```xml
  <message sender="John" time="2024-01-01 10:00">
    Check this PR
  </message>
  ```

- **`chat-sdk`** — シリアライズされた Chat SDK メッセージからフィールドを抽出:
  ```xml
  <message sender="John (john@slack)" time="2024-01-01 10:00">
    Check this PR
    [image: screenshot.png — https://signed-url...]
  </message>
  ```
  添付はインラインに list される。Claude がネイティブに扱う画像 / PDF はコンテンツブロックとして渡される(下記「メディア処理」参照)。

- **`task`** — タスクプロンプト、オプションでスクリプト出力付き:
  ```
  [SCHEDULED TASK]

  Script output:
  {"data": ...}

  Instructions:
  Review open PRs
  ```

- **`webhook`** — webhook ペイロード:
  ```
  [WEBHOOK: github/pull_request]

  {"action": "opened", "pull_request": {...}}
  ```

- **`system`** — host アクション結果(以前の system リクエストへの応答):
  ```
  [SYSTEM RESPONSE]

  Action: register_agent_group
  Status: success
  Result: {"agent_group_id": "ag-456"}
  ```

**バッチフォーマット:** 複数の pending メッセージは 1 つのプロンプトに統合される:

```xml
<context timezone="America/Los_Angeles">
<messages>
<message sender="John" time="10:00">Check this PR</message>
<message sender="Jane" time="10:01">Already on it</message>
</messages>
```

混合 kind(例:chat メッセージ + system レスポンス)は明確な区切りで統合される。各セクションは kind でラベル付けされる。

**コマンド検出:** `/` で始まるメッセージはコマンドリストとチェックされる。認識されたコマンドはフォーマットをバイパスし、生のまま provider に渡される(Claude の slash コマンド処理用)か、agent-runner がインターセプトする(セッションリセットのような NanoClaw レベルコマンド用)。

### ルーティング

Agent-runner が messages_in 行を拾うとき、バッチからルーティングフィールドをキャプチャする:

```typescript
interface RoutingContext {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null;  // トリガーとなったメッセージの messages_in.id
}
```

messages_out を書くとき(provider の結果からも、MCP ツール呼び出しからも)、agent-runner はデフォルトでこのルーティングコンテキストをコピーする。エージェントはルーティングフィールドを決して見ない — テキストを生成するだけ。ルーティングは暗黙的:「メッセージを送ってきた相手に返信する」。

異なる destination をターゲットにする MCP ツール(例:`send_to_agent`、明示的な channel 付き `send_message`)は、その特定の messages_out 行のためにルーティングコンテキストを上書きする。

### 状態管理

Agent-runner は messages_in の `status` と `status_changed` フィールドを管理する:

```
pending → processing → completed
                    → failed (provider がエラーを返しリトライ上限を使い切ったとき)
```

- **取得:** `UPDATE messages_in SET status = 'processing', status_changed = now(), tries = tries + 1 WHERE id IN (...)`
- **完了:** `UPDATE messages_in SET status = 'completed', status_changed = now() WHERE id IN (...)`
- **エラー:** Agent-runner は `failed` を設定しない — メッセージを `processing` のまま残す。Host が `status_changed` 経由で古い processing を検知し、リトライロジック(バックオフ付きで pending に戻す)を扱う。これによりリトライポリシーが host 側に保たれる。

### MCP ツール

Agent-runner はエージェントに NanoClaw ツールを公開する MCP server を走らせる。すべてのツールはセッション DB に書く。

**DB パス:** MCP server は環境変数経由でセッション DB パスを受け取る。同じ SQLite ファイルへの 2 つ目の接続を開く(WAL モードが並行アクセスを許す)。

#### send_message

現在の会話(または指定 destination)に chat メッセージを送る。

```typescript
{
  name: 'send_message',
  params: {
    text: string,          // メッセージ内容
    channel?: string,      // オプション: ターゲット channel タイプ(デフォルト: 起点に返信)
    platformId?: string,   // オプション: ターゲットプラットフォーム ID
    threadId?: string,     // オプション: ターゲット thread ID
  }
}
```

実装:`kind: 'chat'` の `messages_out` 行を書く。channel/platformId/threadId が提供されていればそれをルーティングとして使う。さもなければ現在のルーティングコンテキストからコピーする。

#### send_file

現在の会話にファイルを送る。

```typescript
{
  name: 'send_file',
  params: {
    path: string,          // ファイルパス(/workspace/agent/ 相対 または 絶対)
    text?: string,         // オプションの付随メッセージ
    filename?: string,     // 表示名(デフォルト: パスの basename)
  }
}
```

実装:
1. メッセージ ID を生成
2. `outbox/{messageId}/` ディレクトリを作成
3. ファイルを outbox ディレクトリにコピー
4. content に `files: [filename]` 付きの `messages_out` 行を書く

#### send_card

構造化カード(対話的または表示専用)を送る。

```typescript
{
  name: 'send_card',
  params: {
    card: CardElement,     // カード構造(title、children、actions)
    fallbackText?: string, // カードサポート無しプラットフォーム用テキストフォールバック
  }
}
```

実装:`kind: 'chat-sdk'` とカード構造を content に持つ `messages_out` 行を書く。

#### ask_user_question

対話的な質問を送り、ユーザの応答を待つ。これは **ブロッキングツール呼び出し** — ユーザが応答するまでツールが返らない。

```typescript
{
  name: 'ask_user_question',
  params: {
    title: string,         // 短いカードタイトル、例 "Confirm deletion"
    question: string,
    options: (string | { label: string; selectedLabel?: string; value?: string })[],
    timeout?: number,      // 秒(デフォルト: 300)
  }
}
```

実装:
1. `questionId` を生成
2. `operation: 'ask_question'`、質問、オプション、questionId を持つ `messages_out` 行を書く
3. content に一致する `questionId` を持つ行を `messages_in` で poll
4. 見つかったら、`selectedOption` をツール結果として返す
5. タイムアウト切れなら、タイムアウトエラーをツール結果として返す

エージェントの実行はこのツール呼び出しで停止する。Provider のクエリは走り続ける(Claude がツール呼び出しを開いたまま保持)。Agent-runner は別ループで応答を poll する。

#### edit_message

以前送ったメッセージを編集する。

```typescript
{
  name: 'edit_message',
  params: {
    messageId: string,     // エージェントに表示される整数 ID
    text: string,          // 新内容
  }
}
```

実装:`operation: 'edit'`、メッセージ ID、新テキストを持つ `messages_out` 行を書く。

#### add_reaction

メッセージに絵文字リアクションを追加する。

```typescript
{
  name: 'add_reaction',
  params: {
    messageId: string,     // エージェントに表示される整数 ID
    emoji: string,         // 絵文字名(例:'thumbs_up')
  }
}
```

実装:`operation: 'reaction'` を持つ `messages_out` 行を書く。

#### send_to_agent

別の agent group にメッセージを送る。

```typescript
{
  name: 'send_to_agent',
  params: {
    agentGroupId: string,  // ターゲット agent group
    text: string,          // メッセージ内容
    sessionId?: string,    // オプション: 特定セッションをターゲット
  }
}
```

実装:`channel_type: 'agent'`、`platform_id: agentGroupId`、`thread_id: sessionId` を持つ `messages_out` 行を書く。

#### schedule_task

ワンショットまたは再帰タスクをスケジュールする。

```typescript
{
  name: 'schedule_task',
  params: {
    prompt: string,             // タスクプロンプト
    processAfter: string,       // 最初の実行用 ISO タイムスタンプ
    recurrence?: string,        // cron 表現(オプション)
    script?: string,            // エージェント前スクリプト(オプション)
  }
}
```

実装:`kind: 'task'`、`process_after`、オプションで `recurrence` を持つ `messages_in` 行を(自身に)書く。Host sweep が due 時に拾う。

#### list_tasks

アクティブなスケジュール / 再帰タスクを list する。

```typescript
{
  name: 'list_tasks',
  params: {}
}
```

実装:`messages_in WHERE recurrence IS NOT NULL AND status != 'failed'` をクエリ。

#### cancel_task / pause_task / resume_task / update_task

スケジュール済タスクを修正する。

```typescript
{
  name: 'cancel_task',
  params: { taskId: string }
}
// pause_task: status = 'paused' を設定(再帰タスク用の新 status 値)
// resume_task: status = 'pending' を設定
// update_task: { prompt?, recurrence?, processAfter?, script? } をライブ行に merge
```

実装:cancel/pause/resume はライブ行を直接更新する。update_task は system アクションとして送られる — host が現在の content を読み、提供されたフィールドを merge し、書き戻す。4 つすべて `(id = ? OR series_id = ?) AND kind='task' AND status IN ('pending','paused')` でマッチし、再帰タスクのライブな次の発生に到達する(エージェントが元の(現在は完了の)id を渡しても)。

#### register_agent_group

新しい agent group を登録する(admin のみ)。

```typescript
{
  name: 'register_agent_group',
  params: {
    name: string,
    folder: string,
    platformId: string,        // 配線する messaging group
    channelType: string,
    triggerRules?: object,
    sessionMode?: 'shared' | 'per-thread',
  }
}
```

実装:`kind: 'system'`、`action: 'register_agent_group'` を持つ `messages_out` 行を書く。Host が読み、admin permission を検証し、central DB にエンティティ行を作成し、`system` messages_in レスポンスを書く。

### メディア処理

#### Inbound (messages_in → エージェントプロンプト)

Agent-runner は chat/chat-sdk メッセージ内の添付を検査し、タイプと provider 能力に基づいて扱う:

**Provider ネイティブのコンテンツブロック:**

| タイプ | Claude | Codex / OpenCode |
|------|--------|------------------|
| 画像(JPEG、PNG、GIF、WebP) | ネイティブ画像コンテンツブロック | ディスクに保存 |
| PDF | ネイティブドキュメントコンテンツブロック | ディスクに保存 |
| 音声 | ネイティブ音声コンテンツブロック | ディスクに保存 |
| その他のファイル(コード、データ、動画、アーカイブ) | ディスクに保存 | ディスクに保存 |

**「ディスクに保存」** の意味:`/workspace/downloads/{messageId}/` にダウンロードし、プロンプトテキスト内で参照する:

```
<message sender="John" time="10:00">
  Check this spreadsheet
  [file available at: /workspace/downloads/msg-123/data.xlsx]
</message>
```

エージェントはツール(Read、Bash)を使って保存ファイルにアクセスできる。

直接ダウンロードができない channel(例:WhatsApp バッファストリーム)では、channel adapter がローカル URL 経由でメディアを提供する。Agent-runner はその URL からダウンロードする。

**コンテンツブロック構築(Claude):** Agent-runner は複数パートの `MessageParam` コンテンツを構築する:`[{ type: 'image', source: { type: 'base64', media_type, data } }, { type: 'text', text: '...' }]`。Provider に渡されるプロンプトはこの場合プレーン文字列ではない — `QueryInput.prompt` フィールドが Claude のため構造化コンテンツをサポートする必要がある。Provider の `query()` メソッドがフォーマット固有の構築を扱う。

**コンテンツブロック構築(Codex/OpenCode):** すべてテキスト。ファイル参照はプロンプト文字列にインライン化される。Provider はプレーン文字列プロンプトを受け取る。

#### Outbound (エージェント → messages_out)

`send_file` MCP ツール経由で扱う(上記参照)。エージェントが明示的にファイルを送ると判断する — agent-runner は出力をファイル参照のためにスキャンしない。

### エージェント前スクリプト (Task)

content に `script` フィールドを持つ `task` kind メッセージの場合:

1. Agent-runner がスクリプトを一時ファイルに書く
2. `bash` で実行(30s タイムアウト)
3. stdout の最後の行を JSON としてパース:`{ wakeAgent: boolean, data?: unknown }`
4. `wakeAgent === false` なら:メッセージを完了マーク、provider を呼ばない
5. `wakeAgent === true` なら:スクリプト出力でプロンプトを enrich し、provider を呼ぶ

### トランスクリプトアーカイブ

Agent-runner はコンテキスト compaction の前に会話トランスクリプトをアーカイブする。Claude では PreCompact hook 経由で扱う(provider 内部)。Hook を持たない他の provider では、agent-runner は各クエリ完了後に provider の出力に基づいてアーカイブする。

アーカイブ場所:`/workspace/agent/conversations/{date}-{summary}.md`

### セッション再開

Agent-runner はクエリ間で `sessionId` と `resumeAt` を追跡する:

- `sessionId` — `ProviderEvent { type: 'init' }` からキャプチャ。次のクエリで `QueryInput.sessionId` に戻して渡す。
- `resumeAt` — Claude 固有(最後の assistant メッセージ UUID)。Agent-runner が保存し、`QueryInput.resumeAt` に渡す。サポートしない provider は無視する。

これらはコンテナのライフタイムにエフェメラル。コンテナが kill されて再起動するとき、host が central DB の sessions テーブルから保存された `sessionId` を渡す。`resumeAt` はコンテナ再起動で失われる(provider はセッションの末尾から再開する)。

### コンテナ起動

Agent-runner は次の経由で設定を受け取る:

- **環境変数:** `AGENT_PROVIDER`(claude/codex/opencode)、`NANOCLAW_ADMIN_USER_ID`、provider 固有の var(API キー、モデル上書き)、`TZ`
- **固定マウントパス:** セッション DB は `/workspace/session.db`。Agent group フォルダは `/workspace/agent/`。System prompt は `/workspace/agent/CLAUDE.md` と `/workspace/global/CLAUDE.md` から。
- **オプションの起動 config:** 一部の設定は固定パス(例:`/workspace/config.json`)の JSON ファイルとして渡されうる — 再開するセッション ID、アシスタント名、admin user ID 等用。これは環境変数の過負荷を避ける。

Agent-runner が config を読み、provider を作り、ポーリングループに入る。stdin なし、初期プロンプトなし — メッセージは既にセッション DB にある。

### Provider ファクトリ

```typescript
type ProviderName = 'claude' | string;

function createProvider(name: ProviderName, config: ProviderConfig): AgentProvider {
  // Trunk は 'claude' を登録する;追加 provider は skill 経由でインストールされたとき self-register する。
  const factory = providerRegistry.get(name);
  if (!factory) throw new Error(`Unknown provider: ${name}`);
  return factory(config);
}
```

Provider 名はコンテナの環境(`AGENT_PROVIDER` env var)から来る。Host が `agent_groups.agent_provider` または `sessions.agent_provider` に基づいて設定する。

`ProviderConfig` は provider 固有の設定(API キー、モデル上書き 等)を環境変数経由で持つ — インターフェース経由ではない。各 provider が必要なものを `env` から読む。

## Agent-Runner の性質

- MCP server は provider が `mcpServers` config 経由で spawn する別 Node プロセス
- MCP server バイナリは provider 間で共有 — 同じツール、同じ DB アクセス
- CLAUDE.md ロード(global + group ごと) — agent-runner が読み `systemPrompt` として渡す
- 追加ディレクトリ発見(`/workspace/extra/*`)
- stderr 経由のロギング(`[agent-runner] ...`)

## 関連ドキュメント

- **[architecture.md](architecture.md)** — 高レベルアーキテクチャ(セッション DB スキーマ、central DB、channel adapter、メッセージフロー)
- **[api-details.md](api-details.md)** — Channel adapter インターフェース、メッセージコンテンツ例、host 配信ロジック
