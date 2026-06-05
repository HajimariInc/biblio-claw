# NanoClaw アーキテクチャ (Draft)

## 中核アイデア

各 agent セッションはマウントされた SQLite DB を持つ。DB が host とコンテナの間の唯一の IO 機構である。IPC ファイル無し、stdin パイプ無し。2 つのテーブル:messages_in(host → agent-runner)と messages_out(agent-runner → host)。すべてはメッセージである。

## 2 レベル DB

**Central DB(host プロセス):**
- Agent groups、会話、ルーティングテーブル
- プラットフォーム ID → agent groups → セッションをマップ
- Channel adapter は直接触らない — host がルックアップする

**セッションごとの DB(コンテナにマウント):**
- messages_in(host が書き、agent-runner が読む)
- messages_out(agent-runner が書き、host が読む)
- すべてはメッセージ:chat、tasks、webhook、システムアクション、agent-to-agent — すべてこの 2 テーブルを使う
- セッションごとに 1 つの DB、agent group ごとではない

## Agent groups vs セッション

Agent group は独自のファイルシステムを持つ — フォルダ、CLAUDE.md、skill、コンテナ設定。複数セッションが同じ agent group を共有できる(同じファイルシステム、同じ skill)が、各セッションは既知のパスに自身の DB をマウントされて持つ。各セッション = 同じ agent group のファイルシステムを持つが異なるセッション DB を持つ別コンテナ。

## メッセージフロー

```
プラットフォームイベント
  → Channel adapter (トリガーチェック、ID 抽出)
  → 返す: { platformChannelId, platformThreadId, triggered }
  → Host が platformChannelId + platformThreadId → agent group + session をマップ
  → Host がセッション DB にメッセージを書く
  → Host が wakeUpAgent(session) を呼ぶ
  → コンテナが立ち上がる (またはすでに走っている)
  → Agent-runner が自身のセッション DB を poll、新メッセージを見つける
  → Agent-runner が Claude で処理
  → Agent-runner がセッション DB にレスポンスを書く
  → Host がアクティブセッション DB をレスポンスのため poll
  → Host がレスポンスを読み、会話をルックアップ、channel adapter 経由で配信
```

## Channel Adapter

Channel adapter は次に責任を持つ:
1. プラットフォームイベントを受信(webhook、polling、websocket — プラットフォーム固有)
2. **フィルタリング**: 処理のため host にどのメッセージを forward するかを決定する。これはステートレス(regex トリガーマッチ)またはステートフル(例:「ある時点で bot がこのスレッドで @mention されたか? その場合、以降の全メッセージを forward」)。Adapter はフィルタされていないプラットフォームメッセージのストリームを受け、どれを通すか決める。どう決めるかは実装詳細 — NanoClaw は知らないし気にしない。
3. 2 つの ID を抽出・標準化:
   - **プラットフォーム channel ID** — 会話を識別する(WhatsApp group、Slack channel、email thread)
   - **プラットフォーム thread ID** — オプションのサブコンテキスト(Slack thread、GitHub PR コメント thread)
4. Outbound 配信 — レスポンスをプラットフォームに送り返す

Channel adapter は agent group ID やセッション ID を知らない。プラットフォームレベルの identifier を返す。Host がそれをエンティティモデルにマップする。

2 レベルの ID スキーム(channel ID + thread ID)は柔軟性を与える:
- 各 Slack thread を別セッションにしたい? ユニークな thread ID を返す。
- Slack channel の全メッセージにセッションを共有させたい? 同じ thread ID(または null)を返す。
- これは channel ごとに設定、グローバルではない。

### Channel Adapter 設定

Adapter はステートレス — DB から直接ではなく、セットアップ時に host から設定を受ける。

**コードに住むもの(channel タイプごと、ランタイムで変わらない):**
- 自動登録挙動(有効 / 無効、動作方法)
- 送信者 allowlist ルール
- Allowlist された送信者が group を自動登録できるか
- プラットフォーム固有の接続とメッセージ処理

これらは channel adapter をセットアップするとき行う判断。変更 = コード変更。

**DB に住むもの(group ごと、group 間で変わる):**
- どの agent group が扱うか
- トリガー / フィルタルール(regex、@mention のみ、特定送信者除外 等)
- レスポンススコープ(全メッセージに応答 vs トリガー / allowlist のみ)
- セッションモード(shared vs per-thread)

Host が DB から group ごとの設定を読み、セットアップ時に adapter に渡す。ランタイムで設定が変わったら(admin agent が新 group を登録、トリガーを変更)、host が adapter の update メソッドを呼ぶ。

### 自動登録

Adapter が未知 group からのメッセージを forward するとき、host はその group とセッションを作るか決める必要がある。

**Adapter が未知メッセージを forward するか制御する** — コードレベルの自動登録ルール(送信者 allowlist、group-add 検知 等)に基づく。Adapter が forward すれば、host が group + session を作る。

**既知 group 用のセッション作成:**
- Shared セッションモード:host が既存セッションを見つけるか、最初のメッセージなら作る
- Per-thread セッションモード:host が threadId でルックアップ。このスレッド用セッションが無ければ、同じ agent group で自動作成

**コードレベルのルールは channel 固有:**
- WhatsApp:allowlist の番号が bot を group に追加 → 自動登録。未知の番号が DM → adapter の設定による。
- Email:送信者が既知 → スレッドを自動登録。未知 → drop。
- Slack:誰かが新 channel で bot を @mention → adapter がルールに基づいて forward するか決める。

`channel_configs` テーブル無し — channel タイプレベルの挙動は adapter コードに焼き込まれる。

### Chat SDK 統合

Chat SDK adapter は channel ごとにラップされる:
- 各 Chat SDK adapter は独自の Chat インスタンスを持つ
- 並行モードは channel ごとに設定(chat には concurrent、tasks には queue、webhook には debounce)
- ブリッジが Chat インスタンス + adapter をラップして NanoClaw の標準 channel インターフェースに準拠させる
- Chat SDK が扱う:webhook パース、dedup、メッセージ履歴、プラットフォーム API 呼び出し、リッチコンテンツ配信
- NanoClaw が扱う:ルーティング、agent ライフサイクル、セッション管理

**Chat SDK のサブスクリプションモデル:**

Chat SDK は独自のスレッドレベルサブスクリプション概念を持つ(NanoClaw の channel レベル登録と区別される):
- `onNewMention` / `onNewMessage(regex)` — 最初の接触時に発火(例:Slack thread での @mention)
- `thread.subscribe()` — その thread の今後のメッセージすべてに opt-in
- `onSubscribedMessage` — subscribe された thread の全メッセージで発火

これはサブ channel 粒度。NanoClaw は channel レベルで登録する(「この Discord channel を listen」)。Chat SDK は thread レベルで subscribe する(「この特定の Slack thread を追跡」)。ブリッジは Chat SDK が内部で自身の subscription を管理させる — NanoClaw はこれを干渉も複製もしない。

**プラットフォーム機能差:**

