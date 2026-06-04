# NanoClaw — セッションごとの DB スキーマ

各セッションが所有する 2 つの SQLite ファイル:`inbound.db`(host が書き、コンテナが読む)と `outbound.db`(コンテナが書き、host が読む)のリファレンス。3-DB 概要、single-writer ルール、クロスマウント可視性の制約については [db.md](db.md) から始めること。

スキーマは `src/db/schema.ts` の `INBOUND_SCHEMA` と `OUTBOUND_SCHEMA` 定数として置かれている。両ファイルは新しいセッションフォルダがプロビジョニングされるとき、`src/session-manager.ts` の `ensureSchema()` によって作られる。

---

## 1. セッションフォルダの配置

```
data/v2-sessions/<agent_group_id>/<session_id>/
  inbound.db              ← host が書き、コンテナが読む (read-only mount)
  outbound.db             ← コンテナが書き、host が読む (read-only open)
  .heartbeat              ← コンテナが mtime をタッチ (DB 書き込みではない)
  inbox/<message_id>/     ← ユーザ添付、inbound メッセージコンテンツからデコード
  outbox/<message_id>/    ← agent が生成した添付
```

1 セッション = 1 フォルダ = 1 ペアの DB。`agent_group_id` の親ディレクトリは、その agent group の全セッションで共有される group ごとの状態(`.claude-shared/`、`agent-runner-src/`)も保持する。

`src/session-manager.ts` のパスヘルパー:`sessionDir()`、`inboundDbPath()`、`outboundDbPath()`、`heartbeatPath()`。

---

## 2. Inbound DB (`inbound.db`)

Host 所有、コンテナは read-only。スキーマ定数:`src/db/schema.ts` の `INBOUND_SCHEMA`。

### 2.1 `messages_in`

セッションに到達するあらゆるメッセージ:user chat、スケジュール済タスク、再帰タスク、質問応答、内部システムメッセージ。

```sql
CREATE TABLE messages_in (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,           -- 偶数のみ (host が割り当てる) — §3 を参照
  kind           TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  status         TEXT DEFAULT 'pending',   -- pending|completed|failed|paused
  process_after  TEXT,
  recurrence     TEXT,                     -- 再帰用 cron 表現
  series_id      TEXT,                     -- 再帰タスクの発生回をグループ化
  tries          INTEGER DEFAULT 0,
  trigger        INTEGER NOT NULL DEFAULT 1, -- 0 = コンテキストのみ (起こさない)、1 = agent を起こす
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL,            -- JSON; 形は kind に依存
  source_session_id TEXT,                  -- agent-to-agent の戻りパス
  on_wake        INTEGER NOT NULL DEFAULT 0 -- 1 = コンテナの最初の poll でのみ配信
);
CREATE INDEX idx_messages_in_series ON messages_in(series_id);
```

