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

# 下流の verify-phase-1-wiring.sh と出力ストリームを揃える (PR #6 レビュー code-simplifier 些細 #6)。
# 進捗行は stderr (= info) に統一。素の echo を使うと wrapper / 下流で stdout/stderr が混在し、
# CI などで「失敗時の情報」を stderr で拾うフローと相性が悪くなる。
# shellcheck source=scripts/onecli-lib.sh
. "${ROOT}/scripts/onecli-lib.sh"

info "=== static layer ==="
info "1/4 pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

info "2/4 typecheck (tsc --noEmit)"
pnpm exec tsc --noEmit

info "3/4 unit tests (vitest run)"
pnpm test

info "4/4 adapter factory resolution smoke"
pnpm exec tsx scripts/adapters-smoke.ts

info "=== wiring layer ==="
bash "${ROOT}/scripts/verify-phase-1-wiring.sh"

ok "verify-phase-1: 通過 (static + wiring 完全版)"
