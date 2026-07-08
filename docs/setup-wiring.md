# セットアップ配線 — 状況と残作業

最終更新:2026-06-11

## 完了済み

### Two-DB 分割(セッション DB の書き込み分離)
- セッション DB を `inbound.db`(host 所有)と `outbound.db`(コンテナ所有)に分割
- 各ファイルにつき writer は厳密に 1 つ — host-コンテナマウント間の SQLite 書き込み競合を排除
- host は偶数 seq、コンテナは奇数 seq(衝突なし)
- コンテナの heartbeat はファイルタッチ(`/workspace/.heartbeat`)、DB UPDATE ではない
- スケジューリングの MCP ツールは messages_out 経由でシステムアクションを emit する;host が `delivery.ts:handleSystemAction()` で inbound.db に適用する
- host の sweep は `processing_ack` テーブル + heartbeat ファイルの mtime を読んで stale 検出する
- コンテナは起動時に古い `processing_ack` エントリをクリアする(クラッシュリカバリ)
- ファイル:`src/db/schema.ts`(INBOUND_SCHEMA + OUTBOUND_SCHEMA)、`src/session-manager.ts`、`src/delivery.ts`、`src/host-sweep.ts`、`container/agent-runner/src/db/connection.ts`、`messages-in.ts`、`messages-out.ts`、`poll-loop.ts`、`mcp-tools/scheduling.ts`、`mcp-tools/interactive.ts`
- コンテナイメージを tsconfig(`container/agent-runner/tsconfig.json`)付きで再ビルド
- E2E 検証:host → Docker コンテナ → Claude が応答 → "E2E works!" ✓

### OneCLI 統合
- `src/container-runner.ts` で `applyContainerConfig()` の前に `ensureAgent()` 呼び出しを追加
- `ensureAgent` がないと、OneCLI は未知の agent identifier を拒否して false を返し、コンテナがクレデンシャル無しで残ってしまう
- OneCLI クレデンシャル注入で E2E 検証 ✓

### Channel barrel
- `src/index.ts` が `./channels/index.js`(barrel)を import する
- 上流 NanoClaw: trunk は barrel + Chat SDK ブリッジのみを出荷;`/add-<channel>` skill が adapter ファイルを置いて、barrel スロット経由で登録する
- 上流 NanoClaw: trunk に channel adapter は同梱されない
- **biblio-claw**: Slack adapter (`src/channels/slack.ts`) を trunk に直接コミット済。`setup/add-slack.sh` 経由で取り込んだ adapter を trunk = `main` にコミットする運用 (CLAUDE.md §チャネルと provider §biblio-claw 流の運用)
- **biblio-claw (第 2 例)**: Fugue channel adapter (`src/channels/fugue.ts` + `fugue-http.ts` + `fugue-schemas.ts`) も同方針で trunk に直接コミット済。ただし Fugue は upstream 由来の channel ではなく biblio-claw 固有の新規 HTTP adapter のため `setup/add-<channel>.sh` に相当する取り込み元は存在しない (= ゼロから実装)

### セットアップ登録(部分的)
- `setup/register.ts` が `data/v2.db` にエンティティ(`agent_groups`、`messaging_groups`、`messaging_group_agents`)を作成する
- `--platform-id` フラグを受け付ける
- `getMessagingGroupAgentByPair()` が重複配線を防ぐ
- `setup/verify.ts` が central DB をチェックする(配線済 agent group の数を数える)

### ルータログ
- `src/router.ts` が agent が配線されていない場合、`MESSAGE DROPPED` を WARN レベルでログし、行動可能なガイダンスを出す

---

## 既にオープンだったもの — 現在は解決済

### 1. ~~Channel skill が group を登録しない~~ ✅

Channel skill は "Next Steps" セクションで `/manage-channels` を指すようになった。登録は `/manage-channels` skill が処理し、各 channel の `## Channel Info` セクションをプラットフォーム固有のガイダンスとして読む。Channel skill は痩せたまま(クレデンシャルのみ)になる。

### 2. ~~Setup SKILL.md に group 登録ステップが無い~~ ✅