コンテンツ形:[api-details.md §Session DB Schema Details](api-details.md#session-db-schema-details) を参照。

**Writer (host):** `src/db/session-db.ts` の `insertMessage()`、`insertTask()`、`insertRecurrence()`。すべて `nextEvenSeq()` を呼ぶ。
**Reader (コンテナ):** `container/agent-runner/src/db/messages-in.ts` — `status='pending' AND (process_after IS NULL OR process_after <= now)` を poll する。

### 2.2 `delivered`

Host は `messages_out` 行を channel adapter に渡した後にここに書く。コンテナは edit と reaction のターゲット解決のために `platform_message_id` を読む。

```sql
CREATE TABLE delivered (
  message_out_id      TEXT PRIMARY KEY,
  platform_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'delivered',  -- delivered|failed
  delivered_at        TEXT NOT NULL
);
```

Writer:`src/db/session-db.ts` の `markDelivered()` / `markDeliveryFailed()`。古いセッション DB は `migrateDeliveredTable()` によって遅延でスキーマに引き上げられる。

### 2.3 `destinations`

このセッションの agent 用の、central `agent_destinations` テーブル([db-central.md §1.10](db-central.md#110-agent_destinations) を参照)の投影。コンテナは `to="name"` をこのテーブルに対して解決する;行が無ければ送信は `unknown destination` として拒否される。

```sql
CREATE TABLE destinations (
  name           TEXT PRIMARY KEY,
  display_name   TEXT,
  type           TEXT NOT NULL,   -- 'channel' | 'agent'
  channel_type   TEXT,            -- type='channel' 用
  platform_id    TEXT,            -- type='channel' 用
  agent_group_id TEXT             -- type='agent' 用
);
```

コンテナのウェイクごと、およびセッション中に配線が変わった時のオンデマンドで、`writeDestinations()` によって丸ごと書き直される(トランザクション内で DELETE + INSERT)。`src/db/schema.ts` のテーブルへのコメントが、リフレッシュセマンティクスの正本的な記述である。

### 2.4 `session_routing`

単一行(`id=1`)のデフォルトルーティング:agent が destination を指定しない場合の outbound メッセージの行き先。

```sql
CREATE TABLE session_routing (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  channel_type TEXT,
  platform_id  TEXT,
  thread_id    TEXT
);
```

コンテナのウェイクごとに `writeSessionRouting()` が書き、`sessions.messaging_group_id` + `sessions.thread_id` から導出する。

---

## 3. シーケンス番号の不変条件

すべてのメッセージ(in でも out でも)は単調増加の整数 `seq` を持ち、*セッション内* で両テーブルを跨いで unique である。

- **Host は偶数 seq を書く**(2、4、6、…)— `messages_in` へ — `src/db/session-db.ts:75` の `nextEvenSeq()`。
- **コンテナは奇数 seq を書く**(1、3、5、…)— `messages_out` へ — `container/agent-runner/src/db/messages-out.ts:54` のロジック(`max % 2 === 0 ? max + 1 : max + 2`)、グローバル順序を保つために *両方* のテーブルにわたって `MAX(seq)` を読む。

なぜ disjoint なのか? `seq` は agent から見たメッセージ ID である。Agent が `edit_message(seq=5)` または `add_reaction(seq=6)` を呼ぶと、`getMessageIdBySeq()` は偶奇でルックアップをルーティングする:奇数 → `messages_out`、偶数 → `messages_in`。偶奇だけで JOIN 無しに曖昧性を解消できる。衝突すると edit が壊れる。

どちらかのテーブルに書き込むコードパスを追加するなら、偶奇を保つこと — 不変条件は制約で強制されておらず、2 つのヘルパー関数だけで強制されている。

---

## 4. Outbound DB (`outbound.db`)

コンテナ所有、host は読みのみ。スキーマ定数:`src/db/schema.ts` の `OUTBOUND_SCHEMA`。

### 4.1 `messages_out`

Agent が生成するすべて:chat 返信、edit、reaction、カード、質問送信、agent-to-agent メッセージ、システムアクション。

```sql
CREATE TABLE messages_out (
  id            TEXT PRIMARY KEY,
  seq           INTEGER UNIQUE,   -- 奇数のみ (コンテナが割り当てる) — §3 を参照
  in_reply_to   TEXT,
  timestamp     TEXT NOT NULL,
  deliver_after TEXT,
  recurrence    TEXT,
  kind          TEXT NOT NULL,    -- chat|chat-sdk|system|…
  platform_id   TEXT,
  channel_type  TEXT,
  thread_id     TEXT,
  content       TEXT NOT NULL     -- JSON; 操作は内部にある (edit/reaction/card/…)
);
```

コンテンツ形:[api-details.md §Session DB Schema Details](api-details.md#session-db-schema-details) を参照。

**Writer (コンテナ):** `container/agent-runner/src/db/messages-out.ts` の `writeMessageOut()`。
**Reader (host):** `src/delivery.ts`(ポーリング配信)、edit / reaction ターゲット解決のための `getMessageIdBySeq()` / `getRoutingBySeq()`。

### 4.2 `processing_ack`

コンテナが触れた各 `messages_in.id` に対するコンテナ側の状態。Host はこれを poll して状態を `messages_in` に同期する — これによりコンテナが `inbound.db` に書く必要を排除する。

```sql
CREATE TABLE processing_ack (
  message_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL,      -- processing|completed|failed
  status_changed TEXT NOT NULL
);
```

クラッシュリカバリ:コンテナ起動時に古い `processing` エントリがクリアされる。Host 側同期:`src/host-sweep.ts` の `syncProcessingAcks()`。

### 4.3 `session_state`

永続的なコンテナ所有 KV ストア。主要なコンシューマは Chat SDK セッション ID — ここに保存することで agent の会話がコンテナ再起動を跨いで再開できる。`/clear` でクリアされる。

```sql
CREATE TABLE session_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

アクセス:`container/agent-runner/src/db/session-state.ts`。

---

## 5. スキーマ進化

Central DB と違い、セッション DB は番号付きマイグレーションを **行わない**。`INBOUND_SCHEMA` と `OUTBOUND_SCHEMA` は両方とも `CREATE TABLE IF NOT EXISTS` を使うので、フレッシュなセッションは常に現在の形を得る。古いビルドの下で作られたセッションフォルダのカラムレベルのギャップは、open 時に遅延でパッチされる — 例:`src/db/session-db.ts` の `migrateDeliveredTable()` は、欠落していれば `delivered` テーブルに `platform_message_id` と `status` を追加する。

どちらかのスキーマにカラムを追加するなら、既存セッションフォルダ用に対応する遅延マイグレーションを追加し、データ backfill が要らないように nullable カラム or デフォルト値付きを優先すること。
