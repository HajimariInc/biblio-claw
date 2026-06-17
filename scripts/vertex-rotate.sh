#!/usr/bin/env bash
# biblio-claw: vertex-token-rotator sidecar loop (M2 PRD A Phase 3、案 1A 採用)。
#
# orchestrator Pod 内の Native sidecar として動き、既存 1-shot script
# `onecli-vertex-secret.sh` を ROTATE_INTERVAL_SEC (既定 3000s = 50min) 周期で
# 呼び出して ADC token を OneCLI に投入し続ける。ADC token TTL は ~1h なので
# 50min 周期で安全マージン。
#
# 案 1A の意義は gh-rotate.sh と同じ — 既存 1-shot script を本 wrapper で
# 包んで二重メンテを回避する (Phase 1/2.5 実機検証済資産を流用)。
#
# 設計:
#   - WI (workload identity) 経由で `gcloud auth application-default
#     print-access-token` を叩く前提。orchestrator KSA (biblio-orchestrator-ksa) が
#     新 GSA `biblio-orchestrator` に annotate されており、GSA は
#     `roles/aiplatform.user` を保持する (Task 1 で DEN さんが手作業 bind)。
#   - 起動時に OneCLI gateway を待つロジックは gh-rotate.sh と同じ
#   - 1 周期失敗で sidecar を落とさない
#
# 写経元: PoC-5 `scripts/gh-rotate.sh:132-160` (OneCLI 起動待ち + 永続 loop)

set -euo pipefail

: "${ONECLI_URL:=http://localhost:10254}"
: "${ROTATE_INTERVAL_SEC:=3000}"
: "${ROTATE_READY_RETRIES:=60}"
: "${ROTATE_READY_INTERVAL_SEC:=2}"

SCRIPTS_DIR="${SCRIPTS_DIR:-/scripts}"
WORKER="${SCRIPTS_DIR}/onecli-vertex-secret.sh"

log() { printf '[vertex-rotate] %s\n' "$*" >&2; }

# bash で実行するので実行ビットは不要、存在確認で十分。
[ -f "$WORKER" ] || { log "FAIL: worker script not found at $WORKER"; exit 1; }

# OneCLI 起動待ち。満了を warn で可視化 (gh-rotate.sh と同じ理由)。
log "wait for OneCLI ready (${ONECLI_URL})"
ready=false
for _ in $(seq 1 "$ROTATE_READY_RETRIES"); do
  if curl -fsS "${ONECLI_URL%/}/v1/secrets" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep "$ROTATE_READY_INTERVAL_SEC"
done
if [ "$ready" = true ]; then
  log "OneCLI ready"
else
  log "WARN: OneCLI not ready after ${ROTATE_READY_RETRIES} retries — entering rotation loop anyway"
fi

while true; do
  log "rotation cycle start"
  if bash "$WORKER"; then
    log "rotation OK (sleep ${ROTATE_INTERVAL_SEC}s)"
  else
    log "rotation FAILED (sleep ${ROTATE_INTERVAL_SEC}s and retry)"
  fi
  sleep "$ROTATE_INTERVAL_SEC"
done
