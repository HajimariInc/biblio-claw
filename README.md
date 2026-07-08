# biblio-claw

`biblio-shelf` プロジェクトの**司書実装リポジトリ**。[`nanocoai/nanoclaw`](https://github.com/nanocoai/nanoclaw) (NanoClaw v2, commit `2492259`, 2026-05-28) を fork し、Google Cloud (Vertex AI + GKE) 上で動作する司書 (biblio) として作り変えた。

## Fork Attribution / 上流との関係

biblio-claw は **[nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw)** (NanoClaw v2、上流 commit `2492259`、2026-05-28) を fork して base 化しています。上流 NanoClaw 由来のドキュメントは `docs/` 配下 (日本語訳を含む) に参考として残置、biblio-claw 独自の拡張ドキュメントは `CLAUDE.md` §ドキュメント索引 + `docs/glossary.md` (biblio 独自語彙集) 経由で辿れます。

- **上流由来 doc の参考リンク集**: [`docs/README.md`](docs/README.md)
- **biblio-claw 独自 doc の索引**: [`CLAUDE.md`](CLAUDE.md#ドキュメント索引)
- **biblio 独自語彙 (biblio / 司書 / patron / 装備 / 禁書 / 焼却 等) の解説**: [`docs/glossary.md`](docs/glossary.md)
- **アーキテクチャ図**: [`docs/architecture-diagram.md`](docs/architecture-diagram.md) (GitHub 上で Mermaid が自動 render されます)

### 姉妹プロジェクトとの integration

biblio-claw は姉妹プロジェクト **Fugue** (`<FUGUE_REPO_URL_HERE>` — Fugue リポ public 化後に確定) からの channel integration を受け入れます。詳細は [`docs/setup-wiring.md`](docs/setup-wiring.md) 参照。

> **機能ハイライト**:
> - **仕入れ → 検品 → カテゴライズ → 陳列**: patron の 1 通の依頼で外部の biblio (skill) を棚リポジトリに draft PR で並べる E2E 経路
> - **装備機構 + 蔵書一覧**: session 単位の biblio 装備 / 解除 / 禁書 / 焼却 (破壊操作は HITL 承認) と Slack から棚 marketplace の閲覧
> - **観測性**: OpenTelemetry + GenAI semconv + Cloud Trace + BigQuery sink で 1 trace 串刺しの cost attribution
> - **channel integration**: Slack (bot / DM) + Fugue (同期 HTTP、外部 AD 連携用、consult / equip / ask の 3 endpoint、M4-H で ask endpoint 追加)
>
> 詳細な Milestone 完了状況と PR 履歴は [`CLAUDE.md`](CLAUDE.md) 冒頭を参照。

## クイックスタート (biblio-claw, local)

**前提**:
- Node.js 24.13+ / pnpm / bun
- Docker Desktop または Docker Engine
- gcloud CLI + ADC ログイン済 (`gcloud auth application-default login --project <your-gcp-project>`)
- `.env` 投入 — `.env.example` を雛形に `ANTHROPIC_VERTEX_PROJECT_ID` / `GH_APP_ID` / `GH_INSTALLATION_ID` / `GH_APP_PEM_PATH` / `SLACK_BOT_TOKEN` / `SHELF_REPO_OWNER` 等を手動で埋める

**setup + 起動**:

```bash
cp .env.example .env       # 既存があれば skip、値は手動で埋める
# claude code から /init-project を実行 (= 新規 setup、`.env` 準備 → docker compose →
# deps install → host agent 登録 → token 投入 → コンテナ build → スモーク verify までを 1 連で実行)
pnpm run dev               # host process を起動 (foreground、Slack adapter 接続)
pnpm run chat "hello"      # smoke 用 CLI から司書と会話
```

詳細手順 / トラブルシューティング / サブコマンド (`up` / `reset` / `refresh` / `verify`) は `.claude/commands/init-project.md` を参照。日常運用は [`docs/operations-runbook.md`](docs/operations-runbook.md) (local / GCP の orchestrator・agent・OneCLI 早見表 + M2 verify 前提セットアップ)、Slack 2 環境分離 (本番 ws / 開発 ws) は [`docs/slack-environments-setup.md`](docs/slack-environments-setup.md) を参照。

## GKE 運用

日常運用 / リセット / トラブルシューティングは [`docs/operations-runbook.md`](docs/operations-runbook.md) を参照 (Cloud SQL の初回 GRANT は `bash scripts/init-project-gcp-pgsql-grant.sh` で 1 発、空でない DB を新 GSA で引き継ぐケースは runbook §「既存 DB を新 GSA で引き継ぐ場合の role membership 継承 GRANT」)。

> **以下は NanoClaw 上流 README を継承する**。biblio-claw のために書き換えていない部分が多く含まれる。本リポジトリ向けの公式手順は上記「クイックスタート」と `CLAUDE.md` を優先すること。

---

<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  エージェントを専用コンテナで安全に実行する AI アシスタント。軽量で、理解しやすく、自分のニーズに合わせて完全にカスタマイズできるように作られている。
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.nanoclaw.dev">ドキュメント</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="repo tokens" valign="middle"></a>
</p>

---

## なぜ NanoClaw を作ったか

[OpenClaw](https://github.com/openclaw/openclaw) は素晴らしいプロジェクトだが、自分の生活全体へのフルアクセスを、理解できない複雑なソフトウェアに渡したまま眠ることはできなかった。OpenClaw はおよそ 50 万行のコード、53 個の設定ファイル、70 を超える依存を持つ。そのセキュリティは true な OS レベルの分離ではなく、アプリケーションレベル(allowlist、ペアリングコード)で実現されている。すべてが共有メモリを持つ 1 つの Node プロセス上で動く。

NanoClaw は同じコア機能を提供するが、コードベースは理解できるほど小さい:1 プロセスとわずかなファイルで構成される。Claude エージェントは独自の Linux コンテナで実行され、ファイルシステム分離が効く — 単なるパーミッションチェックの裏側ではない。

## クイックスタート

```bash
git clone https://github.com/nanocoai/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
bash nanoclaw.sh
```

`nanoclaw.sh` は、新しいマシンから名前付きエージェントへメッセージを送れる状態まで案内する。Node、pnpm、Docker が無ければインストールし、OneCLI に Anthropic クレデンシャルを登録し、エージェントコンテナをビルドし、最初の channel(Telegram / Discord / WhatsApp / ローカル CLI)をペアリングする。途中のステップが失敗した場合、Claude Code が自動的に呼ばれて診断し、止まった位置から再開する。

<details>
<summary><strong>NanoClaw v1 から移行したい?</strong></summary>

既存の v1 install の隣に、新しい v2 のチェックアウトを置いて実行する:

```bash
git clone https://github.com/nanocoai/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
bash migrate-v2.sh
```

`migrate-v2.sh` は v1 install を見つけ(隣接ディレクトリ、または `NANOCLAW_V1_PATH=/path/to/nanoclaw`)、状態を v2 チェックアウトに移行したのち、判断が必要な部分(owner シード、CLAUDE.local.md のクリーンアップ、fork カスタマイズの再適用)を仕上げるために Claude Code に `exec` で引き継ぐ。

このスクリプトは Claude セッション内からではなく直接実行すること — 決定的な部分は対話的なプロンプトと、Node/pnpm のブートストラップ、Docker、OneCLI、コンテナビルドのために実シェルの I/O を必要とする。

**何をするか:** `.env` をマージし、`registered_groups` から v2 DB を seed し、group フォルダ + セッションデータ + スケジュール済タスクをコピーし、選択した channel adapter をインストールし、channel の認証状態をコピーし(WhatsApp の Baileys keystore + LID マッピングを含む)、エージェントコンテナをビルドする。

**何をしないか:** システムサービスを切り替えない。プロンプトで *"switch to v2"* を選ぶか、テスト後に手動で切り替える — v1 install はそのまま残る。

何が違うかは [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md)、開発時の注意は [docs/migration-dev.md](docs/migration-dev.md) を参照。

</details>

## 設計哲学

**理解できるほど小さく。** 1 プロセス、いくつかのソースファイル、マイクロサービスなし。NanoClaw のコードベース全体を理解したくなったら、Claude Code に頼んで一緒にウォークスルーしてもらえばよい。

**分離によるセキュリティ。** エージェントは Linux コンテナで動き、明示的にマウントしたものしか見られない。コマンドはホストではなくコンテナの中で動くので、bash アクセスを許しても安全である。

**個人ユーザのために作る。** NanoClaw はモノリシックなフレームワークではない;各ユーザの正確なニーズに合わせるソフトウェアである。肥大化する代わりに、NanoClaw は誂え(bespoke)を前提に作られている。自分の fork を作り、Claude Code に手を入れさせて自分のニーズに合わせる。

**カスタマイズ = コード変更。** 設定ファイルの肥大はない。振る舞いを変えたい? コードを書き換える。コードベースは変更が安全なほど小さい。

**AI ネイティブ、設計上ハイブリッド。** インストールとオンボーディングのフローは、最適化された決定的スクリプトのパスで、速くて確実。判断が必要なステップ — インストール失敗、誘導付きの判断、カスタマイズ — に来たら、制御は Claude Code にシームレスに渡される。セットアップ以外でも、監視ダッシュボードやデバッグ UI は存在しない:問題はチャットで説明すれば Claude Code が対応する。

**機能ではなくスキル。** Trunk が出荷するのはレジストリとインフラであり、特定の channel adapter や代替の agent provider ではない。Channels(Discord、Slack、Telegram、WhatsApp 等)は長命の `channels` ブランチに置かれ、代替 provider(OpenCode、Ollama)は `providers` ブランチに置かれる。`/add-telegram`、`/add-opencode` 等を実行すると、skill が必要なモジュールだけを fork にコピーする。頼んでいない機能は付いてこない。

**最良の harness、最良のモデル。** NanoClaw は Anthropic 公式の Claude Agent SDK 経由で Claude Code をネイティブに使うので、最新の Claude モデルと Claude Code の全ツール — 自身の NanoClaw fork を修正・拡張する機能を含む — を使える。他の provider はドロップイン式の選択肢:`/add-codex` は OpenAI の Codex(ChatGPT サブスクリプションまたは API キー)、`/add-opencode` は OpenRouter / Google / DeepSeek 等を OpenCode 経由、`/add-ollama-provider` はローカルの open-weight モデル。Provider は agent group ごとに設定可能である。

## サポートしているもの

- **マルチチャネルメッセージング** — WhatsApp、Telegram、Discord、Slack、Microsoft Teams、iMessage、Matrix、Google Chat、Webex、Linear、GitHub、WeChat、Resend 経由のメール。`/add-<channel>` skill でオンデマンドにインストール。複数を同時に走らせてよい。
- **柔軟な分離** — 各 channel を独自の agent に接続して完全プライバシー、複数 channel で 1 つの agent を共有して統一メモリ + 会話分離、複数 channel を 1 つの共有セッションにまとめて 1 つの会話が複数の場所をまたぐ、のいずれかを選べる。`/manage-channels` で channel ごとに選択する。[docs/isolation-model.md](docs/isolation-model.md) を参照。
- **agent ごとの workspace** — 各 agent group は自分の `CLAUDE.md`、自分のメモリ、自分のコンテナ、許可したマウントだけを持つ。配線しない限り境界を越えるものはない。
- **スケジュール済タスク** — 定期的に Claude を走らせ、結果をメッセージで返してくれる
- **Web アクセス** — Web の検索とコンテンツ取得
- **コンテナ分離** — エージェントは Docker(macOS / Linux / WSL2)でサンドボックス化、オプションで [Docker Sandboxes](docs/docker-sandboxes.md) によるマイクロ VM 分離、または macOS ネイティブのオプトインとして Apple Container を選べる
- **クレデンシャルセキュリティ** — エージェントは生の API キーを保持しない。アウトバウンドリクエストは [OneCLI's Agent Vault](https://github.com/onecli/onecli) を経由し、リクエスト時にクレデンシャルを注入し、agent ごとのポリシーとレート制限を強制する。

## 使い方

トリガーワード(デフォルト:`@Andy`)でアシスタントに話しかける:

```
@Andy 平日の朝 9 時に営業パイプラインの概要を送って(私の Obsidian vault フォルダにアクセス可)
@Andy 毎週金曜日に過去 1 週間の git 履歴をレビューし、ドリフトがあれば README を更新して
@Andy 毎週月曜の朝 8 時に Hacker News と TechCrunch から AI 関連ニュースをまとめてブリーフィングをメッセージして
```

自分が所有または管理する channel からは、group とタスクの管理ができる:
```
@Andy 全 group のスケジュール済タスクをリストして
@Andy 月曜のブリーフィングタスクを一時停止して
@Andy Family Chat group に参加して
```

## カスタマイズ

NanoClaw は設定ファイルを使わない。変更したいことは Claude Code に伝えるだけ:

- "トリガーワードを @Bob に変えて"
- "今後は応答を短く直接的にすることを覚えておいて"
- "おはようと言ったらカスタムの挨拶を返すようにして"
- "会話のサマリを毎週保存するようにして"

または、誘導付きの変更には `/customize` を実行する。

コードベースは Claude が安全に変更できるほど小さい。

## 貢献

**機能を追加しない。skill を追加する。**

新しい channel や agent provider を追加したい場合、trunk には追加しない。新しい channel adapter は `channels` ブランチに、新しい agent provider は `providers` ブランチに置く。ユーザは自分の fork で `/add-<name>` skill を使ってインストールする。skill は関連モジュールを標準パスにコピーし、登録を配線し、依存を pin する。

これにより trunk は純粋なレジストリとインフラに保たれ、各 fork は痩せたままになる — ユーザは頼んだ channel と provider だけを得て、それ以外は得ない。

### RFS (Request for Skills)

欲しい skill のリスト:

**通信チャネル**
- `/add-signal` — Signal を channel として追加する

## 動作要件

- macOS または Linux(Windows は WSL2 経由)
- Node.js 20+ と pnpm 10+(インストーラが無ければ入れる)
- [Docker Desktop](https://docker.com/products/docker-desktop)(macOS / Windows)または Docker Engine(Linux)
- [Claude Code](https://claude.ai/download) — `/customize`、`/debug`、セットアップ中のエラー回復、すべての `/add-<channel>` skill のために必要

## アーキテクチャ

```
messaging apps → host process (router) → inbound.db → container (Bun, Claude Agent SDK) → outbound.db → host process (delivery) → messaging apps
```

単一の Node host が、セッションごとの agent コンテナをオーケストレートする。メッセージが届くと、host はエンティティモデル(user → messaging group → agent group → session)を辿ってルーティングし、セッションの `inbound.db` に書き込み、コンテナを起こす。コンテナ内の agent-runner は `inbound.db` をポーリングし、Claude を走らせ、応答を `outbound.db` に書き込む。host は `outbound.db` をポーリングし、channel adapter 経由で返信する。

セッションごとに 2 つの SQLite ファイル、各ファイルにつき writer は厳密に 1 つ — クロスマウントの競合なし、IPC なし、stdin パイプなし。Channels と代替 provider は起動時に self-register する;上流 NanoClaw では trunk が出荷するのはレジストリと Chat SDK ブリッジのみで adapter 本体は fork ごとに skill でインストールするが、**biblio-claw では Slack adapter (`src/channels/slack.ts`) + Fugue channel adapter (`src/channels/fugue.ts`、M4-E で新設された同期 HTTP channel) を trunk に直接コミット済** (CLAUDE.md §チャネルと provider §biblio-claw 流の運用)。

アーキテクチャ完全版は [docs/architecture.md](docs/architecture.md)、3 レベルの分離モデルは [docs/isolation-model.md](docs/isolation-model.md) を参照。

主要ファイル:
- `src/index.ts` — エントリーポイント:DB 初期化、channel adapter、配信ポーリング、sweep
- `src/router.ts` — 受信ルーティング:messaging group → agent group → session → `inbound.db`
- `src/delivery.ts` — `outbound.db` をポーリング、adapter 経由で配信、システムアクションを処理
- `src/host-sweep.ts` — 60 秒の sweep:stale 検出、due メッセージのウェイク、再帰スケジュール
- `src/session-manager.ts` — セッションを解決、`inbound.db` / `outbound.db` をオープン
- `src/container-runner.ts` — agent group ごとのコンテナを起動、OneCLI でクレデンシャル注入
- `src/db/` — central DB(users、roles、agent groups、messaging groups、wiring、マイグレーション)
- `src/channels/` — channel adapter のインフラ(上流 NanoClaw では adapter は `/add-<channel>` skill でインストール / biblio-claw では Slack adapter + Fugue channel adapter (M4-E) を trunk に直接収録済み)
- `src/providers/` — host 側の provider 設定(`claude` は組み込み、他は skill 経由)
- `container/agent-runner/` — Bun の agent-runner:ポーリングループ、MCP ツール、provider 抽象化
- `groups/<folder>/` — agent group ごとのファイルシステム(`CLAUDE.md`、skill、コンテナ設定)

## FAQ

**なぜ Docker?**

Docker はクロスプラットフォームサポート(macOS、Linux、Windows は WSL2 経由)と成熟したエコシステムを提供する。macOS では、より軽量なネイティブランタイムのため `/convert-to-apple-container` で Apple Container に切り替えてもよい。追加の分離のために、[Docker Sandboxes](docs/docker-sandboxes.md) は各コンテナをマイクロ VM の中で動かす。

**Linux や Windows でも動かせるか?**

動かせる。Docker はデフォルトのランタイムで、macOS、Linux、Windows(WSL2 経由)で動く。`bash nanoclaw.sh` を実行するだけ。

**これは安全か?**

エージェントは、アプリケーションレベルのパーミッションチェックの裏側ではなく、コンテナの中で動く。明示的にマウントされたディレクトリにしかアクセスできない。クレデンシャルはコンテナに入らない — アウトバウンドの API リクエストは [OneCLI's Agent Vault](https://github.com/onecli/onecli) を経由し、proxy レベルで認証を注入し、レート制限とアクセスポリシーをサポートする。何を動かしているかは確認すべきだが、コードベースは実際に確認できるほど小さい。完全なセキュリティモデルは [security documentation](https://docs.nanoclaw.dev/concepts/security) を参照。

**なぜ設定ファイルがないのか?**

設定の肥大化を避けたい。各ユーザは、汎用システムを設定する代わりに、コードがちょうどやりたいことをするように NanoClaw をカスタマイズすべきである。設定ファイルがある方が好みなら、Claude に追加するように頼めばよい。

**third-party や open-source モデルは使えるか?**

使える。サポートされている経路は `/add-opencode`(OpenCode 設定経由で OpenRouter、OpenAI、Google、DeepSeek 等)または `/add-ollama-provider`(Ollama 経由のローカル open-weight モデル)。両方とも agent group ごとに設定可能なので、同じ install 内で異なる agent が異なるバックエンドで動かせる。

単発の実験用には、Claude API 互換のエンドポイントを `.env` 経由で使うこともできる:

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

**問題のデバッグはどうするか?**

Claude Code に聞く。「なぜ scheduler が走っていないのか?」「最近のログには何があるか?」「なぜこのメッセージに応答がないのか?」 これが NanoClaw の根幹にある AI ネイティブなアプローチである。

**セットアップが上手くいかないのはなぜか?**

ステップが失敗すると、`nanoclaw.sh` は Claude Code に引き継ぎ、診断と再開を行う。それで解決しない場合は、`claude` を起動して `/debug` を実行する。Claude が他のユーザにも影響しそうな問題を特定したら、該当するセットアップステップまたは skill に対して PR を出してほしい。

**コードベースに受け入れられる変更は何か?**

ベース設定に受け入れられるのはセキュリティ修正、バグ修正、明確な改善のみ。それだけである。

それ以外(新しい機能、OS 互換、ハードウェアサポート、エンハンスメント)はすべて、`channels` または `providers` ブランチに skill として貢献すべきである。

これにより、ベースシステムを最小に保ち、各ユーザが望まない機能を継承することなく、自分のインストールをカスタマイズできるようになる。

## コミュニティ

質問は? アイデアは? [Discord に参加してほしい](https://discord.gg/VDdww8qS42)。

## 変更履歴

破壊的変更は [CHANGELOG.md](CHANGELOG.md)、完全なリリース履歴は [ドキュメントサイトの changelog](https://docs.nanoclaw.dev/changelog) を参照。

## ライセンス

MIT

<img referrerpolicy="no-referrer-when-downgrade" src="https://static.scarf.sh/a.png?x-pxid=47894bd5-353b-42fe-bb97-74144e6df0bf" />
