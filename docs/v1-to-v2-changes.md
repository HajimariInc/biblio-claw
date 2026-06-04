# NanoClaw v1 → v2 — 何が変わったか

NanoClaw v1(これまで動かしてきた `~/nanoclaw` チェックアウト)と v2(この書き直し)の big-picture な差分。マイグレーションガイドではない — それは `bash migrate-v2.sh` と `/migrate-from-v1` skill の仕事である。本ドキュメントは **語彙**:何かが移動・改名された場合、ここで見つけられる。

マイグレーションコードを触る前、または fork のカスタマイズを移植する前に読むこと。

---

## 1 行サマリ

v1 は 1 つの Node プロセス + 1 つの SQLite ファイル + ネイティブな channel adapter だった。v2 は host がセッションごとに Docker コンテナを spawn し、状態を central DB + セッションごとの DB ペアに分割し、明示的なエンティティモデル経由でルーティングし、channel を sibling ブランチからの skill としてインストールする。

---

## エンティティモデル — 最大の変化

**v1:** 1 つのフラットテーブル `registered_groups(jid, name, folder, trigger_pattern, requires_trigger, is_main, channel_name)`。Group フォルダが agent identity の単位。chat(JID)はちょうど 1 つのフォルダに配線され、`trigger_pattern` はすべての受信メッセージに router が適用する不透明な regex。

**v2:** 真ん中に意図的な many-to-many を持つ 3 テーブル:

```
agent_groups  ─┐
               ├─ messaging_group_agents ─┬─ messaging_groups
               │   (engage_mode,          │   (channel_type,
               │    engage_pattern,       │    platform_id,
               │    sender_scope,         │    unknown_sender_policy)
               │    ignored_message_policy,
               │    session_mode, priority)
```

帰結:

- **1 つの agent が多くの chat で応答でき、1 つの chat が多くの agent に fan out できる。** v1 では両方できなかった。
- **`is_main` フラグなし。** 権限は `user_roles`(owner/admin、グローバル or スコープ付き)で明示する。下記参照。
- **`trigger_pattern` regex なし。** 4 つの直交カラムに置換。自動マイグレーションと `/migrate-from-v1` skill が使うマッピングルール:
  - v1 `trigger_pattern` が非空 → v2 `engage_mode='pattern'`、`engage_pattern = <regex>`
  - v1 `requires_trigger=0` またはパターンが `.` / `.*` → v2 `engage_mode='pattern'`、`engage_pattern='.'`(「常時」フレーバー)
  - パターン無しでトリガー要 → v2 `engage_mode='mention'`
  - `sender_scope` と `ignored_message_policy` は新規;デフォルト `all` / `drop`
- **JID 分解。** v1 の `jid` カラムは `dc:12345` / `tg:67890` を保存していた。v2 はこれを `channel_type` + `platform_id` に分割する。具体的には:`dc:12345` は `channel_type='discord'`、`platform_id='discord:12345'` になる。Prefix エイリアス(`dc` → `discord`、`tg` → `telegram`、`wa` → `whatsapp`)は `setup/migrate-v2/shared.ts` にある。
- **`channel_name` は v1 で信頼できなかった。** 多くの行で空、実際の channel は JID の prefix から推測しなければならなかった。v2 の `channel_type` は常に明示的である。

---

## Central DB vs セッション DB

**v1:** `store/messages.db` の 1 つの SQLite ファイル。すべての chat、メッセージ、登録 group、スケジュール済タスク、セッションがそこに住んでいた。Host と agent プロセスが皆同じファイルを開いた。

**v2:** 3 種類の DB 形。

1. `data/v2.db` — **central**。セッション専有でないすべて:users、roles、agent groups、messaging groups、wirings、pending approvals、user DMs、schema マイグレーション。
2. `data/v2-sessions/<session_id>/inbound.db` — **host が書き、コンテナが読む**。`messages_in`、ルーティング、destinations、pending questions、processing_ack。スケジュール済タスクがここに住む(下記「Scheduling」参照)。
3. `data/v2-sessions/<session_id>/outbound.db` — **コンテナが書き、host が読む**。`messages_out`、session_state。

各ファイルにつき writer は厳密に 1 つ。クロスマウントのロック競合なし。Heartbeat は `/workspace/.heartbeat` のファイルタッチで、DB 更新ではない。Host は偶数の `seq`、コンテナは奇数の `seq` を使う。

メッセージ履歴(v1 の `messages` テーブル、v1 の `chats` テーブル)は **マイグレートされない**。マイグレーションは運用上重要な状態(agent、channel、wiring、スケジュール済タスク、group フォルダ)を前送りし、chat ログは置き去りにする。

---

## スケジューリング

**v1:** `store/messages.db` 内の専用 `scheduled_tasks` テーブル(独自カラム:`schedule_type`、`schedule_value`、`next_run`、`last_run`、`context_mode`、`script`、`status`)。別の cron 系スケジューラプロセスがそこから読んでいた。