機能は adapter 間で大きく異なる([Chat SDK adapter ドキュメント](https://chat-sdk.dev/docs/adapters) 参照):
- **Slack**: フルリッチコンテンツ(Block Kit カード、modal、ストリーミング、リアクション、ephemeral メッセージ)
- **Discord**: Embed、ボタン、post+edit によるストリーミング
- **WhatsApp (Cloud API)**: DM のみ、対話的返信ボタン、ストリーミング無し、リアクション無し
- **GitHub/Linear**: Markdown コメント、対話的要素無し
- **Telegram**: インラインキーボードボタン、post+edit によるストリーミング

Host / ブリッジが gracefully に degradation を扱う — エージェントがカードをサポートしないプラットフォームにカードを post すると、テキストにフォールバックする。

非 Chat-SDK channel(Baileys 経由の WhatsApp、Gmail、カスタム統合)は NanoClaw channel インターフェースを直接実装する — ブリッジ無し、Chat SDK 型無し。

## コンテナライフサイクル

Host はオーケストレータ:
1. **Spawn** — wakeUpAgent が呼ばれてセッション用コンテナが無いとき
2. **Idle kill** — コンテナがある期間未処理メッセージを持たないとき
3. **Limits** — MAX_CONCURRENT_CONTAINERS がアクティブコンテナを cap する

コンテナが立ち上がると、agent-runner はすぐに自身のセッション DB を polling し始める。メッセージは既にそこで待っている。

## メディア処理

### Inbound

メディアは host がダウンロードしない。代わりに:
- メッセージはダウンロード URL を含む(可能なら signed URL)
- Agent-runner がコンテナ内でメディアをダウンロード・処理
- Signed URL が動かない channel(例:バッファストリームの WhatsApp)では、channel adapter がメディアをダウンロードして、コンテナがアクセスできるローカル URL / server 経由で提供

**ネイティブコンテンツブロック(provider 依存):**

Agent-runner はファイルタイプを検知し、provider がサポートしていればサポートタイプをネイティブコンテンツブロックとして渡す:

| タイプ | Claude | Codex | OpenCode |
|------|--------|-------|----------|
| 画像(JPEG、PNG、GIF、WebP) | ネイティブ画像コンテンツブロック | ディスク保存、プロンプトで参照 | ディスク保存、プロンプトで参照 |
| PDF | ネイティブドキュメントコンテンツブロック | ディスク保存 | ディスク保存 |
| 音声 | ネイティブ音声コンテンツブロック | ディスク保存 | ディスク保存 |
| その他のファイル(コード、データ、動画、アーカイブ) | ディスク保存 | ディスク保存 | ディスク保存 |

「ディスク保存」 = `/workspace/downloads/{messageId}/` にダウンロードし、利用可能なファイルパスとしてプロンプトテキストで参照される。エージェントはツール(Read、Bash)を使ってアクセスできる。

Agent-runner は provider ごとにプロンプトを違う方法で構築する。Claude では、image/document ブロック付きの複数パート `MessageParam` コンテンツを構築する。Codex/OpenCode では、すべてファイルパス参照付きのテキスト。

### Outbound

Outbound ファイル配信はツールベース。エージェントがファイルパス付きでツール(例:`send_file`)を呼ぶ。Agent-runner がファイルを outbox に移し、messages_out 行を書く。

```
/workspace/
  outbox/
    {message_id}/        ← messages_out 行ごとに 1 ディレクトリ
      chart.png
      report.pdf
```

messages_out のコンテンツはファイル名のみ参照する:

```json
{ "text": "Here's the chart", "files": ["chart.png", "report.pdf"] }
```

DB にはパス無し — 慣習が契約。Host はマウントされたセッションフォルダの `outbox/{message_id}/` からファイルを読み、adapter 経由で配信する(Chat SDK の `FileUpload` にバッファデータ、またはネイティブ channel 用のプラットフォーム固有アップロード)。Host は配信成功後に outbox ディレクトリをクリーンアップする。

Outbound ファイルは専用の `send_file` MCP ツールを使う(`send_message` とは別)。ツールインターフェースは [agent-runner-details.md](agent-runner-details.md) を参照。

### メッセージ重複排除

Dedup は channel adapter の責任。Chat SDK は内部で扱う。ネイティブ adapter は必要に応じてプラットフォームメッセージ ID を追跡する。Host は重複排除しない — adapter が forward すれば host は書く。

## セッション DB スキーマ

2 テーブル。Content には JSON blob — スキーマフリー、フォーマットは `kind` による。

```sql
-- Host が書き、agent-runner が読む
CREATE TABLE messages_in (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,      -- 'chat' | 'chat-sdk' | 'task' | 'webhook' | 'system'
  timestamp      TEXT NOT NULL,
  status         TEXT DEFAULT 'pending',  -- 'pending' | 'processing' | 'completed' | 'failed'
  status_changed TEXT,               -- 最後の status 変更の ISO タイムスタンプ
  process_after  TEXT,               -- ISO タイムスタンプ。NULL = 即時処理。
  recurrence     TEXT,               -- cron 表現。NULL = one-shot。
  tries          INTEGER DEFAULT 0,  -- 処理試行回数

  -- ルーティング (agent-runner が messages_out にコピー;エージェントは決して見ない)
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,

  -- ペイロード (構造は kind に依存)
  content        TEXT NOT NULL        -- JSON blob
);

-- Agent-runner が書き、host が読む
CREATE TABLE messages_out (
  id             TEXT PRIMARY KEY,
  in_reply_to    TEXT,               -- messages_in.id を参照(オプション)
  timestamp      TEXT NOT NULL,
  delivered      INTEGER DEFAULT 0,
  deliver_after  TEXT,               -- ISO タイムスタンプ。NULL = 即時配信。
  recurrence     TEXT,               -- cron 表現。NULL = one-shot。

  -- ルーティング (デフォルト: agent-runner が messages_in からコピー)
  kind           TEXT NOT NULL,      -- 'chat' | 'chat-sdk' | 'task' | 'webhook' | 'system'
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,

  -- ペイロード (フォーマットは kind に合う)
  content        TEXT NOT NULL        -- JSON blob
);

```

### スケジューリング

ワンショットと再帰タスクは同じテーブルを使う — 別の scheduler 無し。

**ワンショット:** `process_after`(inbound)または `deliver_after`(outbound)を `recurrence = NULL` 付きで。

**再帰:** 同じ、加えて `recurrence` cron 表現。Host が行を handled / delivered とマークした後、`recurrence` が設定されていれば、次の cron 発生時に `process_after` / `deliver_after` を進めた新しい行を insert する。次の時刻はスケジュール時刻から計算される(wall clock ではない)— ドリフトを防ぐため。

**Host sweep**(全セッション DB に対して 60s ごと):
- `messages_in WHERE status = 'pending' AND (process_after IS NULL OR process_after <= now())` → エージェントを起こす
- `messages_in WHERE status = 'processing' AND status_changed < (now - stale_threshold)` → stale 検知、tries インクリメント、バックオフ付きで pending にリセット
- `messages_out WHERE delivered = 0 AND (deliver_after IS NULL OR deliver_after <= now())` → 配信
- `recurrence` 付きの行を完了 / 配信した後、次の発生を insert

**アクティブコンテナ poll**(~1s)は同じ条件をチェックするが、走っているコンテナを持つセッションのみ。

**Agent-runner は schedule を作る** — messages_in(自身に)または messages_out(リマインダー / 通知)を `process_after` とオプションで `recurrence` 付きで書くことで。

### kind ごとの messages_in コンテンツ

**`chat`** — シンプルな NanoClaw フォーマット。任意の channel が生成できる。
```json
{
  "sender": "John",
  "senderId": "user123",
  "text": "Check this PR",
  "attachments": [{ "type": "image", "url": "https://signed-url..." }],
  "isFromMe": false
}
```

**`chat-sdk`** — フル Chat SDK `SerializedMessage`、ブリッジ adapter から passthrough。`author`、`text`、`formatted`(mdast AST)、`attachments`、`isMention`、`links`、`metadata` を含む。

**`task`** — スケジュール済タスクが発火。
```json
{ "prompt": "Review open PRs", "script": "scripts/review.sh" }
```

**`webhook`** — 生の webhook ペイロード。
```json
{ "source": "github", "event": "pull_request", "payload": { ... } }
```

**`system`** — host アクション結果(エージェントが要求したシステムアクションへのレスポンス)。
```json
{ "action": "register_group", "status": "success", "result": { "agent_group_id": "ag-456" } }
```

### kind ごとの messages_out コンテンツ

出力 `kind` がフォーマットと配信 adapter を決める。デフォルト:agent-runner が応答する messages_in 行から `kind` とルーティングフィールドをコピー。

**`chat`** — シンプルな NanoClaw フォーマット。NanoClaw channel が `sendMessage(text)` で配信。
```json
{ "text": "LGTM, merging now" }
```

**`chat-sdk`** — Chat SDK `AdapterPostableMessage`。ブリッジ adapter が `thread.post()` で配信。markdown、カード、または raw — adapter がプラットフォーム変換を扱う。
```json
{ "markdown": "## Review\n**LGTM**", "attachments": [...] }
```
```json
{ "card": { "type": "card", "title": "Review", "children": [...] }, "fallbackText": "..." }
```

**`task`** — タスク結果。Host がログ、オプションで通知。
```json
{ "result": "3 PRs reviewed", "status": "success" }
```

**`webhook`** — webhook レスポンス。Host が HTTP レスポンスを送る、または通知。
```json
{ "response": { "status": 200, "body": { ... } } }
```

**`system`** — host アクションリクエスト(group 登録、セッションリセット 等)。Host が読み、権限を検証し、実行し、結果を `system` messages_in 行として書き戻す。
```json
{ "action": "reset_session", "payload": { "session_id": "sess-123" } }
```

### 対話的操作(カード、リアクション、編集)

すべての対話的操作は messages_in/out を通る — DB がコンテナの唯一の IO 境界。エージェントは MCP ツールを使い、agent-runner がツール呼び出しを構造化された messages_out 行に翻訳し、host が適切な adapter メソッドで配信する。

**ユーザ対話付きカード(例:「Ask User Question」):**

1. エージェントが `ask_user_question` ツールを質問 + オプション付きで呼ぶ
2. Agent-runner が質問カード付きの messages_out を書く
3. Host が adapter 経由で対話的カードとして配信(例:Slack Block Kit ボタン)
4. ユーザがオプションをクリック
5. プラットフォームがイベントを adapter に送り返す → host がレスポンス付きの messages_in を書く
6. Agent-runner が messages_in を読み、保留中ツール呼び出しにマッチし、選択をツール結果としてエージェントに返す

Agent-runner は messages_in でのユーザレスポンスを待つ間、ツール呼び出しを開いて保持する。Round-trip は:エージェント → messages_out → host → プラットフォーム → ユーザクリック → プラットフォーム → host → messages_in → agent-runner → エージェント。

**承認:**

2 つのパターン、両方とも host レベルで扱う:
- **暗黙的**: エージェントが承認が必要なツールを呼ぶ。Host がインターセプトし、admin に承認カードを送り、レスポンスを待ち、実行または拒否する。エージェントは承認ステップを知らない。
- **明示的**: エージェントが明示的にツール経由で承認を要求する。Agent-runner が承認リクエストを messages_out に書く。「ask user question」と同じフロー — レスポンスは messages_in 経由で戻る。

両ケースとも、承認とアクション実行は host 側で起こる、エージェント側ではない。

**承認ルーティング:** Privilege はユーザレベルの概念。`user_roles` は `owner`(グローバルのみ — 最初にペアリングしたユーザが owner になる)と `admin`(グローバル、または特定 `agent_group_id` にスコープ)を記録する。アクションが承認を要するとき、`pickApprover(agentGroupId)` は候補を順に返す:その agent group の scoped admin → グローバル admin → owner(重複排除)。`pickApprovalDelivery` が次に `ensureUserDm` 経由で最初の到達可能候補を取る(same-channel-kind タイブレーク付き、なので Discord 承認リクエストは Discord 使用 approver を優先する)。承認カードは approver の DM messaging group に届く、起点 chat ではない。配信は解決必要 channel(Discord/Slack/…)では Chat SDK の `openDM` 経由、または直接アドレス可能 channel(Telegram/WhatsApp/…)ではユーザのハンドル直接で解決され、マッピングは `user_dms` にキャッシュされる(以降のリクエスト用)。`src/access.ts`、`src/user-dm.ts` を参照。

**送信済メッセージの編集:**

エージェントが `edit_message` ツールをメッセージ ID と新コンテンツ付きで呼ぶ。Agent-runner が edit 操作付きの messages_out を書く。Host が `adapter.editMessage()` を呼ぶ。エージェントのコンテキスト内のメッセージは整数 ID を含むので、エージェントはそれらを参照できる。

**リアクション:**

エージェントが `add_reaction` ツールをメッセージ ID と絵文字付きで呼ぶ。Agent-runner が reaction 操作付きの messages_out を書く。Host が `adapter.addReaction()` を呼ぶ。

**messages_out コンテンツ内の操作:**

```json
// 通常のメッセージ (デフォルト)
{ "text": "LGTM" }

// 対話的カード
{ "operation": "ask_question", "title": "Deploy", "question": "Approve deployment?", "options": ["Yes", "No", "Defer"] }

// 既存メッセージを編集
{ "operation": "edit", "messageId": "3", "text": "Updated: LGTM with minor comments" }

// リアクション
{ "operation": "reaction", "messageId": "5", "emoji": "thumbs_up" }
```

Host は `operation` フィールド(あれば)を読み、適切な adapter メソッドを呼ぶ。Operation フィールド無し = 通常のメッセージ配信。プラットフォーム機能は異なる — host / ブリッジが gracefully に degradation を扱う(例:リアクションをサポートしないプラットフォームでのリアクション → skip またはテキストとして送る)。

### Agent-to-Agent コミュニケーション

別のエージェントへのメッセージ送信は、channel 配信と同じルーティングフィールドを使う。Agent-runner が `channel_type: 'agent'` と `platform_id` をターゲット agent group ID に設定する。オプションで `thread_id` は特定セッションをターゲットにできる(null = デフォルトセッションを見つけるか作る)。

送信エージェント視点から見ると、Slack や WhatsApp に送るのと同じ仕組み — 異なるルーティングを持つ messages_out 行を書くだけ。Host が読み、この agent group がターゲットにメッセージできる権限があるか確認し、ターゲットセッションを解決し、そのセッションの DB に messages_in 行を書く。

```json
// messages_out ルーティングフィールド
{ "kind": "chat", "channel_type": "agent", "platform_id": "pr-worker", "thread_id": null }
// messages_out コンテンツ
{ "text": "Reset your session and re-review", "sender": "Supervisor", "senderId": "agent:pr-admin" }
```

受信エージェントは通常の chat メッセージを得る。ソースが別エージェントだと知る必要はない(関連コンテキストとしてでなければ)。

### ルーティング

**デフォルト挙動:** Agent-runner がルーティングフィールド(`kind`、`platform_id`、`channel_type`、`thread_id`)を messages_in 行から messages_out にコピーする。レスポンスは来た所に戻る。

**Host 検証:** 配信前、host はこの agent group が destination に送る権限があるかチェック。Agent-runner がルーティングをコピーし、host が検証する。

**マルチデスティネーションパターン(カスタマイズ):** エージェントは起点と異なる channel に送る必要があるかも(例:webhook が Slack 通知をトリガー)。これはカスタムコード経由でサポート、コアに組み込まない:

1. セッション DB に論理名をルーティングフィールドにマップする `destinations` テーブルを追加
2. セッションセットアップ時に host から populate
3. 利用可能 destination を list するようエージェントのプロンプトを修正
4. エージェントが名前で destination を選ぶ;agent-runner がルーティングフィールドに解決
5. Host は通常通り検証

これはパターンとしてドキュメント化される、組み込み機能ではない。

## コア性質
- ファイルシステムマウントによるコンテナ分離
- クレデンシャル proxy(OneCLI)
- Agent group ごとの workspace(フォルダ、CLAUDE.md、skill)
- ポーリングベース(イベント駆動ではない)
- コンテナ起動時の agent group ごとの agent-runner 再コンパイル(エージェントは自身のソースを修正でき、再ビルド / 再起動を要求でき、変更は teardown を跨いで永続)
- Host ↔ コンテナ IO は マウント済セッション DB(`messages_in` / `messages_out`)経由 — stdin パイプ無し、IPC ファイル無し
- エージェントコマンドは `kind: 'system'` 付きの `messages_out` 行
- Agent-to-agent は `messages_out` のターゲットエージェントルーティング経由でサポート
- スケジューリングは同じメッセージテーブルの `process_after` / `deliver_after` + `recurrence` を使う
- メディアは signed URL 経由、コンテナでダウンロード
- Channel adapter は Chat SDK ブリッジ + 標準インターフェースを使う(trunk はブリッジ / レジストリのみ;プラットフォーム adapter は `/add-<channel>` skill 経由でインストール)
- ルーティング:channel adapter が ID を抽出、host がエンティティにマップ
- 並行性:Chat SDK の channel ごと + コンテナ制限
- セッションスコープ:セッションごとの DB、agent group ごとに複数セッション

## 設計判断

**セッション DB の場所:** Agent group フォルダではない。別ディレクトリ(例:`sessions/{session_id}/`)。各セッションは `session.db` と Claude SDK の `.claude/` ディレクトリを含む独自フォルダを持つ。セッション identity = フォルダ — Claude SDK セッション ID を追跡する必要なし。

**コンテナマウント構造:**

```
/workspace/                 ← マウント: セッションフォルダ (read-write)
  .claude/                  ← Claude SDK セッションデータ (自動作成)
  session.db                ← セッション SQLite DB
  outbox/                   ← agent-runner が outbound ファイルをここに書く
  agent/                    ← マウント: agent group フォルダ (nested, read-write)
    CLAUDE.md               ← エージェント命令
    skills/                 ← エージェント skill
    ... 作業ファイル
```

2 つのディレクトリマウント:セッションフォルダは `/workspace` に、agent group フォルダは `/workspace/agent/` に。Agent-runner は `/workspace/agent/` に CD してエージェントを実行する。Claude SDK は `.claude/` を `/workspace/.claude/`(workspace のルート)に書く。セッション DB は `/workspace/session.db` にある。

これは Docker(nested bind mount)と Apple Container(ディレクトリマウントのみ — ファイルレベルマウント無しだが、nested ディレクトリマウントはサポート)の両方で動く。

**セッション DB の並行アクセス:** Host が messages_in を書き、agent-runner が messages_out を書く。両方が同じ SQLite ファイルに同時にアクセスする。WAL モードがこれを扱う — SQLite は並行 reader を許し、2 つの側が異なるテーブルに書くので writer 競合は最小。Host がセッション DB を作るとき WAL モードを有効化する。

**セッション管理:** Host 管理。Host がセッションフォルダを作りマウントする。コンテナは自身のセッションフォルダのみ見る。

**セッション作成(レースコンディション無し):**

1. メッセージが届く、host が central DB でこの group + thread にマッチするセッションをチェック
2. セッション無し → host が atomic に central DB にセッション行を作り、セッションフォルダを作り、セッション DB を作り、メッセージを書く
3. コンテナ起動前にさらにメッセージが来る → host が既存セッションを見つけ、同じセッション DB に書く
4. コンテナが起動し、フォルダをマウント、agent-runner が待っているメッセージを見つける

Central DB セッション行作成がシリアライゼーションポイント。協調する Claude SDK セッション ID 無し — SDK はエージェントが走るとき `.claude/` 内に自身のセッションデータを発見する。

**システムアクション:** エージェントが MCP ツールを使う(group 登録、セッションリセット、タスクスケジュール 等)。Agent-runner がこれらのツール呼び出しを扱い、`kind: 'system'` 付きの構造化された決定的な messages_out 行を書く。これは自然言語ではない — host が決定的に処理するプログラマティックな構造化ペイロード。Host が権限を検証し、実行し、結果を `system` messages_in 行として書き戻す。

**コンテナライフサイクル:** ウォームプール無し。コンテナはオンデマンド(wakeUpAgent)で spawn され、idle 時に host が外から teardown する。既存の idle 検知 + teardown 仕組みが引き継がれる。

## 運用挙動

### 出力配信

NanoClaw はトークンをユーザにストリームしない。Claude Agent SDK の `query()` は完全な結果を yield する。Agent-runner は結果ごとに 1 つの完全なメッセージを messages_out に書く。Host が完全なメッセージを channel に配信する。

メッセージ編集は明示的操作として(エージェントが `edit_message` ツールを呼ぶ)サポートされる、ストリーミング機構としてではない。

タイピングインジケータ:host はセッションでコンテナがアクティブなときタイピングを設定、コンテナが exit するか messages_out にレスポンスが現れたら clear する。

### メッセージバッチング

コンテナがダウン中に複数メッセージが届くと、messages_in の `handled = 0` 行として累積する。コンテナがウェイクすると、agent-runner はすべての未処理メッセージをクエリし、バッチとして処理する — 複数メッセージは単一の `<messages>` XML ブロックにフォーマットされる。

### メッセージライフサイクル

```
pending → processing → completed
                    → failed (max リトライ後)
```

- **pending**: Host が書く。pickup 準備完了(`process_after` が null か過去なら)。
- **processing**: Agent-runner がメッセージを pickup したときに設定する。`status_changed` は now に設定。他の poll が同じメッセージを再 pickup するのを防ぐ。
- **completed**: 処理成功後に agent-runner が設定。
- **failed**: max リトライを使い切った後に設定。

**Stale 検知**: メッセージが `processing` だが `status_changed` が古すぎる(例:>10 分)場合、host はコンテナがクラッシュしたと仮定する。メッセージを `pending` にリセットし、`tries` をインクリメントし、`process_after` を exponential backoff で設定する。

### エラーハンドリングとリトライ

リトライは exponential backoff 付きの `process_after` を使う。各リトライは `tries` をインクリメントし、`process_after` をさらに進める:

- Try 1: 即時
- Try 2: +5s
- Try 3: +10s
- Try 4: +20s
- Try 5: +40s
- Max リトライ後: status は `failed` に設定

Host がこれを計算する — agent-runner ではない。Host が stale な `processing` メッセージを検知するか、コンテナがエラーで exit すると、`tries` をインクリメントし、次の `process_after` を計算し、status を `pending` にリセットする。

**Output-sent 保護**: バッチに対してすでに messages_out に delivered 行があれば、リトライしない(ユーザへの重複メッセージを防ぐ)。

### Host ポーリング

2 段:
- **アクティブコンテナ(~1s)**: 新 messages_out 行のためセッション DB を poll
- **全セッション(~60s)**: 全セッション DB を due な `process_after` / `deliver_after` タイムスタンプのため sweep、recurrence を扱う

## 柔軟性モデル

アーキテクチャは **コード変更に対して柔軟、すべてを設定可能にはしない**。高度なセットアップ(下記の PR Factory のような)はカスタムルーティングロジックと host 側 hook を使う — データベース設定カラムではない。

### Skill カスタマイズのためのコード構造

NanoClaw は skill 経由でカスタマイズされる — ユーザのインストールに merge されるブランチ。異なる skill が異なる機能を追加する(channel、統合、挙動)。コードは次のように構造化されるべき:

1. **異なるカスタマイズが衝突しない。** Slack と Telegram の追加は merge 衝突を生まないべき。新 MCP ツールの追加は channel の追加と衝突しないべき。各カスタマイズタイプは自身のファイルに触れるべき。

2. **コア機能ブロックは別ファイルにある。** Channel 登録、メッセージフォーマット、MCP ツール、ルーティングロジック、コンテナ管理 — 各々独自ファイルに。メッセージフォーマットを変える skill は、コンテナ spawning を扱うファイルに触れない。

3. **Index ファイルは薄い。** 物事を配線する(DB init、adapter 起動、poll ループ起動)が、ビジネスロジックは含まない。すべてのロジックは skill が独立して修正できる目的別モジュールに住む。

4. **過剰分割しない。** 単純な変更(例:新メッセージ kind の追加)は 5 ファイルを跨ぐ編集を要するべきではない。関連ロジックをまとめる。目標は各 skill がコア変更で 1-2 ファイルに触れること。

5. **switch 文より登録パターン。** Channel、MCP ツール、provider は登録 / プラグインパターンを使うべき。Skill は channel を追加するときファイルと登録呼び出しを追加する — すべての他 channel と並んで中央 switch 文を編集しない。

**実践例:** Skill 経由で新 channel を追加するには:
- 新ファイル 1 つ(channel adapter または Chat SDK 設定)
- Barrel ファイル(`channels/index.ts`)に self-registering モジュールを import する 1 行
- ルーティング、フォーマット、配信、コンテナコードへの変更ゼロ

### 衝突ホットスポットと解決策

33 の skill ブランチの分析は、これらのファイルが最も merge 衝突を引き起こすことを示す:

| ホットスポット | なぜ衝突するか | 解決策 |
|-----------|-----------------|-------------|
| `src/index.ts`(2000 LOC) | すべての skill がメインループ、import、init ロジックにパッチ | モジュールを配線する薄い index。ロジックは目的別ファイル(router、delivery、session-manager、host-sweep)に住む。 |
| `src/config.ts` | すべての skill が中央ファイルに env var を追加 | 設定は使われる場所で宣言。各モジュールが自身の env var を読む。すべての skill が編集する中央設定レジストリ無し。 |
| `src/container-runner.ts` | Channel skill がマウント、env var、クレデンシャルセットアップを追加 | 宣言的マウント登録。Channel が自身のファイルにマウントを宣言。Container runner がハードコードリストではなくレジストリから読む。 |
| `src/db.ts`(750 LOC) | スキーマ、マイグレーション、全 CRUD が 1 ファイル | エンティティで分割。番号付きマイグレーション。Skill がマイグレーションファイル + エンティティファイル 1 つを編集。 |
| `container/agent-runner/src/index.ts` | エージェントプロトコル、IPC ハンドリング、フォーマットが 1 ファイル | poll-loop、formatter、providers/、mcp-tools/ に分割。セッション DB が IPC を置換。 |
| `src/ipc.ts` | すべての MCP ツール追加が 1 ファイルにパッチ | barrel 付き `mcp-tools/` ディレクトリ。Skill がツールファイル + barrel 行を追加。 |
| `src/channels/index.ts` | すべての channel が同じ場所に import 行を追加 | Channel ごとにコメントスロット付きの barrel ファイル(現パターンが動く、保つ)。 |

**マウント登録パターン:** すべての channel skill が `buildVolumeMounts()` を編集する代わりに、channel はマウントを宣言し、container runner が集める:

```typescript
// channels/gmail.ts
registerChannel('gmail', {
  factory: createGmailAdapter,
  mounts: [
    { hostPath: '~/.gmail-mcp', containerPath: '/home/node/.gmail-mcp', readonly: false }
  ],
  env: ['GMAIL_OAUTH_TOKEN'],
});
```

Container runner は channel レジストリから登録済マウントを読む — `container-runner.ts` を編集する必要なし。

**Config パターン:** Skill は `config.ts` や `.env.example` にパッチしない。Skill 固有 env var は skill の SKILL.md にドキュメント化される — セットアッププロセスがその指示を読む。各モジュールが自身の env var を直接読む:

```typescript
// channels/discord.ts
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;

// channels/gmail.ts  
const GMAIL_CREDS = process.env.GMAIL_CREDENTIALS_PATH;
```

共有 config(DATA_DIR、TIMEZONE、MAX_CONCURRENT_CONTAINERS)は `config.ts` に残る。Channel/skill 固有 config は使うモジュールに残る。

### コードスタイル

**行幅:120 文字。** ほとんどのステートメントが可読性を犠牲にせず 1 行に収まる。

**簡潔なロギング。** 薄いラッパーがすべてのログ呼び出しを 1 行に保つ:

```typescript
log.info('IPC message sent', { chatJid, sourceGroup });
log.warn('Unauthorized IPC attempt', { chatJid });
log.error('Error processing', { file, err });
```

### DB ファイル構造

DB レイヤは、1 つのモノリシックファイルに保つのではなく、エンティティで分割される:

```
src/db/
  connection.ts              ← シングルトン、init、WAL モード
  schema.ts                  ← CREATE TABLE ステートメント (現状、参考用)
  migrations/
    index.ts                 ← ランナー: バージョンをチェック、保留分を適用
    001-initial.ts           ← 初期スキーマ
    002-pending-questions.ts ← 例: pending_questions テーブルを追加
    ...                      ← skill が新しい番号付きファイルを追記
  agent-groups.ts            ← agent_groups の CRUD
  messaging-groups.ts        ← messaging_groups + messaging_group_agents の CRUD
  sessions.ts                ← sessions + pending_questions の CRUD
  index.ts                   ← barrel: すべて re-export
```

**原則:**
- **エンティティで分割、レイヤではない。** 各エンティティファイルが独自 CRUD 関数(~50-100 行)を持つ。Messaging_groups にカラムを追加する skill は `messaging-groups.ts` を編集 — sessions や agent groups に触れない。
- **スキーマは現状 + マイグレーションは履歴。** `schema.ts` は DB が今どう見えるかをドキュメント化(スキーマを理解するためにこれを読む)。マイグレーションはどう辿り着いたかを記述する追記専用の番号付きファイル。
- **インライン ALTER TABLE 無し。** `schema_version` テーブル付きのマイグレーションランナーが `try { ALTER TABLE } catch { /* exists */ }` ブロックを置換。起動時、現在バージョンをチェックし、保留マイグレーションを順に適用。各マイグレーションは関数:`(db: Database) => void`。
- **Skill はマイグレーションを追加。** 新カラムが必要な skill は新しい番号付きマイグレーションファイルを追加する。番号が衝突しなければ、他 skill のマイグレーションと衝突無し(skill ブランチ向けにタイムスタンプか十分大きい番号を使う)。

**Agent-runner セッション DB** は同じパターンを使うがより軽量 — セッション DB は host がフレッシュに作るのでマイグレーション不要:

```
container/agent-runner/src/db/
  connection.ts          ← 固定パスで session.db を開く、WAL モード
  messages-in.ts         ← pending を読む、status を更新
  messages-out.ts        ← 結果を書く、outbox クエリ
  index.ts               ← barrel
```

### ベースアーキテクチャがプリミティブにサポートすべきもの

これらは構築ブロック。特別な抽象を必要としない — セッションごとの DB、host 管理ルーティング、`kind: 'system'` 付き messages_out から自然に出る:

1. **同一 channel 上の複数 agent group とコンテンツベースルーティング。** 同じ thread 内の異なるメッセージが、コンテンツに基づき異なる agent group にルーティングできる(例:@mention は supervisor、通常メッセージは worker)。Channel adapter のルーティングロジック — カスタムコード — が決める。

2. **共有 agent group からのスレッドごとセッション。** 複数セッションが同じ agent group(ファイルシステム、skill、CLAUDE.md)を共有するが、各々が独自セッション DB を得る。ワーカープールの標準。

3. **セッションリセットとリプレイ。** 同じ thread に新セッションを作る。古いメッセージを未処理マークし、poll が再 pickup するように。古い出力はプラットフォーム(例:Discord thread)で比較のため可視のまま。これはエージェントが要求できるアクション — 自動ではない。

4. **クロスセッション読み取りアクセス。** 一部エージェントは他セッションのデータをクエリできる。異なるアクセスレベル:マネージャは messages_in/messages_out を見る(コンテンツレビュー)。Supervisor は完全な内部(エージェントログ、ツール呼び出し、デバッグトレース)を見る。これは単なるファイルシステム / DB アクセス — 正しいパスをマウントまたはクエリする。

5. **新セッションへのコンテキスト複製。** Supervisor が worker の thread で呼ばれるとき、関連メッセージがコピーされた新セッションが作られる。カスタム host 側コードが扱う。

6. **エージェント開始の host アクション。** エージェントが MCP ツール(セッションリセット、skill 更新 等)を使う。Agent-runner がツール呼び出しを扱い、構造化された `system` messages_out 行を書く。Host が読み、権限チェックで実行する。エージェントは要求できるが、host が決める。

### 例:PR Factory

3 つの agent group、1 つの Discord channel(PR Factory)、加えて admin channel:

| 役割 | Agent Group | どこ | セッションモデル |
|------|-------------|-------|---------------|
| **Worker** | pr-worker | PR Factory thread | thread ごとに 1 セッション(PR ごと) |
| **Manager** | pr-manager | PR Factory channel | 単一セッション、worker セッションを横断クエリ |
| **Supervisor** | pr-admin | Admin channel + PR Factory(@tag されたとき) | admin channel のメインセッション;worker thread で呼ばれたとき thread ごとセッション |

**Worker フロー:** GitHub PR → Discord thread → worker エージェントがレビュー(triage、review、test plan)。各 thread が共有 pr-worker group からセッションを得る。

**Feedback フロー:** ユーザが worker thread で supervisor を @tag → カスタムルーティングが thread のメッセージ(複製)を含む新セッションで supervisor に送る。Supervisor がフィードバックをファイルシステムに集める。Worker は supervisor メッセージを見ない。

**Iteration フロー:** ユーザが admin channel で supervisor とフィードバックを議論 → supervisor が skill 変更を提案(diff 付きリッチカードで表示) → ユーザが承認 → supervisor が host アクション経由で変更を適用 → supervisor がセッションリセット + リプレイを要求 → worker が同じ thread の同じ PR を更新済 skill で再レビュー、新セッションで → ユーザがレビューを並んで比較。

**Manager フロー:** ユーザが PR Factory メイン channel で manager と話す(thread ではない)。Manager は全 worker セッション DB(messages_in/messages_out)を横断検索し、「今日何 PR?」や「トレンドのトピックは?」のような質問に答えられる。アクションを要求できる(PR をクローズ、再オープン)。

**カスタムコード vs ベースアーキテクチャ:**

| 機能 | ベースアーキテクチャ | カスタムコード(PR Factory) |
|-----------|-------------------|-------------------------|
| Thread ごとセッション | ✓ platformThreadId → session | |
| セッション越しの共有 agent group | ✓ 複数セッション、1 group | |
| セッション DB へのメッセージ書き込み | ✓ 標準フロー | |
| @mention の異なるエージェントへのルーティング | | ✓ Channel adapter ルーティングロジック |
| Supervisor セッションへのコンテキスト複製 | | ✓ Supervisor 呼び出し時の host 側 hook |
| セッションリセット + リプレイ | ✓ プリミティブ(新セッション、未処理マーク) | ✓ Supervisor アクションがトリガー |
| Skill 更新 | ✓ ファイルシステム書き込み | ✓ Supervisor アクションが変更を適用 |
| クロスセッションクエリ | ✓ DB / ファイルシステムアクセス | ✓ Manager のツールがどこを見るか知る |
| リッチカード出力 | ✓ messages_out の構造化出力 | |

## Central DB スキーマ

Central DB はルーティングとエンティティ管理を扱う。すべてのコンテンツと実行状態はセッションごとの DB に住む。

```sql
-- Agent workspace: フォルダ、skill、CLAUDE.md、コンテナ設定
CREATE TABLE agent_groups (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  folder           TEXT NOT NULL UNIQUE,
  agent_provider   TEXT,              -- セッション用デフォルト (null = システムデフォルト)
  container_config TEXT,              -- JSON: { additionalMounts, timeout }
  created_at       TEXT NOT NULL
);

-- プラットフォーム groups/channels (WhatsApp group, Slack channel, Discord channel, email thread 等)
CREATE TABLE messaging_groups (
  id                     TEXT PRIMARY KEY,
  channel_type           TEXT NOT NULL,     -- 'whatsapp', 'slack', 'discord', 'telegram', 'email'
  platform_id            TEXT NOT NULL,     -- プラットフォーム固有 ID (JID, channel ID 等)
  name                   TEXT,
  is_group               INTEGER DEFAULT 0,
  unknown_sender_policy  TEXT NOT NULL DEFAULT 'strict',  -- 'strict' | 'request_approval' | 'public'
  created_at             TEXT NOT NULL,
  UNIQUE(channel_type, platform_id)
);

-- ユーザ (メッセージングプラットフォーム identity、"<channel_type>:<handle>" で名前空間化)
CREATE TABLE users (
  id           TEXT PRIMARY KEY,   -- 例 'telegram:123456', 'discord:1470...'
  kind         TEXT NOT NULL,      -- channel_type プレフィックスをミラー
  display_name TEXT,
  created_at   TEXT NOT NULL
);

-- ロール (owner はグローバルのみ;admin はグローバル または agent_group にスコープ)
CREATE TABLE user_roles (
  user_id         TEXT NOT NULL REFERENCES users(id),
  role            TEXT NOT NULL,   -- 'owner' | 'admin'
  agent_group_id  TEXT REFERENCES agent_groups(id),  -- グローバル用 NULL
  granted_by      TEXT,
  granted_at      TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
-- owner 行は agent_group_id = NULL でなければならない (db/user-roles.ts で強制)

-- メンバーシップ (明示的非特権アクセス;admin/owner はメンバーシップを暗黙的に持つ)
CREATE TABLE agent_group_members (
  user_id         TEXT NOT NULL REFERENCES users(id),
  agent_group_id  TEXT NOT NULL REFERENCES agent_groups(id),
  added_by        TEXT,
  added_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);

-- DM 解決キャッシュ (cold DM が毎回再解決されないように)
CREATE TABLE user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);

-- どの agent group がどの messaging group を、どんなルールで扱うか
CREATE TABLE messaging_group_agents (
  id                 TEXT PRIMARY KEY,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  trigger_rules      TEXT,              -- JSON: { pattern, mentionOnly, excludeSenders, includeSenders }
  response_scope     TEXT DEFAULT 'all',    -- 'all' | 'triggered' | 'allowlisted'
  session_mode       TEXT DEFAULT 'shared', -- 'shared' | 'per-thread'
  priority           INTEGER DEFAULT 0,     -- 高い = 複数エージェントがマッチするとき先にチェック
  created_at         TEXT NOT NULL,
  UNIQUE(messaging_group_id, agent_group_id)
);

-- セッション: 1 フォルダ = 1 セッション = 走っているとき 1 コンテナ
-- フォルダパスは派生: sessions/{agent_group_id}/{session_id}/
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  messaging_group_id TEXT REFERENCES messaging_groups(id),  -- 内部/spawn セッションで null
  thread_id          TEXT,              -- プラットフォーム thread ID (shared セッションモードで null)
  agent_provider     TEXT,              -- セッションごとに override (null = agent_group から継承)
  status             TEXT DEFAULT 'active',    -- 'active' | 'closed'
  container_status   TEXT DEFAULT 'stopped',   -- 'running' | 'idle' | 'stopped'
  last_active        TEXT,              -- 最終メッセージ活動タイムスタンプ
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX idx_sessions_lookup ON sessions(messaging_group_id, thread_id);

-- 保留中の対話的質問 (ユーザレスポンス待ちカード)
-- Host が質問カードを配信時に書き、レスポンス受信時に削除
CREATE TABLE pending_questions (
  question_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  message_out_id TEXT NOT NULL,     -- カードを送った messages_out 行
  platform_id    TEXT,              -- カードが配信された場所
  channel_type   TEXT,
  thread_id      TEXT,
  created_at     TEXT NOT NULL
);
```

### 保留質問フロー

Host が `operation: 'ask_question'` 付きの messages_out 行を配信するとき:
1. Host が channel adapter 経由でカードを配信
2. Host が `question_id` → `session_id` をマップする `pending_questions` 行を書く

Chat SDK `ActionEvent`(ボタンクリック)が届いたとき:
1. ブリッジがイベントから `actionId` を抽出
2. Host が `pending_questions` を `question_id` でルックアップ(actionId から派生 — ブリッジがマッピングを保持)
3. Host がターゲットセッションを見つけ、`questionId` + `selectedOption` 付きの messages_in 行を書く
4. Host が `pending_questions` 行を削除
5. Agent-runner が messages_in 行を pickup し、保留中ツール呼び出しにマッチし、選択を返す

これはセッション DB のスキャンを避ける。Central DB がルーティングルックアップ — メッセージルーティングと同じパターン。

Host が生成した承認カードにも使われる:host が admin の DM に承認リクエストを送るとき、`pending_questions` 行を書く。Admin のレスポンスは起点セッションに戻される。

### コンテナライフサイクル状態

```
stopped → running → idle → stopped
                  ↗
            idle → running (warm 中の新メッセージ)
```

- **stopped**: コンテナ無し。Due なスケジュール済メッセージのため 60s で sweep。
- **running**: 積極的に処理中。Messages_out のため 1s で poll。
- **idle**: 処理完了、コンテナはまだ warm(最大 30 分タイムアウト)。新メッセージがすぐ pickup されるよう 1s で poll。
- Idle タイムアウト後 → host がコンテナを kill → stopped。

## Agent-Runner アーキテクチャ

Agent-runner はコンテナ内のプロセス。セッション DB と Claude SDK の間を仲介する — 作業を poll、エージェント用にメッセージをフォーマット、ツール呼び出しを DB 行に翻訳、エージェントライフサイクルを管理。

### IO モデル

すべての IO はセッション DB を通る。Stdin 無し、stdout マーカー無し、IPC ファイル無し。

- 初期入力とフォローアップ:`messages_in` を poll
- 出力:`messages_out` 行を書く
- MCP ツール:DB 行を書く(IPC ファイル無し)
- シャットダウン:idle タイムアウトで host がコンテナを kill、または pending 作業が無いとき agent-runner が exit

### Poll ループ

1. `messages_in WHERE status = 'pending' AND (process_after IS NULL OR process_after <= now())` をクエリ
2. 行が見つかれば:各々に `status = 'processing'`、`status_changed = now()` を設定
3. メッセージを単一プロンプトにバッチ化(ルーティングフィールドを strip、kind でフォーマット)
4. Claude SDK の MessageStream にプッシュ
5. エージェント出力を処理 → `messages_out` 行を書く
6. 処理済メッセージを `status = 'completed'` に設定
7. step 1 に戻る。メッセージ無しなら短く sleep して再 poll(コンテナは idle タイムアウトまで warm)

### Kind ごとのメッセージフォーマット

Agent-runner はフォーマット前にルーティングフィールド(`platform_id`、`channel_type`、`thread_id`)を strip する。エージェントはルーティング情報を決して見ない — コンテンツのみ見る。

- **`chat`** — `<messages>` XML ブロックにフォーマット
- **`chat-sdk`** — シリアライズメッセージからテキスト、author、添付を抽出;`<messages>` XML にフォーマット
- **`task`** — `[SCHEDULED TASK]` プレフィックス + プロンプトとしてフォーマット。Pre-script があれば実行。
- **`webhook`** — `[WEBHOOK: source/event]` + JSON ペイロードとしてフォーマット
- **`system`** — host アクション結果(例:「register_group succeeded」)。Chat ではなく system context としてフォーマット。

混合バッチ(例:chat メッセージ + system 結果が両方 pending)は明確な区切りで 1 つのプロンプトに統合される。

### MCP ツール

MCP ツールはセッション DB に直接書く。

**コアツール:**

| ツール | 何をするか |
|------|-------------|
| `send_message` | `messages_out` 行、`kind: 'chat'` を書く |
| `send_file` | ファイルを `outbox/{msg_id}/` に移動、ファイル名付き `messages_out` を書く |
| `schedule_task` | `messages_in` 行(自身に)を `process_after` + `recurrence` 付きで書く。または outbound リマインダー用に `deliver_after` 付き `messages_out`。 |
| `list_tasks` | `messages_in WHERE recurrence IS NOT NULL` をクエリ |
| `pause_task` / `resume_task` / `cancel_task` | `messages_in` 行を修正(status を更新、recurrence をクリア / 設定) |
| `register_agent_group` | `messages_out`、`kind: 'system'`、`action: 'register_agent_group'` を書く |

**新ツール:**

| ツール | 何をするか |
|------|-------------|
| `ask_user_question` | 質問カード付きの `messages_out` を書く。ツール呼び出しを保持、`questionId` にマッチするレスポンスのため `messages_in` を poll。選択をツール結果として返す。 |
| `edit_message` | `operation: 'edit'` 付きの `messages_out` を書く |
| `add_reaction` | `operation: 'reaction'` 付きの `messages_out` を書く |
| `send_to_agent` | `channel_type: 'agent'`、`platform_id: '{target}'` 付きの `messages_out` を書く |
| `send_card` | カード構造付きの `messages_out` を書く |

全 MCP ツールパラメータ定義は [agent-runner-details.md](agent-runner-details.md) を参照。

### カード

**エージェント開始(outbound):** ツールベース。エージェントが `ask_user_question`(オプション付き対話的カード)または `send_card`(構造化カード)を呼ぶ。Agent-runner がカード構造を messages_out に書く。Host / adapter がプラットフォーム固有のレンダリング(Slack Block Kit、Discord embed、Telegram インラインキーボード、テキストフォールバック)を扱う。

**Host 開始(承認カード):** アクションが承認を要するとき、host が標準化された承認カードを生成し、admin の DM に送る。これらはエージェント開始ではない — エージェントは承認ステップを知らない。カードフォーマットは固定(アクション説明 + 承認 / 拒否ボタン)。

**Inbound(カードレスポンス):** カードではない — content に `questionId` + `selectedOption` を持つ messages_in 行。Agent-runner が保留中 `ask_user_question` ツール呼び出しにマッチし、選択をツール結果として返す。

### コマンド

`/` で始まるメッセージは 3 つのリストとチェックされる:

**Whitelisted コマンド(エージェントに pass-through):**
- エージェント provider がネイティブに扱う標準 slash コマンド(例:Claude の組み込みコマンド)
- raw で渡す、`<messages>` XML ラッピング無し

**Admin 専用コマンド(admin 送信者必須):**
- `/remote-control` — リモートコントロールセッション
- `/clear` — セッションコンテキストをクリア
- `/compact` — コンテキスト compaction を強制
- 非 admin ユーザが送ると、コマンドはエラーメッセージで拒否される。エージェントに forward されない。

**フィルタコマンド(完全に drop):**
- NanoClaw コンテキストで意味をなさない、または問題を起こすコマンド
- silent に drop — エラー無し、forward 無し

コマンドリストは agent-runner にハードコードされる。Admin 検証はメッセージがコンテナに到達する前に host 側で起こる:`src/command-gate.ts` が `user_roles`(owner / グローバル admin / この agent group のスコープ admin)をクエリし、メッセージを通すか drop するか別所にルーティングするかする。コンテナは admin identity の概念を持たない — env var 無し、DB クエリ無し、メッセージごとのチェック無し。

### 再帰タスク

Agent-runner は再帰タスクメッセージを他の messages_in 行と同じく処理する。Agent-runner が再帰メッセージを `completed` とマークした後、**host** が次の発生の insert を扱う(次の cron 時刻に `process_after` を進めた新 messages_in 行)。Agent-runner は recurrence を管理しない — 見つけたものを処理するだけ。

Pre-script:タスクメッセージに `script` フィールドがあれば、まず実行する。`wakeAgent = false` なら、Claude を呼ばずに completed とマーク。

### Agent-to-Agent メッセージング

**Outbound:** エージェントが `send_to_agent` ツールを呼ぶ → agent-runner が `channel_type: 'agent'`、`platform_id` = ターゲット agent group ID 付きの messages_out を書く。Host が権限を検証し、ターゲットセッションの messages_in に書く。

**Inbound:** 他エージェントからのメッセージは通常の `chat` messages_in 行として届く。Content は `sender` と `senderId` を含む(例:`"senderId": "agent:pr-admin"`)。特別なフォーマット無し — エージェントは chat メッセージとして見る。

### Agent-Runner の性質

- AgentProvider インターフェースが SDK 固有 query ロジックをラップ(trunk は `claude` provider を出荷;OpenCode のような追加 provider は `/add-<provider>` skill 経由でインストール)
- Provider 固有メカニズム経由のセッション再開
- CLAUDE.md ファイルからの system prompt ロード
- トランスクリプトアーカイブ用の PreCompact hook(Claude provider)
- task-kind メッセージ用のスクリプト実行

## 未解決の質問

- **承認ルーティング** — host はどう admin の DM 会話を見つけるか? DM channel が存在しない場合は? 承認リスト は agent group ごとに設定可能、それともグローバル?
- **MCP server ライフサイクル** — MCP server プロセスは同じコンテナ内の複数クエリ越しに永続化するか、毎回再起動するか?
- **コンテナ起動 config** — env var を超えて、起動時にコンテナに何の config(あれば)が渡されるか? セッション DB は固定マウントパス。System prompt は CLAUDE.md から。Provider 名は env から。他は?
- **Pending question 付き idle 検知** — `ask_user_question` がレスポンス待ちのとき、コンテナは idle と見なされるべきではない。また、エージェントがまだ作業中(アクティブなツール呼び出し、subagent)を検知し、最近 messages_out が書かれていなくてもコンテナを kill するのを避ける必要。

## 関連ドキュメント

- **[api-details.md](api-details.md)** — Channel adapter インターフェース(NanoClaw + Chat SDK ブリッジ)、メッセージコンテンツ例、host 配信ロジック
- **[agent-runner-details.md](agent-runner-details.md)** — AgentProvider インターフェース、MCP ツール、メッセージフォーマット、メディア処理、provider 実装
