# Changelog

NanoClaw 上流および biblio-claw fork の重要な変更を本ファイルに記録する。biblio-claw 固有の変更は冒頭の `[biblio-claw-*]` セクションへ、上流 NanoClaw のリリースは `[2.x.x]` セクションへ追記する。

## [biblio-claw-m1-p1] - 2026-06-11

biblio-claw fork の **M1 Phase 1 (local 実装)** を完了。NanoClaw v2 の fork 取り込みを起点に、環境差分吸収アダプタ (`src/adapters/` = DSN / Scheduler / Secret 3 種) を新設し、docker compose 上で OneCLI gateway + PostgreSQL + Vertex 経由 Claude 接続 + Slack Socket Mode + GitHub App installation token 経路を成立させた。次は M1 Phase 2 (Prod デプロイ — GKE + Cloud SQL + Workload Identity)。

- **環境差分吸収アダプタ 3 種を新設**。`DsnProvider` / `SchedulerProvider` / `SecretProvider` を `src/adapters/` 配下に切り出し、環境 switch で local / Prod 実装を差し替え可能な境界として設置。
- **Vertex × Claude 接続経路を成立**。`src/providers/claude.ts` の env 群で Vertex 経由 `claude-sonnet-4-6` に OneCLI MITM で接続、ADC token を OneCLI に投入する経路を確立。
- **Slack adapter を Socket Mode で取り込み**。上流 NanoClaw の skill 経由インストール方針に対し、biblio-claw では `src/channels/slack.ts` を trunk に直接コミットする運用を採用。
- **GitHub App Sidecar token 経路を実装**。GitHub App PEM → RS256 JWT → installation access token を発行して OneCLI に投入する経路を確立、agent コンテナが creds 配付なしに `gh` で GitHub REST API に到達可能に。
- **Phase 1 verify 完全版**。静的層 (pnpm install / tsc / vitest / アダプタ smoke) + wiring 層 (docker compose / OneCLI 疎通 / Vertex secret / GH secret / provider 配線) の 2 段構成。

## [biblio-claw-m1-p1-task-1] - 2026-06-01

biblio-claw fork の Phase 1 Task 1 (NanoClaw 取り込み + ドキュメント整理) を完了。

- **NanoClaw v2 fork 取り込み**。`nanocoai/nanoclaw` @ `2492259` (2026-05-28) を biblio-claw の base として取り込み。
- **ドキュメント日本語化 + 統廃合**。CLAUDE.md / ルート 6 ファイル / `docs/` 23 ファイルを日本語化、上流提供の `README_ja.md` / `README_zh.md` は削除。
- **biblio-claw 固有運用ルール追加**。CLAUDE.md 上部に PRP コマンドフロー / Branch 戦略 / 環境分離方針 / 公開ポリシーを追記、NanoClaw 上流継承部分は CLAUDE.md 下部に保持し衝突時の優先ルールを明示。

## [2.0.64] - 2026-05-18

- **承認フロー経由の `ncl destinations add` と `remove` が、受信側に即時到達するようになった。** 承認された destination が受信側 agent のローカルセッション状態に投影されておらず、追加直後の destination は `send_message` で `unknown destination` として silent に失敗し、削除された destination は次のコンテナ再起動まで解決可能のままだった。両方とも、承認が実行された瞬間に効くようになった。直接(承認なし)呼び出しは影響を受けていない。

## [2.0.63] - 2026-05-15

