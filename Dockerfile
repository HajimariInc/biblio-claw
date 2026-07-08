# biblio-claw host (NanoClaw orchestrator) image。
#
# 開発初期は host = `pnpm run dev` で host OS 直接実行のため image 未整備
# (NanoClaw 上流の運用方式)。本 Dockerfile を新設して、同じ image を:
#   - Local: docker run で起動 → env (DSN_PROVIDER=local) で local FS パス解決
#   - GKE:  k8s/10-orchestrator-statefulset.yaml が pull → env (DSN_PROVIDER=gke)
#          で /data (PVC mountPath) 解決
# として動かす。「アプリ image SHA 不変、env で環境差分吸収」が本 image の設計原則。
#
# Build:
#   docker build -t biblio-claw:<image-tag> .
# AR push:
#   docker tag biblio-claw:<image-tag> asia-northeast1-docker.pkg.dev/<your-gcp-project>/biblio-claw/biblio-claw:<image-tag>
#   docker push asia-northeast1-docker.pkg.dev/<your-gcp-project>/biblio-claw/biblio-claw:<image-tag>
#
# Local 検証 (DSN_PROVIDER=local):
#   docker compose up -d --wait   # postgres + onecli を先に起動
#   docker run --rm -it \
#     --network biblio-claw_biblio \
#     -v biblio-claw-data:/data \
#     -e DSN_PROVIDER=local -e DATA_DIR=/data \
#     -e ONECLI_URL=http://biblio-onecli:10254 \
#     -e ASSISTANT_NAME=biblio \
#     -e ANTHROPIC_VERTEX_PROJECT_ID=<your-gcp-project> \
#     -e CLOUD_ML_REGION=global -e CLAUDE_CODE_USE_VERTEX=1 \
#     biblio-claw:<image-tag>
#
# 構成:
#   - base: node:24-slim (engines.node >= 24.13.0、Node 24 LTS 前提、
#           `@google/adk@^1.3.0` + `better-sqlite3@12.x` (Node 24 prebuilt binary 対応) 前提)
#   - tools: git (group-init で参照される可能性) / ca-certificates (HTTPS)
#   - pnpm: corepack で `packageManager: pnpm@10.33.0` を有効化
#   - dependencies: pnpm install --frozen-lockfile
#     (pnpm-workspace.yaml の minimumReleaseAge + onlyBuiltDependencies で
#      better-sqlite3 等のネイティブ build もここで実行)
#   - build: tsc (rootDir: ./src → outDir: ./dist)
#   - runtime: scripts/ (host から呼ばれる onecli-*.sh / sign_jwt.cjs 等) +
#     空 groups/ (host が listing するだけ、install 固有 state は image に焼かない)

FROM node:24-slim

WORKDIR /app

# 余分な APT cache を残さない (image サイズ最適化)。
# jq は scripts/onecli-*-secret.sh が JSON payload 組立/解析に使う。
# 従来は sidecar rotator image 内でのみ実行されていたため orchestrator に未 install だったが、
# Tavily secret 投入は orchestrator container 内で走らせる必要があるため恒久化。
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# === GitHub CLI (= debug 用 + 将来互換のため残置。acquire.ts の存在確認は
#     ghFetch (undici fetch + OneCLI MITM) 経路に移行済のため、runtime では
#     gh の子プロセス経路を使わない。getChildProcEnv() (host-proxy.ts) は
#     git clone 子プロセスに HTTPS_PROXY + SSL_CERT_FILE + GIT_SSL_CAINFO を
#     動的 inject するため、Dockerfile / manifest 側で ENV 設定は不要) ===
ARG GH_CLI_VERSION=2.95.0
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_amd64.tar.gz" \
      -o /tmp/gh.tar.gz \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && install -m 0755 "/tmp/gh_${GH_CLI_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
    && rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_CLI_VERSION}_linux_amd64"

# pnpm を corepack 経由で有効化。package.json の packageManager フィールドと一致させる
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Lockfile から再現可能な dependencies install (frozen-lockfile)。
# pnpm-workspace.yaml の minimumReleaseAge: 4320 (3 日) と
# onlyBuiltDependencies: [better-sqlite3, esbuild, protobufjs, sharp] が effect する。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Source + tsconfig を copy → tsc compile (src/ → dist/)
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm run build

# Runtime で host プロセスが参照する可能性のある静的ファイル:
# - scripts/: onecli-*.sh, sign_jwt.cjs, onecli-lib.sh
#   (sidecar / vertex secret 投入 script 等)
# - groups/: 空 dir で作成。install 固有 state (cli-with-den 等) は image に焼かず、
#   runtime で PVC mount or 空のまま (agent spawn しない host image では問題ない)
COPY scripts/ ./scripts/
RUN mkdir -p ./groups

# M4-H Phase 5: init-fugue-ask-agent.ts が readFileSync するため system-prompts のみ selective COPY
# (container/ 全体は agent-runner image が別 build のため .dockerignore で exclude 維持)
COPY container/agent-runner/src/system-prompts/ ./container/agent-runner/src/system-prompts/

# === Runtime defaults ===
# DATA_DIR は env で上書き前提 (Local: /app/data、GKE: /data の PVC mountPath)
# DSN_PROVIDER / SCHEDULER_PROVIDER / SECRET_PROVIDER / ONECLI_URL も env で必ず指定する
ENV NODE_ENV=production
ENV DATA_DIR=/app/data

# host プロセスのエントリポイント (= NanoClaw main())
# `--import ./dist/instrumentation.js` で OTel SDK を main() より前に load
CMD ["node", "--import", "./dist/instrumentation.js", "dist/index.js"]
