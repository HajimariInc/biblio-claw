# syntax=docker/dockerfile:1.7
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation.
#
# Runtime split:
#   - agent-runner (our TypeScript code): Bun, mounted RO at /app/src by host
#   - globally-installed Node CLIs (claude-code, agent-browser, vercel): pnpm + Node
#
# biblio-claw deviation (M2 PRD A Phase 2): bake static sources into the image.
# Upstream NanoClaw mounts /app/src at runtime via hostPath so source edits don't
# trigger a rebuild. On GKE the K8sJobProvider drops hostPath mounts that don't
# start with /data/ (translateSpec, src/adapters/container/k8s.ts), so the only
# way agent Pods can see agent-runner / skills / container CLAUDE.md is to bake
# them in. Docker Compose keeps the runtime mount on top of the baked copy, so
# local dev sees edits without rebuilding — the bake is transparent there.

FROM node:22-slim

# ---- Build-time arguments ----------------------------------------------------
# CJK fonts add ~200MB. Opt in only if you render Chinese/Japanese/Korean text.
ARG INSTALL_CJK_FONTS=false

# Pin CLI versions for reproducibility. Bump deliberately — unpinned installs
# mean every rebuild silently picks up the latest and can break in lockstep
# across all users.
ARG CLAUDE_CODE_VERSION=2.1.128
ARG AGENT_BROWSER_VERSION=latest
ARG VERCEL_VERSION=52.2.1
ARG BUN_VERSION=1.3.12
ARG GH_CLI_VERSION=2.95.0
# tavily-mcp: Web 検索 MCP server (M4-F Phase 3、life-capabilities)。
# npm view tavily-mcp version で最新を確認、pnpm-workspace.yaml の
# `minimumReleaseAge: 4320` (3日) を超えた stable を pin する。
# 0.2.20 = 2026-05-29 リリース (実装時点 2026-07-05 で 5 週以上経過)。
ARG TAVILY_MCP_VERSION=0.2.20

# ---- System dependencies -----------------------------------------------------
# tini: correct PID 1 / signal forwarding so outbound.db writes finalize on
# SIGTERM instead of being orphaned by the shell entrypoint.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        libgbm1 \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libasound2 \
        libpangocairo-1.0-0 \
        libcups2 \
        libdrm2 \
        libxshmfence1 \
        ca-certificates \
        curl \
        git \
        jq \
        tini \
        unzip \
    && if [ "$INSTALL_CJK_FONTS" = "true" ]; then \
        apt-get install -y --no-install-recommends fonts-noto-cjk; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# Chromium path for agent-browser / Playwright consumers
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Belt-and-braces: prevent Playwright's postinstall from downloading its own
# ~300MB Chromium. We've already installed the system one above.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ---- Bun runtime -------------------------------------------------------------
# Install via the official script (handles multi-arch detection), then move
# the binary to /usr/local/bin so the non-root `node` user can execute it.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# ---- GitHub CLI -------------------------------------------------------------
# Agent コンテナ用途: Claude Agent SDK の Bash tool で `gh api` / `gh repo view`
# / `gh pr view` 等を自律実行する経路 (= biblio-claw / biblio-shelf 系 private
# repo を agent が直接読むケース)。host 側の acquire.ts spawnSync 経路は
# orchestrator container (./Dockerfile) で別途 install しているため、両 image とも
# gh CLI を持つ。
# Install via release tarball direct download (= apt repo 追加なしの最短経路、
# gh CLI 公式 docs/install_linux.md の "Other" 節準拠)。
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_amd64.tar.gz" \
      -o /tmp/gh.tar.gz \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && install -m 0755 "/tmp/gh_${GH_CLI_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
    && rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_CLI_VERSION}_linux_amd64"

# ---- OneCLI MITM trust ------------------------------------------------------
# gh CLI (Go バイナリ) は HTTPS_PROXY 経由で OneCLI proxy に接続する。OneCLI は
# api.github.com を MITM mode で扱い偽 cert を提示するため、cert trust を Go の
# crypto/x509 に解決させるには SSL_CERT_FILE で combined CA bundle を指定する。
# /etc/ssl/certs/onecli/onecli-combined-ca.pem は K8s Secret mount 経由で配備
# される (src/adapters/container/k8s.ts の translateSpec 内 OneCLI CA Secret
# volume mount ロジック)。
ENV SSL_CERT_FILE=/etc/ssl/certs/onecli/onecli-combined-ca.pem

