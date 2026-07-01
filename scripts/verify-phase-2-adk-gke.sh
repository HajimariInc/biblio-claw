#!/usr/bin/env bash
# biblio-claw M4-B Phase 2 verify (GKE 経路) — orchestrator Pod 内で ADK Runner
# hierarchy + AnthropicVertexLlm tool routing が稼働することを確認する。
#
# 実行: bash scripts/verify-phase-2-adk-gke.sh
#
# 前提:
#   - kubectl context = biblio-prod
#   - StatefulSet biblio-orchestrator が READY=1
#   - image-sync 完了 (= image tag m4b-p2 or m4b-p2-test が反映済)
#   - WI 経由で ADC + GH App installation token が OneCLI に投入済
#
# 完了判定: 全 4 section PASS + exit 0 + 末尾に "M4-B Phase 2 PASS"
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/verify-m3-helpers.sh
source "${SCRIPT_DIR}/verify-m3-helpers.sh"

NAMESPACE="biblio-claw"
POD="biblio-orchestrator-0"
SCRIPT_INSIDE="/app/scripts/verify-phase-1-adk-local.ts"

info "[verify-phase-2-adk-gke] start"

# Section 1: kubectl context + orchestrator Pod READY
CURRENT_CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
[[ "$CURRENT_CONTEXT" =~ biblio-prod ]] || fail "kubectl context が biblio-prod ではない: $CURRENT_CONTEXT"
POD_READY="$(kubectl get statefulset/biblio-orchestrator -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)"
[[ "$POD_READY" == "1" ]] || fail "orchestrator StatefulSet readyReplicas != 1: $POD_READY"
info "[1/4] kubectl context = $CURRENT_CONTEXT / Pod READY=1"

# Section 2: verify script の Pod 内存在確認
kubectl exec "$POD" -c orchestrator -n "$NAMESPACE" -- test -f "$SCRIPT_INSIDE" \
  || fail "verify script が Pod 内に不在 (image-sync で同梱されているか確認): $SCRIPT_INSIDE"
info "[2/4] verify script 同梱確認: $SCRIPT_INSIDE"

# Section 3: Pod 内で verify-phase-1-adk-local.ts 実行 → TOOL_CALLED=true 期待
# `--import ./src/instrumentation.ts` で main() より前に OTel 起動済の前提。
TMP_OUT="$(mktemp)"
TMP_ERR="$(mktemp)"
trap 'rm -f "$TMP_OUT" "$TMP_ERR"' EXIT

info "[3/4] Pod 内で verify-phase-1-adk-local.ts 実行 (= 数分かかる、acquire 経路含む)"
LAST_HARNESS_STDERR="$TMP_ERR"
# scripts/verify-phase-1-adk-local.ts は dist に含まれない (= tsc が src/ のみコンパイル
# する設計、Dockerfile も dist に scripts/ をコピーしない)。よって Pod 内では本番 image と
# 同経路 (= dist の node 起動) ではなく tsx 経路で実行する。tsx は `.js` import 拡張子を
# `.ts` source として解決するため、scripts → src の import が解決できる。
# OTel は --import ./src/instrumentation.ts で main() より前に起動する。
RUN_CMD='cd /app && pnpm exec tsx --import ./src/instrumentation.ts scripts/verify-phase-1-adk-local.ts'

if ! kubectl exec "$POD" -c orchestrator -n "$NAMESPACE" -- sh -c "$RUN_CMD" > "$TMP_OUT" 2> "$TMP_ERR"; then
  warn "[3/4] verify script が Pod 内で exit != 0、stdout を確認:"
  sed 's/^/    [stdout] /' "$TMP_OUT" >&2 || true
  # stderr は LAST_HARNESS_STDERR 経由で fail() が自動展開する (= verify-m3.sh 等と一貫)
  fail "verify script の Pod 内実行が失敗した"
fi

TOOL_CALLED="$(grep '^TOOL_CALLED=' "$TMP_OUT" | cut -d= -f2 || echo '')"
TRACE_ID="$(grep '^TRACE_ID=' "$TMP_OUT" | cut -d= -f2 || echo '')"
EVENT_COUNT="$(grep '^EVENT_COUNT=' "$TMP_OUT" | cut -d= -f2 || echo '')"
FINAL_TEXT="$(grep '^FINAL_TEXT=' "$TMP_OUT" | cut -d= -f2- || echo '')"

info "[3/4] stdout 抜粋: TOOL_CALLED=$TOOL_CALLED / TRACE_ID=$TRACE_ID / EVENT_COUNT=$EVENT_COUNT"
[[ "$TOOL_CALLED" == "true" ]] || fail "TOOL_CALLED != true (Phase 2 完了判定): $TOOL_CALLED"
[[ -n "$FINAL_TEXT" ]] || fail "FINAL_TEXT が空: LLM が最終応答を返していない"
info "[3/4] TOOL_CALLED=true + FINAL_TEXT 非空 確認 (LLM 自律 tool 呼出経路成立)"

# Section 4: Cloud Trace 観察ガイド (= 任意観察、Phase 2 PASS 条件外)
if [[ "$TRACE_ID" =~ ^[0-9a-f]{32}$ ]]; then
  info "[4/4] Cloud Trace UI で観察: https://console.cloud.google.com/traces/list?tid=$TRACE_ID&project=hajimari-ai-hackathon-2026"
else
  warn "[4/4] TRACE_ID が 32hex でない: $TRACE_ID (= verify script の active span 取得経路、Phase 2 PASS 条件外)"
fi

info "[verify-phase-2-adk-gke] M4-B Phase 2 PASS"
