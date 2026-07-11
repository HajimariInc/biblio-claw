# biblio-claw

AI エージェント向けの skill を棚に並べる**司書**実装。[NanoClaw v2](https://github.com/nanocoai/nanoclaw) (上流 commit `2492259`, 2026-05-28) を fork し、Google Cloud (Vertex AI + GKE) 上で動作する司書として作り変えた。2026 年夏の **DevOps × AI Agent Hackathon** (Finals 2026-08-19 @ Google 渋谷) 作品。

## 上流との関係

biblio-claw は **[nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw)** (NanoClaw v2、上流 commit `2492259`、2026-05-28) を fork した司書実装リポジトリ。上流由来のドキュメント (日本語訳を含む) は `docs/` 配下に参考として残置し、biblio-claw 独自の拡張は `CLAUDE.md` §ドキュメント索引 + `docs/glossary.md` (biblio 独自語彙集) から辿れる。

- **上流由来 doc の参考リンク集**: [`docs/README.md`](docs/README.md)
- **biblio-claw 独自 doc の索引**: [`CLAUDE.md`](CLAUDE.md#ドキュメント索引)
- **biblio 独自語彙** (biblio / 司書 / patron / 装備 / 禁書 / 焼却 等) **の解説**: [`docs/glossary.md`](docs/glossary.md)
- **アーキテクチャ図**: [`docs/architecture-diagram.md`](docs/architecture-diagram.md) (GitHub 上で Mermaid が自動 render される)

### 姉妹プロジェクトとの連携

biblio-claw は姉妹プロジェクト **[Fugue](https://github.com/TairaNozawa/fugue)** (画面共有 × マルチエージェント会議のデスクトップアプリ) からの channel 連携を受け入れる。詳細は [`docs/setup-wiring.md`](docs/setup-wiring.md) を参照。

> **機能ハイライト**:
>
> - **司書ワークフロー** — 仕入れ → 検品 → カテゴライズ → 陳列 の E2E + 装備 / 蔵書一覧 / 禁書 / 焼却 (破壊操作は HITL 承認)
> - **セキュアな実行** — session ごとの container 分離 + OneCLI Vault + Workload Identity Federation で生 token を持たない agent
> - **channel integration** — Slack (bot / DM) + Fugue 同期 HTTP (consult / equip / ask endpoint)
> - **生活機能** — Web 検索 (Tavily) + Google Drive 読み取り (agent-container 経路、gate 4 層通過)
> - **観測性 + UX** — OpenTelemetry + Cloud Trace + BigQuery sink の 1 trace 串刺し + Slack 進行ステート表示

## 設計原則

biblio-claw は上流 NanoClaw から以下の 5 原則を継承する。

- **理解できるほど小さく** — trunk 直コミット主義で small に保つ。コードベース全体を Claude Code と一緒にウォークスルーできる規模
- **分離によるセキュリティ** — エージェントは Linux コンテナで動き、明示的にマウントしたものしか見えない。ホストではなくコンテナの中でコマンドを走らせる
- **個人ユーザのために作る** — bespoke な fork を前提。汎用フレームワークではなく、各ユーザのニーズに合わせて変形する
- **カスタマイズ = コード変更** — 設定ファイルの肥大はない。振る舞いを変えたいならコードを書き換える。変更が安全なほどコードが小さい
- **AI ネイティブ、設計上ハイブリッド** — インストールとオンボーディングは決定的スクリプトで高速確実に、判断が要るステップは Claude Code にシームレスに引き渡す

## クイックスタート (biblio-claw local)

**前提**:

- Node.js 24.13+ / pnpm / bun
- Docker Desktop または Docker Engine
- gcloud CLI + ADC ログイン済 (`gcloud auth application-default login --project <your-gcp-project>`)
- `.env` 投入 — `.env.example` を雛形に `ANTHROPIC_VERTEX_PROJECT_ID` / `GH_APP_ID` / `GH_INSTALLATION_ID` / `GH_APP_PEM_PATH` / `SLACK_BOT_TOKEN` / `SHELF_REPO_OWNER` 等を手動で埋める

**セットアップ**: セットアップは **NanoClaw 上流に準拠**。biblio-claw 固有の上乗せ (Slack / Fugue / Vertex×Claude / GKE) は下記の docs/ を参照する。

- 上流セットアップフロー: [`docs/setup-flow.md`](docs/setup-flow.md)
- biblio-claw の `/init-project` skill (新規 setup 一気通貫): `.claude/commands/init-project.md`
- Slack 2 環境分離 (本番 ws / 開発 ws) の App セットアップ: [`docs/slack-environments-setup.md`](docs/slack-environments-setup.md)
- Fugue との配線: [`docs/setup-wiring.md`](docs/setup-wiring.md)

**起動**:

```bash
cp .env.example .env       # 既存があれば skip、値は手動で埋める
# claude code から /init-project を実行 (.env 準備 → docker compose →
# deps install → host agent 登録 → token 投入 → コンテナ build → smoke verify)
pnpm run dev               # host process を起動 (foreground、Slack adapter 接続)
pnpm run chat "hello"      # smoke 用 CLI から司書と会話
```

## 日常運用 / GKE 運用

日常運用 / リセット / トラブルシューティングは [`docs/operations-runbook.md`](docs/operations-runbook.md) を参照 (冒頭の目次から 4 象限 = 大原則 / 日常運用 / Milestone 別 / その他 に降りられる)。Cloud SQL の初回 GRANT は `bash scripts/init-project-gcp-pgsql-grant.sh` で 1 発、空でない DB を新 GSA で引き継ぐケースは runbook の「既存 DB を新 GSA で引き継ぐ場合の role membership 継承 GRANT」節を参照。

**よくハマる落とし穴** (詳細は runbook の各 anchor から):

- [OneCLI MITM が tunnel mode で素通しになる](docs/operations-runbook.md#落とし穴-onecli-mitm-が-tunnel-mode-で素通しになる) — 認証注入がスキップされて Vertex 呼び出しが 401 で落ちる
- [OneCLI pathPattern を string で明示すると GKE で injection skip (issue #36)](docs/operations-runbook.md#落とし穴-onecli-pathpattern-を-string-で明示すると-gke-で-injection-skipissue-36) — DELETE + POST 再作成手順
- [Vertex 401 ACCESS_TOKEN_EXPIRED retry loop](docs/operations-runbook.md#vertex-401-access_token_expired-retry-loop-の対症手順) — token rotator 経路の詰まり調査
- [Pending Pod (GKE、issue #57)](docs/operations-runbook.md#pending-pod-の対症手順-gke-経路issue-57) — K8s Job spawn がハングした際の kill 手順

## アーキテクチャ

- **完全版**: [`docs/architecture.md`](docs/architecture.md)
- **図版**: [`docs/architecture-diagram.md`](docs/architecture-diagram.md)
- **3 レベルの channel 分離モデル**: [`docs/isolation-model.md`](docs/isolation-model.md)
- **実装ファイルの署名一覧**: [`CLAUDE.md`](CLAUDE.md#主要ファイル) §主要ファイル

上流 NanoClaw では channel adapter は `/add-<channel>` skill でインストールする方式 (`channels` ブランチから選択) だが、**biblio-claw では Slack adapter (`src/channels/slack.ts`) + Fugue channel adapter (`src/channels/fugue.ts`、M4-E で新設) を trunk に直接コミット**している (詳細は CLAUDE.md §チャネルと provider)。

## カスタマイズ

biblio-claw は上流 NanoClaw を継いで設定ファイルを使わない。変更したいことは司書 (Claude Code) に伝えるだけ:

- 「@司書 が Slack で答えるトーンを丁寧にして」
- 「MEMORY にこの preference を追記して覚えて」
- 「shelve の PR body に警告文を 1 行追加して」

コードベースは Claude が安全に変更できるほど小さい。

## FAQ

**これは安全か?**

エージェントは container の中で動き、クレデンシャルは container に入らない。アウトバウンドの API リクエストは [OneCLI Agent Vault](https://github.com/onecli/onecli) 経由で proxy レベルに認証を注入する。biblio-claw ではさらに Vertex への認証を **Workload Identity Federation** (SA キー不要) で成立させ、GitHub App / Slack トークンは Secret Manager + Sidecar rotation で管理する。完全なセキュリティモデルは [`docs/SECURITY.md`](docs/SECURITY.md) を参照。

**なぜ設定ファイルがないのか?**

上流 NanoClaw と同じ、設定の肥大化を避けたいから。biblio-claw もこの原則を継承していて、変えたいことはコードを直接変える小ささを保ちつづける。設定ファイルがある方が好みなら、Claude に追加するように頼めばよい。

## 貢献

biblio-claw は 2026 の DevOps × AI Agent Hackathon 向けの fork。**外部貢献は当面受け付けていない**。上流 NanoClaw への貢献は [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw) へ。詳細は [`CONTRIBUTING.md`](CONTRIBUTING.md) を参照。

## 変更履歴

破壊的変更 + biblio-claw fork の Milestone 進捗は [`CHANGELOG.md`](CHANGELOG.md) を参照 (冒頭の `[biblio-claw-*]` セクション)。上流 NanoClaw 側のリリースは同じ CHANGELOG の `[2.x.x]` セクション、または上流 [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw) を参照。

## ライセンス

MIT。詳細は [`LICENSE`](LICENSE) を参照。上流 NanoClaw の Copyright を継承しつつ、biblio-claw fork の Copyright は HajimariInc + biblio-claw contributors が保持する 2-copyright 型 (lodash 型)。