# ---- OneCLI MITM 経由の gh CLI auth pre-check 回避 -------------------------
# gh CLI は wire request を送る前に client-side で auth state を確認するため、
# GH_TOKEN env も hosts.yml も空だと `gh auth login` を促して reject する。
# OneCLI proxy は wire 上の Authorization ヘッダを実 installation token に
# 完全上書き (= scripts/onecli-gh-secret.sh の valueFormat: "Bearer {value}")
# するため、ここでは pre-check を pass させる placeholder で十分。host 側
# `Bearer placeholder` 流儀 (src/biblio/shelf-gh.ts:118 等) と同根。
ENV GH_TOKEN=placeholder

# ---- agent-runner deps -------------------------------------------------------
# Deps are cached independently of CLI versions.
WORKDIR /app

COPY agent-runner/package.json agent-runner/bun.lock ./

# biblio-claw addition (M2 PRD A Phase 2): bake agent-runner src / skills /
# container CLAUDE.md before `bun install` so the install layer can resolve any
# source-side workspace refs. Compose hostPath mounts still win at runtime in
# local dev (transparent). See header comment for the K8s rationale.
COPY agent-runner/src/ /app/src/
COPY skills/           /app/skills/
COPY CLAUDE.md         /app/CLAUDE.md

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- pnpm + global Node CLIs -------------------------------------------------
# Most stable first, most frequently bumped last. Bumping claude-code
# (the most common change) only invalidates one layer.
#
# only-built-dependencies gates pnpm's supply-chain policy:
#   - agent-browser has a postinstall build step.
#   - @anthropic-ai/claude-code's postinstall downloads the native Claude
#     binary (linux-arm64 variant on our image). Without the allowlist
#     the SDK fails at spawn time with "native binary not found".
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Pin pnpm to match the host (package.json packageManager). pnpm 11 stopped
# honoring `only-built-dependencies[]=` in .npmrc for global installs, which
# silently skips claude-code's native-binary postinstall and agent-browser's
# bin chmod — the agent then crashes at runtime with "native binary not
# installed". Keep this in lockstep with package.json's `packageManager`.
ARG PNPM_VERSION=10.33.0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

RUN --mount=type=cache,target=/root/.cache/pnpm \
    echo "only-built-dependencies[]=agent-browser" > /root/.npmrc && \
    echo "only-built-dependencies[]=@anthropic-ai/claude-code" >> /root/.npmrc && \
    pnpm install -g "vercel@${VERCEL_VERSION}"

RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "agent-browser@${AGENT_BROWSER_VERSION}"

RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# ---- tavily-mcp (M4-F Phase 3、life-capabilities) ---------------------------
# Web 検索 MCP server (axios ベース、`NODE_EXTRA_CA_CERTS` 尊重)。
# runtime に `npx -y tavily-mcp` させると初回 npm registry pull で MCP 30s
# タイムアウトを踏むリスクがあるため事前焼き込みで解消。
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "tavily-mcp@${TAVILY_MCP_VERSION}"

# ---- Drive MCP server (M4-F Phase 3、life-capabilities) ---------------------
# 自作 stdio MCP server。Bun ではなく Node 22 で走らせる (oven-sh/bun#30381 の
# HTTPS-over-CONNECT-proxy バグ回避)。実 ADC token は持たず、
# `Authorization: Bearer placeholder` を OneCLI MITM proxy が実 token に置換する
# (詳細は container/mcp-servers/drive/README.md)。
COPY mcp-servers/drive /opt/mcp-servers/drive
RUN cd /opt/mcp-servers/drive \
    && npm install --omit=dev --no-audit --no-fund --loglevel=error

# ---- ncl CLI wrapper ----------------------------------------------------------
# Actual script lives in the mounted source at /app/src/cli/ncl.ts.
RUN printf '#!/bin/sh\nexec bun /app/src/cli/ncl.ts "$@"\n' > /usr/local/bin/ncl && \
    chmod +x /usr/local/bin/ncl

# ---- Entrypoint --------------------------------------------------------------
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- Equipped biblio install wrapper (M3 Phase 2) -----------------------------
# Spawn-time wrapper that loops /workspace/biblios/*/ and runs
#   claude plugin marketplace add → install --scope user → enable
# for each equipped biblio. Image carries the script; the equipped set is purely
# runtime (mounted under /workspace/biblios/), so an empty equipment list is a
# no-op. See docs/equip-physical.md and src/container-runner.ts buildContainerSpec
# (the spawn command chains '/app/install-biblios.sh && exec bun run …').
COPY install-biblios.sh /app/install-biblios.sh
RUN chmod 755 /app/install-biblios.sh

# ---- Workspace + permissions -------------------------------------------------
RUN mkdir -p /workspace/group /workspace/extra && \
    chown -R node:node /workspace && \
    chmod 777 /home/node

USER node
WORKDIR /workspace/group

# tini is PID 1, reaps zombies, forwards signals cleanly. entrypoint.sh does
# `exec bun ...` so bun runs as tini's direct child.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
