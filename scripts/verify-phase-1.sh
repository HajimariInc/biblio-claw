#!/usr/bin/env bash
#
# Phase 1 verify — 完全版 (static + wiring を順次実行する wrapper).
#
# Static layer (本スクリプト内):
#   1. deps install (frozen lockfile)
#   2. typecheck (tsc --noEmit)
#   3. unit tests (vitest)
#   4. 3-factory resolution smoke (getDsnProvider / getSchedulerProvider /
#      getSecretProvider resolve to their local/onecli defaults)
#
# Wiring layer (scripts/verify-phase-1-wiring.sh 経由):
#   docker compose 起動 / OneCLI REST 疎通 / Vertex secret / GH secret / provider 配線 など。
#   wiring 側で前提 (compose 起動 + 各 secret 投入済) が未達なら fail を返す。
#
# set -euo pipefail を継承するため wiring が exit 1 を返したら本 wrapper も exit 1。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[verify-phase-1] === static layer ==="
echo "[verify-phase-1] 1/4 pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

echo "[verify-phase-1] 2/4 typecheck (tsc --noEmit)"
pnpm exec tsc --noEmit

echo "[verify-phase-1] 3/4 unit tests (vitest run)"
pnpm test

echo "[verify-phase-1] 4/4 adapter factory resolution smoke"
pnpm exec tsx scripts/adapters-smoke.ts

echo "[verify-phase-1] === wiring layer ==="
bash "${ROOT}/scripts/verify-phase-1-wiring.sh"

echo "[verify-phase-1] OK (static + wiring 完全版)"