**v2:** スケジュール済タスクはセッションの `inbound.db` 内の **`messages_in` 行で `kind='task'`** である。関連カラム:
- `process_after`(ISO8601) — host sweep は `datetime(process_after) <= datetime('now')` のときコンテナを起こす
- `recurrence` — cron 文字列;`NULL` = ワンショット
- `series_id` — 繰り返し発生をグループ化;最初の insert ではタスク id に設定される
- `status` — `pending` | `processing` | `completed` | `failed` | `paused`

Public な API は `src/modules/scheduling/db.ts` の `insertTask()`。再帰はユーザの TZ で `cron-parser` 経由で計算される(`src/modules/scheduling/recurrence.ts` を参照)。マイグレーションは v1 の `schedule_type`+`schedule_value` ペアを単一の cron 文字列にマップしてから `insertTask()` を呼ぶ。

タスクはセッションがウェイクする前に存在できる — host sweep が最初の due tick でコンテナを作成・ウェイクする。

---

## クレデンシャル

**v1:** `.env` — プレーンな環境変数。`DISCORD_BOT_TOKEN`、`ANTHROPIC_API_KEY` 等。Host が直接読み、必要なコードに渡していた。

**v2:** OneCLI Agent Vault。`http://127.0.0.1:10254` の別のローカルサービスがシークレットを保持する。Agent は特定のシークレットに *スコープ* され、vault が承認された API リクエストに対してコンテナを離れる際に注入する。コンテナは生のシークレット値を決して見ない。

落とし穴:自動生成された agent はデフォルトで `selective` シークレットモード — vault にマッチするシークレットがあってもアタッチされない。修正は root CLAUDE.md の「auto-created agents start in selective secret mode」セクションを参照(`onecli agents set-secret-mode --mode all`)。

**自動マイグレーションが行うこと:**v1 の `.env` キーをすべて v2 の `.env` に逐語的にコピーするが、既存の v2 キーは決して上書きしない。OneCLI vault マイグレーションは別ステップで、`/init-onecli` skill が所有する(`.env` から pull する方法を知っている)。

---

## Channel adapter

**v1:** ネイティブな adapter(例:`discord.js` を直接使う)を `src/channels/` で import する。Channel をインストールするとは、コード編集、依存追加、env var 設定を意味した。

**v2:** Channel adapter は sibling の `channels` ブランチに住む。各 `/add-<channel>` skill は:
1. `git fetch origin channels`
2. `git show channels:src/channels/<name>.ts > src/channels/<name>.ts`
3. `src/channels/index.ts` に `import './<name>.js';` を追記
4. `pnpm install @chat-adapter/<name>@<pinned>`
5. `pnpm run build`

冪等 — 再実行は no-op。Pin したバージョンがサプライチェーンを honest に保つ。自動マイグレーションは v1 で配線されていた channel を検出(distinct な `channel_name` / JID prefix 経由)し、それぞれに対応する `setup/install-<channel>.sh` を実行する。v2 skill が無い v1 channel(v2 が追いつくにつれ稀)はハンドオフファイルに記録され、`/migrate-from-v1` skill がユーザに提起する。

**`.env` を越える channel 認証。** 一部の channel はセッション状態をディスクに保存する(Baileys WhatsApp keystore、Matrix sync state、iMessage トークン)。`channel-auth` ステップは channel ごとのレジストリ(`setup/migrate-v2/shared.ts: CHANNEL_AUTH_REGISTRY`)を持ち、どのファイル glob を env キーと並べてコピーするか知っている。

---

## 権限 — 暗黙から明示へ

**v1:** `registered_groups.is_main = 1` が 1 つの group を特権 group としてフラグ付けていた。`users` テーブルなし。Permission は慣習で、強制されなかった。

**v2:** 明示的なテーブル。
- `users(id = "<channel_type>:<handle>", kind, display_name)` — messaging プラットフォーム identifier ごとに 1 行
- `user_roles(user_id, role ∈ {owner, admin}, agent_group_id nullable, granted_by, granted_at)` — owner は常にグローバル、admin はグローバル or スコープ付き
- `agent_group_members(user_id, agent_group_id, ...)` — `sender_scope='known'` ゲート向けの「既知」メンバーシップ

Owner は `/migrate-from-v1` skill のインタビューフェーズ中に seed される(「あなたのハンドルはどれですか?」)。自動マイグレーションは推測しない — v1 にはその source of truth が無い。

**デフォルトアクセス — 「誰でも bot に話しかけられる」vs「既知ユーザのみ」。** v1 はこれを暗黙的に保存していた(トリガー regex + `is_main` 経由)。v2 はこれを `messaging_groups.unknown_sender_policy ∈ {'strict', 'request_approval', 'public'}` として公開する。Skill がユーザに v1 がどのモードで動いていたかを尋ね、マイグレートされた messaging group をそれに応じて切り替える。

