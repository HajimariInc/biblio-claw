# NanoClaw — Central DB スキーマ

`data/v2.db`(host 所有の admin プレーンデータベース)の完全リファレンス。3-DB 概要、マップ、クロスマウントルールについては [db.md](db.md) から始めること。

アクセスレイヤ:`src/db/`。スキーマリファレンスの正本:`src/db/schema.ts`(コメントのみ — 実際の作成は `src/db/migrations/` のマイグレーション経由)。

---

## 1. テーブル

### 1.1 `agent_groups`

Agent の workspace。各行は `groups/<folder>/` ディレクトリと 1:1 でマップされ、そこに `CLAUDE.md` と skill が含まれる。コンテナ設定は `container_configs` に住む(下記 §1.x を参照);spawn 時に `container.json` ファイルがマテリアライズされ、container runner がそれを読む。

```sql
CREATE TABLE agent_groups (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  folder           TEXT NOT NULL UNIQUE,
  agent_provider   TEXT,
  created_at       TEXT NOT NULL
);
```

- **Reader:** `src/session-manager.ts`、`src/delivery.ts`、`src/router.ts`
- **Writer:** `src/db/agent-groups.ts`

### 1.2 `messaging_groups`

プラットフォームの chat 1 つにつき 1 行(1 つの WhatsApp group、1 つの Slack channel、1 つの 1:1 DM 等)。

```sql
CREATE TABLE messaging_groups (
  id                    TEXT PRIMARY KEY,
  channel_type          TEXT NOT NULL,
  platform_id           TEXT NOT NULL,
  name                  TEXT,
  is_group              INTEGER DEFAULT 0,
  unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
  created_at            TEXT NOT NULL,
  UNIQUE(channel_type, platform_id)
);
```

- `unknown_sender_policy`:`strict`(drop)、`request_approval`(admin に尋ねる)、`public`(許可)。
- **Reader:** `src/router.ts`、`src/delivery.ts`、`src/session-manager.ts`
- **Writer:** `src/db/messaging-groups.ts`、channel セットアップフロー

### 1.3 `messaging_group_agents`

配線:どの agent group がどの messaging group を扱うか。Many-to-many — 同じ channel が複数 agent にルーティングできる([isolation-model.md](isolation-model.md) を参照)。

```sql
CREATE TABLE messaging_group_agents (
  id                 TEXT PRIMARY KEY,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  trigger_rules      TEXT,
  response_scope     TEXT DEFAULT 'all',
  session_mode       TEXT DEFAULT 'shared',
  priority           INTEGER DEFAULT 0,
  created_at         TEXT NOT NULL,
  UNIQUE(messaging_group_id, agent_group_id)
);
```

- `session_mode`:`shared`(channel ごとに 1 セッション)、`per-thread`(thread ごとに 1)、`agent-shared`(agent group ごとに、全 channel をまたいで 1)。
- `trigger_rules`:JSON;例えばネイティブ channel の regex。
- **副作用:** 配線を作るときには `agent_destinations` の populate も必須 — 片方だけを変更しないこと(§1.10 を参照)。

### 1.4 `users`

プラットフォームユーザの identity。ID は名前空間化される:`tg:123456`、`discord:abc`、`phone:+1555...`、`email:a@x.com`。1 人の人間が複数行を所有しうる — チャネル間のリンクはまだない。

```sql
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  display_name TEXT,
  created_at   TEXT NOT NULL
);
```

- **Writer / Reader:** `src/db/users.ts`;channel 認証フロー

### 1.5 `user_roles`

権限。**Privilege はユーザレベルで、agent-group レベルではない。**

```sql
CREATE TABLE user_roles (
  user_id        TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL,
  agent_group_id TEXT REFERENCES agent_groups(id),
  granted_by     TEXT REFERENCES users(id),
  granted_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
CREATE INDEX idx_user_roles_scope ON user_roles(agent_group_id, role);
```