v2.0.55 から v2.0.63 までをカバーするロールアップリリース — v2.0.54 タグ以降に merge されたすべて。本リリースから、`main` にランディングする `package.json` のバージョンバンプごとに GitHub Release を公開することを目指す;[RELEASING.md](https://github.com/nanocoai/nanoclaw/blob/main/RELEASING.md) を参照。

- [BREAKING] **サービス名が install ごとになった。** v2 install では launchd label と systemd unit がプロジェクトルートに基づいて slug 化される:`com.nanoclaw.<sha1(projectRoot)[:8]>` と `nanoclaw-<slug>.service`。古い `com.nanoclaw` / `nanoclaw.service` 名はもう実サービスにマッチしない — コピペした restart / status コマンドを更新すること。自分の install の名前は `source setup/lib/install-slug.sh && launchd_label`(macOS)または `systemd_unit`(Linux)で確認する。`ncl` の transport-error help テキストと 26 の skill ファイルが canonical な helper 駆動パターンを使うようになった;[setup/lib/install-slug.sh](setup/lib/install-slug.sh) を参照。
- **Compaction 後の destination リマインダー配置を修正。** SDK の自動コンパクション後に注入されるリマインダーが、コンパクションサマリーの末尾に来るようになった(切り詰めで剥がされないようにするため)。v2.0.54 で出荷された配置を置き換える。
- **メッセージラッピングの強制を強化。** 出力に `<message>` ラッピングが無い場合、ポーリングループが agent を nudge するようになり、`CLAUDE.md` のコア命令も、single-destination agent に対してもラッピングを要求するようになった。welcome フローはもう二重挨拶しない。
- **MCP インストール後の OneCLI クレデンシャル。** `add_mcp_server` 経由で追加した MCP server が OneCLI gateway ルーティングを継承するようになった — 新しい server インストール後に agent が API キーを尋ね続けるケースを修正する。
- **CLI scope の強化。** scope が欠落している場合 `scopeField` がフェイルクローズするようになり、`sessions get` は group スコープの agent からのクロスグループ oracle アクセスから守られた。
- **gmail/gcal skill を v2 に揃えた。** `/add-gmail-tool` と `/add-gcal-tool` が v2 のコンテナ設定モデル(DB バックエンドのマウント、死んだ `TOOL_ALLOWLIST` 編集なし、次の spawn で潰される `container.json` 書き込みなし)を反映するようになった。手動の sqlite3/JSON1 invocations を修正。
- **repo リネームのクリーンアップ。** 残っていた `qwibitai/nanoclaw` 参照をコードとドキュメント全域で `nanocoai/nanoclaw` に sweep;CI workflow ガードを更新し、リネーム後にも no-op しないようにした。
- attachment を読み書きする skill のため、Slack scope チェックリストに `files:read` と `files:write` を含めるようになった。
- destination 命令の internal-tag 記述で scratchpads に触れるのをやめた(agent がそれを誤ってルーティングする混乱を招いていた)。
- 古いセッション DB に `on_wake` 列が無い場合のコンテナ起動を gracefully に処理するようになった。

## [2.0.54] - 2026-05-10

- **group ごとの model と effort オーバーライド。** Agent group が特定の Claude モデルと effort レベルで動かせるようになった。`ncl groups config update --model <model> --effort <level>` で設定する。未設定の場合は host 設定のモデルがデフォルト。
- **Claude Code 2.1.128。** コンテナの claude-code を 2.1.116 から 2.1.128 にバンプ。
- `ncl groups config` と `ncl groups restart` の CLI ヘルプテキストを改善。

## [2.0.48] - 2026-05-09

- **コンテナ設定が DB に移った。** agent group ごとのコンテナランタイム設定(provider、model、packages、MCP servers、mounts、skills)が `groups/<folder>/container.json` ではなく `container_configs` テーブルに置かれるようになった。既存のファイルシステム設定は起動時に自動で backfill される。`ncl groups config get/update` と `config add-mcp-server/remove-mcp-server/add-package/remove-package` で管理する。
- **on-wake メッセージ付きの明示的再起動。** Config CLI 操作がコンテナを自動 kill しなくなった。新しい `ncl groups restart` コマンドが `--rebuild` と `--message` フラグ付きで導入された。on-wake メッセージ(`messages_in` の `on_wake` 列)はフレッシュなコンテナの最初の poll でのみ拾われ、SIGTERM の grace period 中に死にかけのコンテナがそれを横取りできなくなる。Self-mod 承認ハンドラ(`install_packages`、`add_mcp_server`)も同じレース無しの仕組みを使う。
- **group ごとの CLI scope。** コンテナ設定に新しい `cli_scope` 設定(`disabled` / `group` / `global`、デフォルト `group`)。コンテナ内から agent が `ncl` で何にアクセスできるかを制御する。`disabled` は CLI 命令を CLAUDE.md から除外し、すべてのリクエストをブロックする。`group`(デフォルト)は自グループのリソースに制限し、引数を自動補完する。`global` は無制限のアクセスを与える(owner agent group には自動設定)。クロスグループのデータ漏れを防ぐ post-handler の結果フィルタリングと、group スコープの agent からの `cli_scope` エスカレーションのブロックを含む。

## [2.0.45] - 2026-05-08

- **管理 CLI (`ncl`)。** central DB を照会・変更する新しい `ncl` コマンド — agent groups、messaging groups、wirings、users、roles、members、destinations、sessions、approvals、dropped messages。host 側 transport は Unix ソケット、コンテナ側 transport はセッション DB 経由。コンテナ内からの書き込み操作は承認フローを通る。`list` は列フィルタリングと `--limit` をサポート。使い方は `ncl help` を実行。
- **v1 → v2 マイグレーション。** v2 チェックアウトから `bash migrate-v2.sh` を実行する。v1 install(隣接ディレクトリまたは `NANOCLAW_V1_PATH`)を見つけ、`.env` をマージし、`registered_groups` から v2 DB を seed し、group フォルダ(`CLAUDE.md` → `CLAUDE.local.md`)をコピーし、会話継続性を持つセッションデータをコピーし、スケジュール済みタスクを移し、channel を対話的に選んでインストールし(clack の multiselect)、コンテナ skill をコピーし、エージェントコンテナをビルドし、テスト用のサービス切替を提示する。Claude(`/migrate-from-v1`)に引き継いで、owner シード、アクセスポリシー、CLAUDE.md クリーンアップ、fork カスタマイズの移植を行う。[docs/migration-dev.md](docs/migration-dev.md) と [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md) を参照。

## [2.0.0] - 2026-04-22

メジャーバージョン。NanoClaw v2 は実質的なアーキテクチャ書き直しである。既存の fork は再開前に `/migrate-nanoclaw`(カスタマイズのクリーンベース replay)または `/update-nanoclaw`(選択的 cherry-pick)を実行すること。

- [BREAKING] **新しいエンティティモデル。** Users、roles(owner/admin)、messaging groups、agent groups が別エンティティとして追跡され、`messaging_group_agents` で配線されるようになった。Privilege は channel レベルではなく user レベルになり、古い「main channel = admin」概念は廃止。[docs/architecture.md](docs/architecture.md) と [docs/isolation-model.md](docs/isolation-model.md) を参照。
- [BREAKING] **Two-DB セッション分割。** 各セッションは `inbound.db`(host が書き、コンテナが読む)と `outbound.db`(コンテナが書き、host が読む)を持ち、それぞれ writer は厳密に 1 つ。単一の共有セッション DB を置き換え、クロスマウントの SQLite 競合を排除する。[docs/db-session.md](docs/db-session.md) を参照。
- [BREAKING] **インストールフローを置き換え。** `bash nanoclaw.sh` が新しいデフォルト:エラー回復と誘導付き判断のため Claude Code に引き継ぐスクリプト版インストーラ。`/setup` の Claude 誘導 skill は代替として引き続き使える。
- [BREAKING] **Channels が `channels` ブランチに移動。** trunk は Discord、Slack、Telegram、WhatsApp、iMessage、Teams、Linear、GitHub、WeChat、Matrix、Google Chat、Webex、Resend、WhatsApp Cloud を同梱しなくなった。`/add-<channel>` skill で fork ごとにインストールする(skill は `channels` ブランチからコピーする)。`/update-nanoclaw` は fork が持っていた channel を再インストールする。
- [BREAKING] **代替 provider が `providers` ブランチに移動。** OpenCode、Codex、Ollama は `/add-opencode`、`/add-codex`、`/add-ollama-provider` でインストールする。Claude は trunk に組み込まれたデフォルト provider のまま。
- [BREAKING] **3 レベルの channel 分離。** Channel を独自の agent(別 agent group)に配線するか、独立した会話を持つ agent を共有(`session_mode: 'shared'`)するか、複数の channel を 1 つの共有セッションに merge(`session_mode: 'agent-shared'`)するか。`/manage-channels` 経由で channel ごとに選択する。
- [BREAKING] **Apple Container がデフォルトセットアップから外れた。** `/convert-to-apple-container` 経由のオプトインとして引き続き利用可能。
- **共有ソースの agent-runner。** group ごとの `agent-runner-src/` オーバーレイは廃止;全 group が同じ agent-runner を read-only でマウントする。group ごとのカスタマイズは合成された `CLAUDE.md`(共有ベース + group ごとのフラグメント)経由で流れる。
- **agent-runner ランタイムが Node から Bun へ移行。** コンテナイメージは自己完結する;host 側への影響なし。host は Node + pnpm のまま。
- **OneCLI Agent Vault が唯一のクレデンシャル経路。** コンテナは生の API キーを決して受け取らない;クレデンシャルはリクエスト時に注入される。

## [1.2.36] - 2026-03-26

- [BREAKING] pino logger を組み込みの logger に置き換え。WhatsApp ユーザは Baileys logger 互換性修正を取り込むため WhatsApp fork を再 merge する必要がある:`git fetch whatsapp main && git merge whatsapp/main`。`whatsapp` remote が設定されていない場合:`git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git`。

## [1.2.35] - 2026-03-26

- [BREAKING] OneCLI Agent Vault が組み込みのクレデンシャルプロキシを置き換える。ランタイムを確認する:`grep CONTAINER_RUNTIME_BIN src/container-runtime.ts` — `'container'` と表示されれば Apple Container、`'docker'` なら Docker。Docker ユーザ:`/init-onecli` を実行して OneCLI をインストールし、`.env` クレデンシャルを vault に移行する。Apple Container ユーザ:skill ブランチを再 merge し(`git fetch upstream skill/apple-container && git merge upstream/skill/apple-container`)、`/convert-to-apple-container` を実行してすべての指示に従う(クレデンシャルプロキシのネットワーキングを設定する) — `/init-onecli` は実行しないこと、Docker を要求するため。

## [1.2.21] - 2026-03-22

- 明示的なユーザ同意(Yes / No / 二度と聞かない)付きの PostHog 経由のオプトイン診断を追加

## [1.2.20] - 2026-03-21

- エラーハンドリングルール付きの ESLint 設定を追加

## [1.2.19] - 2026-03-19

- コンテナ再起動を速くするため `docker stop` タイムアウトを短縮(`-t 1` フラグ)

## [1.2.18] - 2026-03-19

- コンテナエラー時にユーザプロンプトの内容をログに残さないようにした — 入力メタデータのみ
- 日本語 README 翻訳を追加

## [1.2.17] - 2026-03-18

- `/capabilities` と `/status` のコンテナエージェント skill を追加

## [1.2.16] - 2026-03-18

- IPC タスクミューテーション後にタスクスナップショットがすぐにリフレッシュされるようにした

## [1.2.15] - 2026-03-16

- リモートコントロールプロンプトの自動受け入れを修正し、即時 exit を防止
- リモートコントロールがサービス再起動を生き延びるよう `KillMode=process` を追加

## [1.2.14] - 2026-03-14

- コンテナ内からホストレベルの Claude Code アクセスを行う `/remote-control` コマンドを追加

## [1.2.13] - 2026-03-14

**Breaking:** Skill が git ブランチになり、channel は別 fork repo になった。

- Skill は `skill/*` git ブランチとして存在し、`git merge` で merge される
- Docker Sandboxes サポートを追加
- セットアップ登録が正しい CLI コマンドを使うよう修正

## [1.2.12] - 2026-03-08

- 手動コンテキストコンパクション用の `/compact` skill を追加
- クレデンシャルプロキシ経由のコンテナ環境分離を強化

## [1.2.11] - 2026-03-08

- PDF リーダー、画像 vision、WhatsApp reactions skill を追加
- agent が IPC-only メッセージングを使う場合、タスクコンテナがすぐにクローズするよう修正

## [1.2.10] - 2026-03-06

- パフォーマンス改善のため、無制限のメッセージ履歴クエリに `LIMIT` を追加

## [1.2.9] - 2026-03-06

- 正確な時刻参照のため、agent プロンプトにタイムゾーンコンテキストを含めるようにした

## [1.2.8] - 2026-03-06

- スケジュール済みタスク向けの `send_message` ツールの誤解を招く説明を修正

## [1.2.7] - 2026-03-06

- ローカルモデル推論用の `/add-ollama` skill を追加
- `update_task` ツールを追加し、`schedule_task` からタスク ID を返すようにした

## [1.2.6] - 2026-03-04

- `claude-agent-sdk` を 0.2.68 に更新

## [1.2.5] - 2026-03-04

- CI フォーマット修正

## [1.2.4] - 2026-03-04

- `onMessage` コールバックでの `_chatJid` → `chatJid` リネームを修正

## [1.2.3] - 2026-03-04

- chat ごとのアクセス制御のため sender allowlist を追加

## [1.2.2] - 2026-03-04

- ローカル音声書き起こし用の `/use-local-whisper` skill を追加
- atomic なタスククレームでスケジュール済みタスクの二重実行を防止

## [1.2.1] - 2026-03-02

- バージョンバンプ(機能変更なし)

## [1.2.0] - 2026-03-02

**Breaking:** WhatsApp をコアから外し、skill に。`/add-whatsapp` で再追加する。

- Channel レジストリ:channel は `registerChannel()` ファクトリパターン経由で起動時に self-register する
- フォルダ名ベースのメイングループ検出を `isMain` フラグが置き換え
- `ENABLED_CHANNELS` を削除 — channel はクレデンシャルの有無で検出される
- コンテナランタイムがポーリング間隔を超えた場合のスケジュール済みタスクの二重実行を防止

## [1.1.6] - 2026-03-01

- Chromium スクリーンショット用の CJK フォントサポートを追加

## [1.1.5] - 2026-03-01

- ラップされた WhatsApp メッセージの正規化を修正

## [1.1.4] - 2026-03-01

- third-party モデルサポートを追加
- 上流との同期用の `/update-nanoclaw` skill を追加

## [1.1.3] - 2026-02-25

- `/add-slack` skill を追加
- 新アーキテクチャ向けに Gmail skill を再構成

## [1.1.2] - 2026-02-24

- WhatsApp Web バージョン取得のエラーハンドリングを改善

## [1.1.1] - 2026-02-24

- Qodo skill とコードベースインテリジェンスを追加
- WhatsApp 405 接続失敗を修正

## [1.1.0] - 2026-02-23

- Claude Code 内から上流変更を pull する `/update` skill を追加
- クレデンシャルプロキシ経由のコンテナ環境分離を強化
