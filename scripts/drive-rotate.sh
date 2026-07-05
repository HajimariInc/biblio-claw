#!/usr/bin/env bash
# biblio-claw: drive-token-rotator sidecar loop (M4-F Phase 3、案 1A: 既存 1-shot script を loop wrap)。
#
# orchestrator Pod 内の Native sidecar として動き、既存 1-shot script
# `onecli-drive-secret.sh` を ROTATE_INTERVAL_SEC (既定 2400s = 40min) 周期で
# 呼び出して Drive scope の ADC token を OneCLI に投入し続ける。
# ADC token TTL は ~60min なので 40min 周期で ~20min margin (Vertex と同流儀、
# issue #49 の TTL margin 判断を継承)。
#
# 案 1A の意義: 既存 1-shot script を本 wrapper で包み、rotator loop 側で
# メンテを持たない (= Phase 3 実装 script `onecli-drive-secret.sh` を DEN さんが
# 手動で叩いても動く / sidecar 経由でも動く、両経路で同じロジック)。
#
# 設計:
#   - WI (workload identity) 経由で `gcloud auth application-default print-access-token`
#     を叩く前提。orchestrator KSA (biblio-orchestrator-ksa) が `biblio-orchestrator`
#     GSA に annotate 済で、GSA は `roles/aiplatform.user` を持つ (既存 Vertex 経路と同 GSA)。
#     Drive API 呼出しには追加の IAM 権限は不要 (Drive の権限は IAM ではなく
#     Drive フォルダ単位の ACL、GSA email に「閲覧者」共有が別途必要)。
#   - 起動時に OneCLI gateway を待つロジックは vertex-rotate.sh と同じ
#   - 1 周期失敗で sidecar を落とさない (log_event ERROR + retry loop 継続)
#
# 写経元: scripts/vertex-rotate.sh (差分: WORKER と COMPONENT_NAME、rotation.ok の
# ログ文言のみ。Vertex 側の loop 構造と exit code 経路は完全踏襲)

set -euo pipefail

: "${ONECLI_URL:=http://localhost:10254}"
: "${ROTATE_INTERVAL_SEC:=2400}"
: "${ROTATE_READY_RETRIES:=60}"
: "${ROTATE_READY_INTERVAL_SEC:=2}"

SCRIPTS_DIR="${SCRIPTS_DIR:-/scripts}"
WORKER="${SCRIPTS_DIR}/onecli-drive-secret.sh"

COMPONENT_NAME="${LOG_COMPONENT:-drive-token-rotator}"
# shellcheck source=./rotate-log.sh
source "${SCRIPTS_DIR}/rotate-log.sh"

# bash で実行するので実行ビットは不要、存在確認で十分。
[ -f "$WORKER" ] || { log_event ERROR rotation.config_error failure "worker script not found at $WORKER"; exit 1; }

# OneCLI 起動待ち。満了を warn で可視化 (vertex-rotate.sh と同じ理由)。
log_event INFO rotation.wait_ready '' "wait for OneCLI ready (${ONECLI_URL})"
ready=false
for _ in $(seq 1 "$ROTATE_READY_RETRIES"); do
  if curl -fsS "${ONECLI_URL%/}/v1/secrets" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep "$ROTATE_READY_INTERVAL_SEC"
done
if [ "$ready" = true ]; then
  log_event INFO rotation.ready success "OneCLI ready"
else
  log_event WARNING rotation.ready_timeout failure "OneCLI not ready after ${ROTATE_READY_RETRIES} retries — entering rotation loop anyway"
fi

while true; do
  log_event INFO rotation.cycle_start '' "rotation cycle start"
  if bash "$WORKER"; then
    log_event INFO rotation.ok success "Drive ADC token refreshed (sleep ${ROTATE_INTERVAL_SEC}s)"
  else
    rc=$?
    log_event ERROR rotation.failed failure "exit_code=${rc} (sleep ${ROTATE_INTERVAL_SEC}s and retry)"
  fi
  sleep "$ROTATE_INTERVAL_SEC"
done