---

## ディスク上の group フォルダ

**v1:** `groups/<folder>/CLAUDE.md` + オプションの `logs/`。`CLAUDE.md` はプレーンな命令文ファイルで、group 固有。

**v2:** 各 group は依然として `groups/<folder>/` に住むが、形はより豊か:
- `CLAUDE.md` — **コンテナ spawn 時に合成される**(`.claude-shared.md`(グローバルへのシンボリックリンク) + `.claude-fragments/*.md`(モジュールフラグメント) + `CLAUDE.local.md` から)。**`CLAUDE.md` を直接編集しない。**
- `CLAUDE.local.md` — group ごとの内容。マイグレーションは v1 の古い `CLAUDE.md` をここに書く。
- `container.json` — オプションの group ごとのコンテナ設定(apt 依存、env、マウント)。v1 の `registered_groups.container_config` JSON は近いが同一ではない — マイグレーションは v1 ペイロードを `groups/<folder>/.v1-container-config.json` に保存して skill に reconcile させ、silent にマップしない。
- `.claude-fragments/` と `.claude-shared.md` は、host が初めて group を触ったとき `initGroupFilesystem()` でインストールされるので、マイグレーションは `CLAUDE.local.md` を書くだけで、scaffolding は host に任せる。

---

## Host プロセス vs コンテナ

**v1:** 単一の Node プロセス。「agent」と router は同じプロセスだった。

**v2:** トップに Node host、セッションごとに Bun ランタイムの Docker コンテナ。両者は 2 つのセッション DB 経由でのみ通信する。共有モジュールなし、IPC なし、stdin パイプなし。Agent から host 内部に届くカスタムコード(またはその逆)を書いていた場合、その面はもう存在しない — それを移植するのは `/migrate-from-v1` skill のトピックであって、機械的コピーではない。

Lockfile:host は `pnpm-lock.yaml`、agent-runner は `bun.lock`。Host 側に `minimumReleaseAge: 4320`(3 日のサプライチェーン待ち)、agent-runner には release-age ゲートなし。

---

## 自己改修と MCP ツール

**v1:** MCP server や自己改修配線を追加した場合、通常は長命プロセスへの直接編集だった。

**v2:**
- MCP server は `container/agent-runner/src/mcp-tools/*.ts` 経由で登録され、セッションごとに load される。`install_packages` と `add_mcp_server` の self-mod ツールもあり、コンテナイメージを再ビルドする前に admin 承認フロー(`src/modules/self-mod/apply.ts`)を通す。
- v1 で書いたカスタム MCP ツールは v2 のツールレジストリにクリーンにマップするが、import パス、ランタイム(Bun vs Node)、SQL ヘルパーの差(`bun:sqlite` は `$name` プレフィックス付きパラメータを使う)は調整が必要かもしれない。Skill がこれを案内する。

---

## 消えたもの、マップできないもの

- **`scheduled_tasks` の独立テーブル** — セッション `inbound.db` の `kind='task'` に移動。マイグレーションはアクティブな行を移植し、非アクティブ/完了済は `logs/setup-migration/inactive-tasks.json` にエクスポートして参考に残す。
- **`messages` / `chats` テーブル(chat 履歴)** — マイグレートされない。必要なら v1 チェックアウトに留まる。
- **`router_state`(key/value)** — マイグレートされない。v2 の状態は上記の明示的なテーブルに住む。
- **`sessions`(v1 の group→session_id)** — v1 セッションはマップされない;v2 セッションは `(agent_group_id, messaging_group_id, thread_id)` でキーされ、オンデマンドで作成される。
- **古い `store/messages.db` への raw アクセス** — v1 DB はそのまま残され、触られない。マイグレーションが失敗したら再実行できる(マイグレーション sub-step は agent / channel / wiring に対して冪等、フォルダは rsync セマンティクス)。

---

## マイグレーション面 — コードの所在

- `migrate-v2.sh` — エントリポイント:v2 チェックアウトから `bash migrate-v2.sh`。
- `setup/migrate-v2/*.ts` — 個別マイグレーションステップ(env、db、groups、sessions、tasks、channel-auth、select-channels、switchover-prompt)。
- `setup/migrate-v2/shared.ts` — JID パース、トリガーマッピング、channel 認証レジストリ。
- `logs/setup-migration/handoff.json` — `migrate-v2.sh` が書き、`/migrate-from-v1` skill が読む。
- `logs/migrate-steps/*.log` — ステップごとの raw stdout。
- `.claude/skills/migrate-from-v1/SKILL.md` — owner シード、CLAUDE.md クリーンアップ、コンテナ設定検証、fork 移植のための Claude skill。
- `migrate-v2-reset.sh` — 再テストのため v2 状態を消去する開発ヘルパー。
- 完全な開発ガイドは [docs/migration-dev.md](migration-dev.md) を参照。