不変条件:
- `role = 'owner'` → グローバルでなければならない(`agent_group_id IS NULL`)。`grantRole()` で強制。
- `role = 'admin'` → グローバル(NULL)、または 1 つの agent group にスコープ付き。
- A 上の admin は A のメンバーシップを含意する — `agent_group_members` 行は不要。

アクセスレイヤ:`src/db/user-roles.ts`、`src/access.ts`。

### 1.6 `agent_group_members`

非特権ユーザの明示的メンバーシップ。Owner と admin はここに行が要らない — 暗黙のメンバーである。

```sql
CREATE TABLE agent_group_members (
  user_id        TEXT NOT NULL REFERENCES users(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  added_by       TEXT REFERENCES users(id),
  added_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);
```

### 1.7 `user_dms`

DM channel 発見のキャッシュ。プラットフォームの `openConversation` API を毎回叩かずに、host が cold DM(承認カード、ペアリングコード)を送れるようにする。

```sql
CREATE TABLE user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);
```

`src/user-dm.ts` の `ensureUserDm()` で遅延 populate される。

### 1.8 `sessions`

セッションレジストリ。`session_mode` に従って(agent group、messaging group、thread)のタプルごとに 1 行。ライフサイクルメタデータのみを保持し、メッセージは保持しない。

```sql
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  messaging_group_id TEXT REFERENCES messaging_groups(id),
  thread_id          TEXT,
  agent_provider     TEXT,
  status             TEXT DEFAULT 'active',
  container_status   TEXT DEFAULT 'stopped',
  last_active        TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX idx_sessions_lookup     ON sessions(messaging_group_id, thread_id);
```

- **解決元:** `src/session-manager.ts` の `resolveSession()`。
- セッション作成は `initSessionFolder()` 経由でセッションフォルダと両方のセッション DB をプロビジョンもする — [db-session.md](db-session.md) を参照。

### 1.9 `pending_questions`

`ask_user_question` MCP ツールが対話的な質問をここに駐車し、コンテナは受信した `system` メッセージを `questionId` でこれにマッチさせる。

```sql
CREATE TABLE pending_questions (
  question_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  message_out_id TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  title          TEXT NOT NULL,
  options_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
```

### 1.10 `agent_destinations`

Outbound 送信のための権限 ACL *かつ* 名前解決マップ。Agent が `send_message(to="dev-channel")` を呼ぶには、ここに `local_name = 'dev-channel'` の行が必要 — 無ければ送信は `unknown destination` として拒否される。

```sql
CREATE TABLE agent_destinations (
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  local_name     TEXT NOT NULL,
  target_type    TEXT NOT NULL,   -- 'channel' | 'agent'
  target_id      TEXT NOT NULL,   -- messaging_group_id | agent_group_id
  created_at     TEXT NOT NULL,
  PRIMARY KEY (agent_group_id, local_name)
);
CREATE INDEX idx_agent_dest_target ON agent_destinations(target_type, target_id);
```

