# OneCLI v1.30.0 対応 — 改変計画 (PLAN)

> Task 4 で nanoclaw-src/ の OneCLI 連携箇所を棚卸ししてここに書き出した。Task 5 で本ファイルに沿って改変を当て、差分を `onecli-v1.30.0.patch` に抽出する。

## 前提 (PoC-2/12 で確定)

- OneCLI image: `ghcr.io/onecli/onecli:1.30.0` (固定、変更不可)
- REST API base: `http://localhost:10254/v1`
- MITM proxy: `http://localhost:10255` (NanoClaw container は `HTTPS_PROXY` 経由でここを叩く)
- CA: 同 Pod 内 shared volume で `/etc/ssl/certs/onecli-ca.pem` に mount → NanoClaw 側は `NODE_EXTRA_CA_CERTS` で信頼
- Secret store: `type: generic` + `injectionConfig: { authorization: "Bearer {value}" }` パターン
- 認証は WIF (keyless ADC)。SA 鍵不発行。

## 棚卸し結果 (本家の現状)

NanoClaw v2 (`_vendor/nanoclaw` HEAD `2492259`) は **Host (Node + pnpm) + per-session Container (Bun) の二層** で動く。Host が `src/container-runner.ts:407-465` の `buildContainerArgs` で `docker run` を組み立て、その中で agent-runner (`container/agent-runner/src/`) が Claude Agent SDK を走らせる。OneCLI gateway はホスト常駐 (`setup/onecli.ts:108` で `ONECLI_GATEWAY_VERSION=1.23.0` を docker-compose 経由で install)、secret は `setup/auth.ts:93-114` で `--type anthropic --host-pattern api.anthropic.com` 固定。HTTPS_PROXY 注入は `src/container-runner.ts:429` の `onecli.applyContainerConfig(args, ...)` (SDK 経由) が docker args に `-e HTTPS_PROXY=...` と CA bind mount を追加する作法。

ただし `setup/auto.ts:872-928` (`runCustomEndpointAuth`) には既に **「`--type generic --header-name Authorization --value-format 'Bearer {value}'` で任意ホスト向けに secret を作る」分岐** が実装されており、`ANTHROPIC_BASE_URL` を Vertex の Anthropic endpoint に向ければ Claude Agent SDK が Vertex×Claude に経路を変える設計になっている。PoC-5 は host setup フローを使わずこの注入経路だけを Pod 起動側 (`scripts/secret.sh`) で再現する方針。

## 改変ポイント (Task 5 で当てる)

- **二層構造を捨てて agent-runner 単体実行する最小エントリ** (`nanoclaw.sh` をバイパスし PoC 専用ラッパー追加)
  - 現状: `nanoclaw.sh:23-` はホスト setup (`pnpm install` → `pnpm run setup:auto`) の入り口で、本番は Host が `src/container-runner.ts` から `docker run` で per-session container を立てる。
  - 改変後: Pod の ENTRYPOINT は `nanoclaw.sh` ではなく、Claude Agent SDK の `query()` を `prompt='Reply with exactly the token: BIBLIO_POC5_OK'` で 1 回呼んで stdout に出して exit する PoC 専用ラッパー (`scripts/poc5-1turn.ts` or 同等を `nanoclaw-src/` 配下に追加)。session DB / channel adapter / messaging_groups などはスコープ外 (PoC-13 で扱う)。
  - 根拠: PRD §3 「Pod Ready + 1 turn 推論で `BIBLIO_POC5_OK` 取得」が合格条件。GKE Autopilot で docker-in-docker は使えないので Host コードはそもそも spawn 不能 (`src/container-runner.ts:6` の `execSync, spawn` 系を経由しない)。

- **OneCLI gateway installer をスキップ、sidecar 1.30.0 reuse 経路を固定** (`setup/onecli.ts` 全体を経由しない)
  - 現状: `setup/onecli.ts:108` の `ONECLI_GATEWAY_VERSION = '1.23.0'` が docker-compose installer をホストで走らせる。`setup/onecli.ts:353-389` の `--reuse` mode は CLI バイナリから `api-host` を取得して `.env` に書く前提だが、PoC では CLI 自体を入れない。
  - 改変後: Pod manifest で nanoclaw container env に `ONECLI_URL=http://localhost:10254` をハードコード固定。CLI バイナリ install は行わない。`setup:auto` フローは PoC では一切呼ばない (Dockerfile の ENTRYPOINT に組み込まない)。
  - 根拠: PRD §Constraints「OneCLI バージョンを変えない (`ghcr.io/onecli/onecli:1.30.0`)。NanoClaw 側を改変して追従する。」/ PoC-2/12 で REST `localhost:10254/v1` + MITM proxy `localhost:10255` を確定済。

