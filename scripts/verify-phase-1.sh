#!/usr/bin/env bash
#
# Phase 1 verify — C 折衷案 (partial skeleton, Task 2-X scope).
#
# Current asserts (abstraction-adapter layer):
#   1. deps install (frozen lockfile)
#   2. typecheck (tsc --noEmit)
#   3. unit tests (vitest)
#   4. 3-factory resolution smoke (getDsnProvider / getSchedulerProvider /
#      getSecretProvider resolve to their local/onecli defaults)
#
# TODO (Task 7+, next /prp-plan): append component-startup + connectivity
# asserts (docker compose up, OneCLI/Sidecar/Bolt reachability, Slack round
# trip) once the full local wiring lands.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[verify-phase-1] 1/4 pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

echo "[verify-phase-1] 2/4 typecheck (tsc --noEmit)"
pnpm exec tsc --noEmit

echo "[verify-phase-1] 3/4 unit tests (vitest run)"
pnpm test

echo "[verify-phase-1] 4/4 adapter factory resolution smoke"
pnpm exec tsx scripts/adapters-smoke.ts

echo "[verify-phase-1] OK"