**投影の不変条件(load-bearing)。** Central テーブルが source of truth だが、走っている各コンテナは自身の `inbound.db` の投影から読む([db-session.md §2.3](db-session.md#23-destinations) を参照)。コンテナが走っている最中に `agent_destinations` を mutate するコードは、`writeDestinations()`(`src/session-manager.ts`)も呼ぶ必要がある — でないとコンテナは stale データで送信を拒否する。既知の呼び出し箇所:`src/db/messaging-groups.ts` の `createMessagingGroupAgent()`、`src/delivery.ts` の `create_agent` システムアクション。

アクセスレイヤ:`src/db/agent-destinations.ts`。

### 1.11 `pending_approvals`

2 つのワークフローがこのテーブルを共有する:

- **セッション結合 MCP 承認** — `install_packages`、`add_mcp_server`。`session_id` が設定される。
- **OneCLI クレデンシャル承認** — `session_id` は NULL の可能性;`agent_group_id` + `channel_type` + `platform_id` が admin カードをルーティングする。

```sql
CREATE TABLE pending_approvals (
  approval_id         TEXT PRIMARY KEY,
  session_id          TEXT REFERENCES sessions(id),
  request_id          TEXT NOT NULL,
  action              TEXT NOT NULL,
  payload             TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  agent_group_id      TEXT REFERENCES agent_groups(id),
  channel_type        TEXT,
  platform_id         TEXT,
  platform_message_id TEXT,
  expires_at          TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',
  title               TEXT NOT NULL DEFAULT '',
  options_json        TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_pending_approvals_action_status ON pending_approvals(action, status);
```

- `status`:`pending` | `approved` | `rejected` | `expired`。
- `platform_message_id` により、判断後に host が admin カードを場所そのままで編集できる。
- アクセスレイヤ:`src/db/sessions.ts`;sweep + 配信:`src/onecli-approvals.ts`。

### 1.12 `unregistered_senders`

監査トレイル:メッセージが drop されるたび(未知 sender、strict ポリシー)、ここでカウンタをインクリメントするので、admin は誰が叩こうとしていたかを見られる。

```sql
CREATE TABLE unregistered_senders (
  channel_type       TEXT NOT NULL,
  platform_id        TEXT NOT NULL,
  user_id            TEXT,
  sender_name        TEXT,
  reason             TEXT NOT NULL,
  messaging_group_id TEXT,
  agent_group_id     TEXT,
  message_count      INTEGER NOT NULL DEFAULT 1,
  first_seen         TEXT NOT NULL,
  last_seen          TEXT NOT NULL,
  PRIMARY KEY (channel_type, platform_id)
);
CREATE INDEX idx_unregistered_senders_last_seen ON unregistered_senders(last_seen);
```

Writer:`src/db/dropped-messages.ts` の `recordDroppedMessage()`。コンフリクト時には `message_count` と `last_seen` を bump する。

### 1.13 Chat SDK ブリッジテーブル

Chat SDK ブリッジが使う `SqliteStateAdapter` の状態を裏付ける([api-details.md](api-details.md) を参照)。NanoClaw コードはこれらに直接触れることは少ない — `src/state-sqlite.ts` が所有する。

```sql
CREATE TABLE chat_sdk_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER                    -- unix ts、nullable
);

CREATE TABLE chat_sdk_subscriptions (
  thread_id     TEXT PRIMARY KEY,
  subscribed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE chat_sdk_locks (
  thread_id  TEXT PRIMARY KEY,
  token      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE chat_sdk_lists (
  key        TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  value      TEXT NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (key, idx)
);
```

### 1.14 `schema_version`

マイグレーション元帳、マイグレーションランナー(§2)が書く。

```sql
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  applied TEXT NOT NULL
);
```

### 1.15 `container_configs`

Agent group ごとのコンテナランタイム設定。provider、model、packages、MCP servers、mounts、CLI scope 等の source of truth。Spawn 時に `groups/<folder>/container.json` にマテリアライズされる。

```sql
CREATE TABLE container_configs (
  agent_group_id         TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
  provider               TEXT,
  model                  TEXT,
  effort                 TEXT,
  image_tag              TEXT,
  assistant_name         TEXT,
  max_messages_per_prompt INTEGER,
  skills                 TEXT NOT NULL DEFAULT '"all"',
  mcp_servers            TEXT NOT NULL DEFAULT '{}',
  packages_apt           TEXT NOT NULL DEFAULT '[]',
  packages_npm           TEXT NOT NULL DEFAULT '[]',
  additional_mounts      TEXT NOT NULL DEFAULT '[]',
  cli_scope              TEXT NOT NULL DEFAULT 'group',   -- disabled | group | global
  updated_at             TEXT NOT NULL
);
```

- **Reader:** `src/container-config.ts`、`src/container-runner.ts`、`src/cli/dispatch.ts`(scope 強制)、`src/claude-md-compose.ts`
- **Writer:** `src/db/container-configs.ts`、`src/modules/self-mod/apply.ts`、`src/backfill-container-configs.ts`

### 1.16 `boots`

biblio-claw 追加。`id=1` の単一行を持ち、host 起動毎に `count` を monotonic increment する決定的指紋テーブル。Phase 2 verify (`scripts/verify-phase-2-wiring.sh` §7) で「Pod 再作成跨ぎで count が増える」ことを assertion することで、PVC + SQLite の永続化が機能していることを確認する (PoC-13 写経)。

```sql
CREATE TABLE boots (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  count        INTEGER NOT NULL DEFAULT 0,
  last_boot_at TEXT NOT NULL
);
```

- `CHECK (id = 1)` により、同 PVC を再 attach した orchestrator が必ず 1 行だけ保持する。
- 初期行は migration016 が `INSERT OR IGNORE` で投入するため、boot-counter 側は単純な UPDATE で count を増分できる (古い SQLite の `INSERT...ON CONFLICT` 非対応問題を回避)。
- **Reader:** `src/boot-counter.ts`、`scripts/verify-phase-2-wiring.sh` (kubectl exec 経由)
- **Writer:** `src/boot-counter.ts` (`incrementBootCounter()`)

---

## 2. マイグレーションシステム

マイグレーションは `src/db/migrations/` に住み、マイグレーションごとに 1 ファイル。ランナー:`src/db/migrations/index.ts` の `runMigrations()`。次を行う:

1. `schema_version` がなければ作成する。
2. `MAX(version)` を読む — これを `current` と呼ぶ。
3. `version > current` の各マイグレーションについて、トランザクション内で `up(db)` を実行し、`schema_version` 行を追記する。

| # | ファイル | 導入するもの |
|---|------|------------|
| 001 | `001-initial.ts` | コアテーブル:`agent_groups`、`messaging_groups`、`messaging_group_agents`、`users`、`user_roles`、`agent_group_members`、`user_dms`、`sessions`、`pending_questions` |
| 002 | `002-chat-sdk-state.ts` | `chat_sdk_kv`、`chat_sdk_subscriptions`、`chat_sdk_locks`、`chat_sdk_lists` |
| 003 | `003-pending-approvals.ts` | `pending_approvals`(セッション結合 + OneCLI フィールド) |
| 004 | `004-agent-destinations.ts` | `agent_destinations` + 既存の `messaging_group_agents` 配線からの backfill |
| 007 | `007-pending-approvals-title-options.ts` | `ALTER TABLE pending_approvals` で `title`、`options_json` を追加(003 と 007 の間に作られた DB を retrofit) |
| 008 | `008-dropped-messages.ts` | `unregistered_senders` |
| 009 | `009-drop-pending-credentials.ts` | 廃止された `pending_credentials` テーブルを drop |
| 014 | `014-container-configs.ts` | `container_configs` — agent group ごとのコンテナランタイム設定 |
| 015 | `015-cli-scope.ts` | `ALTER TABLE container_configs ADD COLUMN cli_scope` |
| 016 | `016-boots.ts` | `boots` — biblio-claw 追加。Phase 2 verify 用の決定的指紋 (PVC + SQLite 永続化アサーション) |
| 017 | `017-session-equipped-biblios.ts` | `session_equipped_biblios` — biblio-claw 追加 (M3 Phase 2)。session 単位の装備リスト (session_id + biblio_name + order_index + equipped_at、PK = (session_id, biblio_name)、ON DELETE CASCADE) |
| 018 | `018-biblio-settings.ts` | `biblio_settings` — biblio-claw 追加 (個別 PRD `individual-skill-shiire` Phase 5 dynamic-config)。biblio 設定値の動的変更を persist (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)。初期行なし = 空 table = `acquire.ts:resolveSkillThreshold` の DB → env → DEFAULT 3 層 fallback で env 経路に降りる |

005 と 006 は意図的に欠番 — 初期開発中にマイグレーションが番号付け直された。

セッション DB スキーマ(`INBOUND_SCHEMA`、`OUTBOUND_SCHEMA`)はここでは **バージョン管理されない**。`CREATE TABLE IF NOT EXISTS` なので、新しいカラムは古いビルドのセッションファイルが再 open されたとき、セッション DB の遅延マイグレーションヘルパー(`migrateDeliveredTable()` 等)経由で着地する。[db-session.md](db-session.md) を参照。
