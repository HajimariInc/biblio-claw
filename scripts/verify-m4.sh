#!/usr/bin/env bash
# biblio-claw: M4 統合検証 (M4 milestone 部分クローズ判定 = A + B + E)
#
# M4-A (observability) + M4-B (ADK integration) + M4-E (Fugue channel adapter) の 3 PRD を
# chain 実行して統合的な PASS/FAIL を判定する。M4-C (reporting) / M4-D (presentation-ui) は
# 未実装のため skip、A+B+E で M4 milestone の部分クローズ判定として扱う。
#
# 使い方:
#   bash scripts/verify-m4.sh
#     - Section 1: verify-m4-a.sh (M4-A observability = OTel + Cloud Logging→BQ sink)
#     - Section 2: verify-m4-b.sh (M4-B ADK integration + tool routing + HITL flow)
#     - Section 3: verify-fugue-channel.sh --prod (M4-E Fugue channel Prod-only)
#     - Section 4: (M4-C / M4-D は未実装、info のみ)
#     - 末尾 `M4 PARTIAL PASS (A+B+E)` + exit 0
#
# 前提: 各 chain script の前提を全部満たす:
#   - kubectl context = biblio-prod
#   - gcloud auth application-default login 済
#   - GCP_PROJECT_ID / BQ_DATASET_ID env 設定済
#   - Phase 5 実 apply 完了 (Fugue channel Prod deploy 済)
#   - orchestrator StatefulSet が M4-B/M4-E 実装含む image で動作中
#
# 所要時間: ~10-20 min (verify-m4-a ~5min + verify-m4-b ~5-10min + verify-fugue-channel --prod ~3-5min)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/verify-m3-helpers.sh
source "$(dirname "${BASH_SOURCE[0]}")/verify-m3-helpers.sh"

info '=== M4 統合 verify chain 開始 (A + B + E、C/D は未実装 skip) ==='

# =============================================================================
# Section 1: M4-A observability (OTel + Cloud Logging → BQ sink)
# =============================================================================
info '--- [1/4] M4-A observability (verify-m4-a.sh chain) ---'
bash scripts/verify-m4-a.sh
info '--- [1/4] M4-A PASS ---'

# =============================================================================
# Section 2: M4-B ADK integration + tool routing + HITL flow
# =============================================================================
info '--- [2/4] M4-B ADK integration (verify-m4-b.sh chain) ---'
bash scripts/verify-m4-b.sh
info '--- [2/4] M4-B PASS ---'

# =============================================================================
# Section 3: M4-E Fugue channel adapter (Prod-only、local 経路は個別に verify-fugue-channel.sh --local)
# =============================================================================
info '--- [3/4] M4-E Fugue channel (verify-fugue-channel.sh --prod chain) ---'
bash scripts/verify-fugue-channel.sh --prod
info '--- [3/4] M4-E PASS ---'

# =============================================================================
# Section 4: M4-C / M4-D は未実装 (M4 milestone 完成時に verify に追加)
# =============================================================================
info '--- [4/4] M4-C (reporting) + M4-D (presentation-ui) は未実装 skip ---'
info '  M4-C reporting: PRD 未起草 (M4 milestone 完成時に追加)'
info '  M4-D presentation-ui: PRD 未起草 (M4 milestone 完成時に追加)'

# =============================================================================
# PASS marker (A + B + E で M4 部分クローズ判定成立)
# =============================================================================
info '  all M4-A + M4-B + M4-E chain PASS'
echo 'M4 PARTIAL PASS (A+B+E)'