- **secret 投入を type=anthropic ではなく type=generic + Vertex host 用に切り替え** (`setup/auth.ts:93-114` を bypass、`scripts/secret.sh` を PoC-2/12 から写経)
  - 現状: `setup/auth.ts:createAnthropicSecret` は `--type anthropic --host-pattern api.anthropic.com` で固定。`setup/auto.ts:888-906` の generic + Bearer 経路は `NANOCLAW_ANTHROPIC_BASE_URL` + `NANOCLAW_ANTHROPIC_AUTH_TOKEN` env が両方セットされたときだけ走る (CLI install 必須)。
  - 改変後: `scripts/secret.sh` (Task 8 で作成、PoC-2/12 写経) で `kubectl port-forward` 経由 OneCLI REST に直接 `POST /v1/secrets` (`type:generic` / `host:aiplatform.googleapis.com` / `injectionConfig:{authorization: "Bearer {value}"}`)。GH App token も同様に PoC-4 写経で PATCH 経路を整える (Task 11)。
  - 根拠: PRD §Architecture「Vertex 用 Bearer token (フレッシュ ADC / ~1h、本 PoC では起動時投入で OK)」 / PRD §Third-Party Integrations の Vertex endpoint。

- **Claude Agent SDK の宛先を Vertex × Claude (`claude-sonnet-4-6`) に向ける env 配線** (`container/agent-runner/src/providers/claude.ts:399-427` の `sdkQuery` 呼び出しに渡す env / model)
  - 現状: `container/agent-runner/src/providers/claude.ts` は `@anthropic-ai/claude-agent-sdk` の `query()` を呼び、`options.model` と `options.env` をそのまま SDK に渡す。`src/providers/claude.ts:20-28` (host 側) は `.env` の `ANTHROPIC_BASE_URL` を container env に伝搬する仕組みだが、host 側を bypass する PoC では効かない。
  - 改変後: Pod manifest で nanoclaw container に `ANTHROPIC_VERTEX_PROJECT_ID=<your-gcp-project-id>` / `CLOUD_ML_REGION=global` / `CLAUDE_CODE_USE_VERTEX=1` / `ANTHROPIC_MODEL=claude-sonnet-4-6` 相当 (Vertex Anthropic SDK 流儀) を投入。PoC ラッパー (改変点 1) で `new ClaudeProvider({ model: 'claude-sonnet-4-6' }).query({ prompt, cwd })` を呼ぶ最小コードに帰着させる。`HTTPS_PROXY=http://localhost:10255` + `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/onecli-ca.pem` の到達経路は env レイヤーで吸収。
  - 根拠: PRD §Tech Stack「Vertex×Claude: `aiplatform.googleapis.com` (location=`global`) / model = `claude-sonnet-4-6`」 / `setup/auto.ts:888-906` の generic+Bearer パターンが Vertex でも有効である裏付け。

- **Dockerfile を PoC 用に再構成** (PoC repo 直下に新規 `Dockerfile`、`container/Dockerfile` をベースに COPY スコープを縮小)
  - 現状: `container/Dockerfile` は agent-runner deps + Claude Code CLI + chromium + agent-browser まで盛り込んだ「フル機能 agent container」image。Bun が PID 1 で `entrypoint.sh` を tini 経由で起動。
  - 改変後: PoC repo 直下に新規 `Dockerfile` を作成し、`FROM node:22-slim` から bun + claude-code CLI + `nanoclaw-src/container/agent-runner/` + `nanoclaw-src/src/providers/` + PoC ラッパー (改変点 1) だけを COPY。chromium / agent-browser は外す (PoC-5 スコープ外)。OneCLI CA pem は run-time に shared volume で受け取るので image には焼かない (env `NODE_EXTRA_CA_CERTS` で参照のみ)。
  - 根拠: PRD §Tech Stack の Artifact Registry image tag (`biblio-poc5/nanoclaw:0.1.0`) / PRD §Architecture「container: nanoclaw (改変済 image / HTTPS_PROXY=localhost:10255 / CA mount)」。
