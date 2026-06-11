# NanoClaw データベースアーキテクチャ — 概要

データモデルの全体像:3 つのデータベース、それぞれの噛み合い方、そしてそれらをまたいで成立する不変条件。テーブルレベルのスキーマは下記のリンクを辿ること。

- **[db-central.md](db-central.md)** — `data/v2.db` の全テーブル(identity、wiring、approvals、Chat SDK 状態)とマイグレーションシステム。
- **[db-session.md](db-session.md)** — セッションごとの `inbound.db` + `outbound.db` ペア、seq の偶奇、セッションフォルダの配置。

関連:[architecture.md](architecture.md) は高レベル設計、[api-details.md](api-details.md) は inbound/outbound メッセージのコンテンツ形状、[isolation-model.md](isolation-model.md) は channel と agent の配線モード。

---

## 1. 3 つのデータベース

NanoClaw は **3 種類の SQLite データベース** を使い、すべて host のファイルシステム上に置く:

| DB | 場所 | Writer | Reader | 役割 |
|----|----------|--------|---------|---------|
| **Central** | `data/v2.db` | host | host | identity、permission、ルーティング、wiring — admin プレーン |
| **Session inbound** | `data/v2-sessions/<agent_group_id>/<session_id>/inbound.db` | host | host(同期)、コンテナ(read-only) | host → コンテナのメッセージ + ルーティングの投影 |
| **Session outbound** | `data/v2-sessions/<agent_group_id>/<session_id>/outbound.db` | コンテナ | host(poll)、コンテナ | コンテナ → host のメッセージ + 処理状況 |

**Single-writer ルール。** すべての SQLite ファイルに writer は厳密に 1 つ。host は central DB とすべての `inbound.db` に書き、コンテナは自身の `outbound.db` にのみ書く。これにより Docker / Apple Container のマウント境界をまたぐ書き込み競合を排除する — その境界を越える SQLite ロックは信頼できないため。

**すべてはメッセージである。** host とコンテナの間に IPC、stdin パイプ、ファイルウォッチャは存在しない。2 つのセッション DB が唯一の IO 境界である。Heartbeat は `.heartbeat` ファイルの `touch(2)` であって、DB 書き込みではない。

**Journal モード。** セッション DB は `journal_mode = DELETE` を使う(WAL ではない)。クロスマウントでの WAL 可視性はバグの温床;DELETE モード + 開いて書いて閉じるパターンが page cache を flush し、反対側が変更を見られる。

---

## 2. DB マップ

```
data/
  v2.db                                   ← CENTRAL (host ↔ host)
  v2-sessions/
    <agent_group_id>/
      .claude-shared/                     ← agent group 用の共有 Claude 状態
      agent-runner-src/                   ← group ごとの agent-runner オーバーレイ
      <session_id>/
        inbound.db                        ← host が書き、コンテナが読む
        outbound.db                       ← コンテナが書き、host が読む
        .heartbeat                        ← コンテナが mtime をタッチ
        inbox/<message_id>/               ← デコード済のユーザ添付
        outbox/<message_id>/              ← agent が生成した添付
```

パスヘルパー:`sessionDir()`、`inboundDbPath()`、`outboundDbPath()`、`heartbeatPath()` — ラッパー (既存シグネチャを保ったままの薄い委譲) は `src/session-manager.ts` 内、パス算出の実体は `getDsnProvider()` (= `src/adapters/dsn/`、Phase 1 で新設)。Phase 2 で GKE PV (StatefulSet `volumeClaimTemplates` + mountPath `/data`) へ差し替え済 — `src/adapters/dsn/gke.ts` の `GkeDsnProvider` 実装、`DSN_PROVIDER=gke` env で切替。

---

## 3. Central と session:何をどこに置くか

| データの種類 | 場所 | 理由 |
|--------------|-------|-----|
| identity、role、membership | central | 安定的、セッションを跨ぐ、書き込み頻度が低い |
| Channel 配線、ルーティングルール | central | admin プレーン |
| Destination ACL | central(+ セッションごとに投影) | 正本は central、セッションごとに高速ローカルルックアップ |
| セッションレジストリ(id、status) | central | host がライフサイクルをオーケストレート |
| Approval と pending 質問 | central | コンテナ再起動を生き延びる、admin に可視 |
| Dropped メッセージの監査 | central | グローバルな運用ビュー |
| Inbound メッセージ、リトライ状態 | session `inbound.db` | セッションごとの作業負荷、host が唯一の writer |
| Outbound メッセージ、agent 状態 | session `outbound.db` | コンテナが唯一の writer、host が poll |
| 配信結果 | session `inbound.db`(`delivered`) | host が成功時に書く、コンテナが edit のターゲット解決のために読む |
| 処理状況 | session `outbound.db`(`processing_ack`) | コンテナは `inbound.db` に書き込めない |

ヒューリスティック:値がメッセージ、ルーティング投影、ランタイム ack ならセッションごと。それ以外は central。

---

## 4. クロスマウントの可視性

セッション DB はコンテナに bind-mount される。DB コードを触る前に知っておくべきルールがいくつかある:

- **`journal_mode = DELETE` で、WAL ではない。** WAL ファイルはマウントを確実に越えず、コンテナが古いページを読みうる。DELETE モードは writer ごとにメインファイルを flush することを強制する。
- **host 側は open-write-close。** host 側の `inbound.db` への書き込みは接続を開いて書いて閉じる。ハンドルを開いたままにすると、キャッシュされたページがコンテナから見えなくなる。
- **コンテナの読み込みは read-only。** コンテナは `readonly: true` で `inbound.db` を開き、書き込みは決してしない — コンテナ→host の状態はすべて `outbound.db` を経由する([db-session.md](db-session.md#52-processing_ack) の `processing_ack` を参照)。
- **Heartbeat はファイルタッチ。** `.heartbeat` の mtime が liveness シグナルであって、DB カラムではない。Heartbeat ごとに DB 書き込みをすると、他の writer の後ろにシリアライズされてしまう。

これらのルールは `src/session-manager.ts` と `container/agent-runner/src/db/` 内の慣習で強制される。DB の開き方を変えるなら、まずそのコードを再読すること。

---

## 5. 設計パターン早見

1. **Two-DB セッション分割。** `inbound.db` と `outbound.db` はそれぞれ writer 1 つ、フロー方向 1 つ — クロスマウントのロック競合なし。
2. **Seq の偶奇。** 偶数 = host、奇数 = コンテナ。両テーブルを跨ぐ disjoint な名前空間により、agent は任意のメッセージを `seq` だけで参照できる。詳細は [db-session.md §3](db-session.md#3-sequence-numbering-invariant)。
3. **投影パターン。** `agent_destinations` と `session_routing` は central DB からセッションごとの `inbound.db` に、コンテナのウェイク時に投影される — コンテナはマウント越しのクエリ無しに、高速でローカルな読み出しパスを得る。
4. **逆チャネルでの ack。** コンテナは `inbound.db` に決して書かない。状態同期は `outbound.db` の `processing_ack` を経由し、host が poll して reconcile する。
5. **Heartbeat はアウトオブバンド。** `.heartbeat` のファイル `touch` であって DB 書き込みではないため、liveness が他の writer の後ろにシリアライズされない。
6. **セッション DB のマイグレーションは遅延型。** Central DB は番号付きマイグレーションを使い、セッションごとの DB は古いセッションフォルダ向けに `IF NOT EXISTS` + アドホックな `ALTER TABLE` ヘルパーを使う。
7. **ACL = 行の存在。** `agent_destinations` のメンバーシップそのものが権限である — 別の `permissions` テーブルはない。

---

## 6. Reader と writer 早見

| テーブル | DB | Writer | Reader |
|-------|----|-----------|-----------|
| `agent_groups` | central | `src/db/agent-groups.ts` | セッションリゾルバ、delivery、router |
| `messaging_groups` | central | `src/db/messaging-groups.ts`、channel setup | router、delivery、セッションリゾルバ |
| `messaging_group_agents` | central | `src/db/messaging-groups.ts` | router |
| `users` | central | `src/db/users.ts`、認証フロー | 権限チェック |
| `user_roles` | central | `src/db/user-roles.ts` | `src/access.ts`、すべての権限ゲート |
| `agent_group_members` | central | `src/db/agent-group-members.ts` | メンバーシップチェック |
| `user_dms` | central | `src/user-dm.ts`(`ensureUserDm`) | 承認 + ペアリング配信 |
| `sessions` | central | `src/db/sessions.ts`、`src/session-manager.ts` | delivery、sweep、コンテナ runner |
| `pending_questions` | central | `src/db/sessions.ts`(`ask_user_question` 経由) | コンテナ応答マッチャ |
| `agent_destinations` | central | `src/db/agent-destinations.ts`、migration 004 backfill | `writeDestinations()`、配信 ACL |
| `pending_approvals` | central | `src/db/sessions.ts`、`src/onecli-approvals.ts` | admin カード配信、sweep |
| `unregistered_senders` | central | `src/db/dropped-messages.ts` | 運用ツール |
| `chat_sdk_*` | central | `src/state-sqlite.ts` | Chat SDK ブリッジ |
| `schema_version` | central | `src/db/migrations/index.ts` | マイグレーションランナー |
| `messages_in` | inbound | `src/db/session-db.ts` | `container/agent-runner/src/db/messages-in.ts` |
| `delivered` | inbound | `src/db/session-db.ts`(`markDelivered`) | コンテナの edit / reaction ターゲット解決 |
| `destinations` | inbound | `src/session-manager.ts` の `writeDestinations()` | コンテナのルーティング / ACL |
| `session_routing` | inbound | `src/session-manager.ts` の `writeSessionRouting()` | コンテナの `send_message` デフォルト |
| `messages_out` | outbound | `container/agent-runner/src/db/messages-out.ts` | `src/delivery.ts` の poll ループ |
| `processing_ack` | outbound | `container/agent-runner/src/db/messages-in.ts` | `src/host-sweep.ts`(`syncProcessingAcks`) |
| `session_state` | outbound | `container/agent-runner/src/db/session-state.ts` | コンテナ起動時 |
