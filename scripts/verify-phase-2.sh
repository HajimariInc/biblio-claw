#!/usr/bin/env bash
# biblio-claw: Phase 2 verify wrapper (M1 完成判定)
#
# 2 段構成:
#   Level 1-2 (静的層): pnpm install + tsc + vitest (Phase 1 verify-phase-1.sh と同)
#   Level 3 (GKE wiring 層): scripts/verify-phase-2-wiring.sh を呼ぶ
#
# 本 script が exit 0 = Phase 2 完了 = M1 完成判定 (PRD §成功指標)。
#
# 前提:
#   - gcloud + kubectl + gke-gcloud-auth-plugin installed
#   - cluster credentials 取得済
#     (gcloud container clusters get-credentials biblio-prod --region=asia-northeast1)
#   - k8s/ 配下 manifest と Dockerfile.sidecar 用 image が AR に push + apply 済
#   - K8s Secret biblio-gh-app (+ biblio-slack-tokens) 投入済
#
# A 案 (plan §補足) で再解釈された Acceptance:
#   orchestrator + OneCLI + Sidecar 起動 + boots 永続化 + (任意) Slack 接続成立

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/onecli-lib.sh
. "${ROOT}/scripts/onecli-lib.sh"

info "==== Phase 2 verify (M1 完成判定) ===="

# === Level 1: STATIC_ANALYSIS ===
info "[L1] pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

info "[L1] tsc --noEmit"
pnpm exec tsc --noEmit

# === Level 2: UNIT_TESTS ===
info "[L2] vitest src/adapters/dsn (DSN unit test = LocalDsnProvider + GkeDsnProvider)"
pnpm test src/adapters/dsn

info "[L2] vitest src/boot-counter (boots カウンタ unit test)"
pnpm test src/boot-counter

info "[L2] vitest 全体 (Phase 1 regression check)"
pnpm test

# === Level 3: GKE WIRING ===
info "[L3] GKE wiring assertion (verify-phase-2-wiring.sh)"
bash "${ROOT}/scripts/verify-phase-2-wiring.sh"

ok "==== Phase 2 verify exit 0 = M1 完成判定 ✓ ===="