channel インストール(ステップ 5)とマウント allowlist(ステップ 6)の間に、ステップ 5a「Wire Channels to Agent Groups」を追加した。このステップは `/manage-channels` を呼び出し、agent group の作成、分離レベルの判断、配線を行う。

### 3. ~~Channel skill が channel タイプを知るべき~~ ✅

各 channel skill には `## Channel Info` という構造化セクションがあり、type、用語、id の探し方、threads サポート、典型的用途、デフォルト分離が含まれる。`/manage-channels` skill はこれを読んで文脈に応じた推奨を出す。

### 4. ~~Verify ステップの channel 認証チェック~~ ✅

`setup/verify.ts` がすべての channel トークンをチェックする:DISCORD_BOT_TOKEN、TELEGRAM_BOT_TOKEN、SLACK_BOT_TOKEN+SLACK_APP_TOKEN、GITHUB_TOKEN、LINEAR_API_KEY、GCHAT_CREDENTIALS、TEAMS_APP_ID+TEAMS_APP_PASSWORD、WEBEX_BOT_TOKEN、MATRIX_ACCESS_TOKEN、RESEND_API_KEY、WHATSAPP_ACCESS_TOKEN、IMESSAGE_ENABLED、加えて WhatsApp Baileys auth ディレクトリ。

### 5. Agent-shared セッションモード ✅

クロスチャネルの共有セッション(例:GitHub + Slack を 1 つの会話に)向けに `session_mode: 'agent-shared'` を追加した。このモードが設定されているとき、セッション解決は messaging_group_id ではなく agent_group_id でルックアップする。

---

## アーキテクチャリファレンス

### エンティティモデル
```
agent_groups (id, name, folder, agent_provider, container_config)
    ↕ many-to-many
messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy)
    via
messaging_group_agents (messaging_group_id, agent_group_id, trigger_rules, session_mode, priority)

users (id, kind, display_name)          -- "<channel>:<handle>" として名前空間化
user_roles (user_id, role, agent_group_id)    -- owner / admin (グローバル or スコープ付き)
agent_group_members (user_id, agent_group_id) -- 非特権ユーザのアクセスゲート
user_dms (user_id, channel_type, messaging_group_id)  -- cold-DM のキャッシュ
```

権限はユーザレベルの概念である — 「main」agent group や「admin」messaging group は存在しない。`user_roles` は `owner`(グローバルのみ、最初のペアリングが設定)と `admin`(グローバル or `agent_group_id` スコープ付き)を運ぶ。未知 sender のゲーティングは messaging group ごとに `messaging_groups.unknown_sender_policy`(`strict | request_approval | public`)で行う。

### メッセージフロー
```
channel adapter → routeInbound() → messaging_group を解決 → messaging_group_agents 経由で agent を解決
→ セッションを解決 / 作成 → inbound.db に書き込み → コンテナを起こす → agent-runner が inbound.db を poll
→ agent が応答 → outbound.db に書き込み → host の delivery poll が outbound.db を読む → adapter 経由で配信
```

### 主要ファイル
| ファイル | 役割 |
|------|---------|
| `src/index.ts` | エントリーポイント、channel barrel を import |
| `src/channels/index.ts` | Channel barrel — 上流 NanoClaw ではレジストリ / Chat SDK ブリッジのみ (skill が adapter を置く) / biblio-claw では Slack adapter + Fugue channel adapter を直接コミット済 |
| `src/router.ts` | 受信ルーティング、messaging group を自動作成 |
| `src/session-manager.ts` | セッションごとに inbound.db + outbound.db を作成 |
| `src/delivery.ts` | outbound.db を poll、配信、システムアクション処理 |
| `src/host-sweep.ts` | processing_ack の同期、stale 検出、再帰スケジュール |
| `src/container-runner.ts` | コンテナを起動、OneCLI ensureAgent + applyContainerConfig |
| `setup/register.ts` | エンティティを作成(agent_group、messaging_group、配線) |
| `setup/verify.ts` | central DB を確認(登録済 group) |
| `container/agent-runner/src/db/connection.ts` | Two-DB 接続レイヤ(inbound は read-only、outbound は read-write) |
