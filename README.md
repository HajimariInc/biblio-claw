# biblio-claw

`biblio-shelf` プロジェクトの**司書実装リポジトリ**。[`nanocoai/nanoclaw`](https://github.com/nanocoai/nanoclaw) (NanoClaw v2, commit `2492259`, 2026-05-28) を fork し、Google Cloud (Vertex AI + GKE) 上で動作する司書 (biblio) として作り変えた。

> **ステータス**: M4-E Phase 1-6 まで完了済 — M2 北極星到達済 (patron 1 通の依頼で外部 biblio を棚に並べる経路が動く) + M3 Phase 1-5 完了 (装備機構 + 蔵書一覧 Slack feature) + init-project-gcp PRD 1-6 Phase 完了 (GKE 環境整備 + 観測 + slash command + Slack E2E verify、`M3 PASS (gke)` 取得済) + M4-A Phase 1-4 完了 (observability = OTel foundation + GenAI semconv + Cloud Logging→BQ sink + `scripts/verify-m4-a.sh` 統合検証、`M4-A PASS` 取得済) + M4-B Phase 0-4 完了 (adk-foundation + host-action-as-subagent + tool-routing-bridge + slack-e2e-and-verify-m4-b + remaining-host-actions-and-hitl = `AnthropicVertexLlm` tool routing 拡張 + CLI/Slack dispatcher 統合 (in-process ADK Runner 直結) + 9 `FunctionTool` (acquire/inspect/categorize/shelve/shelve_multi/list_biblio/update_config/enkin/shokyaku) + 破壊操作の HITL 承認機構統合、GKE `m4b-p4` deploy、`M4-B PASS` 取得済 = **M4-B PRD 完了判定成立**、PR #89 + #91 + #96 + #101 + #105 + #112) + **M4-E Phase 1-6 完了 (Fugue channel integration = 外部 AD (Fugue) → biblio-claw の同期 HTTP channel adapter (`src/channels/fugue*.ts`)、consult (蔵書検索) + equip (channel-scoped HITL 政策) の 2 endpoint、2 段 trace 構造 + AD の本義契約、GKE Ingress + Cloud Endpoints DNS + Secret Manager で Prod 公開、`scripts/verify-fugue-channel.sh` (10 section、5 軸 × 2 環境) で validate、image tag `m4e-p5-2` = 実 deploy 3 回実施、PR #114 + #115 + #117 + #122 + #126 + #132)。**残るは Fugue チーム側 `verify-biblio-integration.sh` 合同 verify + シナリオ 1 デモ** (DEN さん HITL 実行待ち = M4-E PRD 完了判定成立の最終要件)**。OneCLI MITM injection の独立 bug ([#36](https://github.com/HajimariInc/biblio-claw/issues/36)) は PR #38/#40 (2026-06-24) で解消済 (= `pathPattern` 省略経路に確定)。
>
> - **PRD A 基盤**: GKE Autopilot (`biblio-prod`, asia-northeast1) 上で orchestrator StatefulSet が **Native sidecar 多コンテナ Pod** (initContainers: `fetch-pem` + `cloud-sql-proxy` + `onecli` / containers: `orchestrator` + `gh-token-rotator` + `vertex-token-rotator`) として稼働。OneCLI gateway / GH installation token / Vertex Bearer token / CA bundle はすべて Pod 内 sidecar + `ca-secret-sync` で自動投入され、起動コマンドは `kubectl apply -f k8s/` のみで完結する。Slack adapter は socket mode で接続成立 (A 案: orchestrator 統合)、agent は K8s Job として spawn され NetworkPolicy で egress 制限される。PVC + SQLite 永続化は boots カウンタで Pod 再作成跨ぎの monotonic increment を assertion (`scripts/verify-phase-m2-3.sh exit 0`)。
> - **PRD B marketplace**: 仕入れ → 検品 → カテゴライズ (Vertex × Claude Sonnet-4.6) → 棚リポへの draft PR 作成 までの E2E が完成。M2 完成判定 verify (`scripts/verify-m2.sh <owner/repo>`) で **M2 PASS** を取得。OneCLI secret は `pathPattern` 省略経路 (= `hostPattern=api.github.com` の全パスに GH App installation token を inject、issue #36 で 2026-06-24 確定) で運用。scope 最小化は **GH App installation の repo 限定** (= biblio-shelf + biblio-claw の 2 repo のみ install 済) で担保する (= token scope を超えた WRITE は GitHub 側で拒否、rate limit が authenticated 扱いに上がるだけで観察可能な漏洩リスクなし)。
> - **M3 装備機構 + 蔵書一覧**: 装備機構 (Phase 1-3 = 物理配置 / 司書自律呼び出し / 禁書・焼却の HITL 承認経路) + 蔵書一覧 Slack feature (Phase 4 = `@bot 蔵書` / `@bot 蔵書 biblio-dev` で棚の `marketplace.json` から全 / カテゴリ別 biblio 一覧を取得) まで完了。M9 (本体焼き込まない) は装備機構として継承。
> - **M4-A observability**: OTel foundation (OTLP HTTP + BatchSpanProcessor) + GenAI semconv (`gen_ai.*` 属性) + host span 計装 (`withBiblioActionSpan` 全 biblio action) + Cloud Logging → BigQuery sink (Terraform 管理、`scripts/verify-m4-a.sh` 統合検証) まで完了。span → BQ の trace_id 相関で cost attribution が SQL で可能、`M4-A PASS` 取得済。
> - **M4-B ADK 移行**: `@google/adk@1.3.0` + `@anthropic-ai/vertex-sdk` 経路を新設し、NanoClaw 素の Claude Agent SDK 経路と **opt-in で並走** (`container_configs.provider === 'adk'` の agent group のみ ADK 経由、既存 delivery 経路は温存、Phase 90 で routing-cleanup の go/no-go 判断予定)。root `LlmAgent({model: 'claude-sonnet-4-6'})` + 9 `FunctionTool` (acquire / inspect / categorize / shelve / shelve_multi / list_biblio / update_config / enkin / shokyaku) で LLM 自律 tool 呼出 + multi-turn round-trip 成立。破壊操作 (enkin / shokyaku) は `Context.requestConfirmation` 経由の HITL 承認カード配信機構統合、`scripts/verify-m4-b.sh` で `M4-B PASS` (9 section CLI 経由 E2E) 取得済 = M4-B PRD 完了判定成立。

## クイックスタート (biblio-claw, local)

**前提**:
- Node.js 24.13+ / pnpm / bun
- Docker Desktop または Docker Engine
- gcloud CLI + ADC ログイン済 (`gcloud auth application-default login --project hajimari-ai-hackathon-2026`)
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

## GKE 運用メモ (デプロイ後の bootstrap / メンテ)

> ⚠️ **暫定セクション** — 日常運用の早見表は [`docs/operations-runbook.md`](docs/operations-runbook.md) に集約済。本セクションは初回デプロイ + 再構築時に **1 回だけ走らせる Bootstrap 手順** に絞って残置している。
>
> **完全再構築時の Bootstrap GRANT は `bash scripts/init-project-gcp-pgsql-grant.sh` (= PR #23 で公式化、`gcloud sql connect` + IAP 経由) が正本**。以下の K8s Pod + psql 手順は **参考残置** で、特に **「既存 DB を新 GSA で引き継ぐ場合」(後述) の role membership 継承 GRANT** は新スクリプトに含まれていないため、空でない DB の移行ケースでは下記手順を参照する。
>
> 完全 teardown 後の空 DB 再構築 (= 通常の reset → 再構築) は新スクリプトのみで完結する。リセット運用の全体像は [`docs/operations-runbook.md` §GKE リセット手順](docs/operations-runbook.md#gke-リセット手順) を参照。

### Cloud SQL `postgres` user パスワード変更 (初回 Bootstrap GRANT)

Cloud SQL `biblio-pgsql` を **IAM 認証 + Private IP only** (`--no-assign-ip` + `cloudsql.iam_authentication=on`) で運用するため、組み込み管理者 (`postgres` user) は通常パスワード未設定状態で放置する。

ただし PostgreSQL 15+ の `public` schema は新規 DB 作成直後の状態で IAM user (M2 PRD A Phase 3 以降は `biblio-orchestrator@hajimari-ai-hackathon-2026.iam`) が CREATE 権限を持たない (`pg_database_owner` 所有)。OneCLI 起動時の Prisma migrate が `ERROR: permission denied for schema public` で失敗するため、**初回デプロイ時に `postgres` user 経由で 1 回だけ GRANT を発行する**必要がある (Bootstrap GRANT)。

実行が必要なタイミング:
- 初回 GKE デプロイ (teardown 後の再構築含む)
- M5 提出後の本番再開時

> **前提 (Phase 3 で GSA を集約した実機検証で判明)**: OneCLI sidecar が cloud-sql-proxy の `--auto-iam-authn` で DB に IAM ログインするには、GSA `biblio-orchestrator@...` 側に次が揃っている必要がある。Bootstrap GRANT より**先に**済ませること:
> 1. `k8s/01-ksa.yaml` を apply して KSA `biblio-orchestrator-ksa` に WI annotation を付与 (これが無いと proxy が GSA 認証できず `cloudsql.instances.get 403` で GRANT が silent fail する)
> 2. GSA に `roles/cloudsql.client` **+ `roles/cloudsql.instanceUser`** の両方 (後者は IAM DB authn の **ログイン** に必須。`client` だけでは `Cloud SQL IAM service account authentication failed`)
> 3. Cloud SQL に IAM user 登録: `gcloud sql users create biblio-orchestrator@hajimari-ai-hackathon-2026.iam --instance=biblio-pgsql --type=CLOUD_IAM_SERVICE_ACCOUNT --project=hajimari-ai-hackathon-2026`

#### 手順

```bash
# 1. 一時パスワード生成 + postgres user に設定 (操作後すぐ別ランダム値で上書き = revoke)
PG_TEMP_PASS=$(openssl rand -base64 32)
gcloud sql users set-password postgres \
  --instance=biblio-pgsql --password="$PG_TEMP_PASS" \
  --project=hajimari-ai-hackathon-2026

# 2. 短命 Bootstrap Pod (psql + cloud-sql-proxy) を立てて GRANT 実行
#    proxy は --auto-iam-authn で biblio-orchestrator GSA を使う (KSA annotation 経由)
cat <<YAML | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: db-grant-bootstrap
  namespace: biblio-claw
spec:
  serviceAccountName: biblio-orchestrator-ksa
  restartPolicy: Never
  containers:
    - name: psql
      image: postgres:18-alpine
      command:
        - sh
        - -ec
        - |
          for i in 1 2 3 4 5 6 7 8 9 10; do nc -z 127.0.0.1 5432 && break; sleep 2; done
          PGPASSWORD="\$PG_TEMP_PASS" psql -h 127.0.0.1 -U postgres -d biblio_onecli \
            -c 'GRANT CREATE, USAGE ON SCHEMA public TO "biblio-orchestrator@hajimari-ai-hackathon-2026.iam";'
          echo GRANT_OK
      env:
        - name: PG_TEMP_PASS
          value: "$PG_TEMP_PASS"
    - name: cloud-sql-proxy
      image: gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.16.0
      args: ["--auto-iam-authn", "--private-ip", "--port=5432", "hajimari-ai-hackathon-2026:asia-northeast1:biblio-pgsql"]
YAML

# 3. 完了確認 (GRANT + GRANT_OK の 2 行) + Pod 削除
kubectl wait pod/db-grant-bootstrap -n biblio-claw \
  --for=jsonpath='{.status.containerStatuses[?(@.name=="psql")].state.terminated.exitCode}'=0 \
  --timeout=120s
kubectl logs db-grant-bootstrap -n biblio-claw -c psql
kubectl delete pod db-grant-bootstrap -n biblio-claw

# 4. postgres password を別のランダム値で上書き = 運用者も値を知らない状態に
gcloud sql users set-password postgres \
  --instance=biblio-pgsql \
  --password="$(openssl rand -base64 32)" \
  --project=hajimari-ai-hackathon-2026
unset PG_TEMP_PASS

# 5. orchestrator StatefulSet を rollout → onecli sidecar の Prisma migrate 成功を確認
#    (Phase 3 で OneCLI は orchestrator Pod の Native sidecar に統合された)
kubectl rollout status statefulset/biblio-orchestrator -n biblio-claw --timeout=300s
kubectl logs biblio-orchestrator-0 -n biblio-claw -c onecli --tail=30 \
  | grep -E "(No pending migrations|gateway ready|Ready in)"
```

> **既存 DB を新 GSA で引き継ぐ場合 (= Phase 3 移行のような、空でない DB に GSA を切り替えるケース)**: 上記 schema GRANT だけでは既存テーブル (`_prisma_migrations` 等、旧 `biblio-onecli` 所有) にアクセスできず migrate が `permission denied for table _prisma_migrations` で落ちる。Step 2 の psql に次の role membership 継承も追加する (新 user が旧 user の全資産を継承):
> ```sql
> GRANT "biblio-onecli@hajimari-ai-hackathon-2026.iam" TO "biblio-orchestrator@hajimari-ai-hackathon-2026.iam";
> ```
> teardown 後の**完全再構築 (空 DB)** では全テーブルを `biblio-orchestrator` が新規作成するため、この role membership は不要。

#### security 上の注意

- 一時パスワードは「生成 → 使用 → 別ランダム値で上書き」の流れで運用者の手元にも残さない設計 (Step 1 → Step 4)
- Step 4 の overwrite で実質的に `postgres` user は無効化される (運用は IAM 認証経路のみ)
- `gcloud sql users delete postgres` は built-in 制約で削除不可、上書きで対処
- teardown 時は Cloud SQL インスタンスごと削除されるため別途 cleanup 不要
- 本手順で発行する一時パスワードは Cloud SQL に対する administrator credentials なので、実行ログ・shell 履歴・スクリーンショット等への流出に注意

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
