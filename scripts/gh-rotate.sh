#!/usr/bin/env bash
# biblio-claw: gh-token-rotator sidecar loop (M2 PRD A Phase 3、案 1A 採用)。
#
# orchestrator Pod 内の Native sidecar として動き、既存 1-shot script
# `onecli-gh-secret.sh` を ROTATE_INTERVAL_SEC (既定 3000s = 50min) 周期で
# 呼び出して GH installation token を OneCLI に投入し続ける。token TTL は
# ~60min なので 50min 周期で安全マージン。
#
# 案 1A の意義: 既存 1-shot script は Phase 1/2.5 で実機検証済 + local docker
# compose 経路 (DEN さん手叩き) でもそのまま使う = 同一実装で 2 経路をカバー、
# 二重メンテを回避する。
#
# 設計:
#   - 起動時に OneCLI gateway (localhost:10254) の `/v1/secrets` が 200 を
#     返すまで最大 120 秒待つ (= OneCLI sidecar の startupProbe が落ち着く
#     までの保険、native sidecar の起動順は K8s が保証してくれるが念のため)
#   - 1 周期失敗で sidecar を落とさない (= bash 単発失敗を if 文で受ける)
#   - token 値は echo / log に絶対出さない (`onecli-gh-secret.sh` 側で
#     既に守られている、本 wrapper は中身を直接触らない)
#
# 写経元: PoC-5 `scripts/gh-rotate.sh:132-160` (OneCLI 起動待ち + 永続 loop)

set -euo pipefail

: "${ONECLI_URL:=http://localhost:10254}"
: "${ROTATE_INTERVAL_SEC:=3000}"
: "${ROTATE_READY_RETRIES:=60}"
: "${ROTATE_READY_INTERVAL_SEC:=2}"

SCRIPTS_DIR="${SCRIPTS_DIR:-/scripts}"
WORKER="${SCRIPTS_DIR}/onecli-gh-secret.sh"

COMPONENT_NAME="${LOG_COMPONENT:-gh-token-rotator}"

# JSON エスケープ (= bash 内で完結、jq 不要)。\ → \\, " → \", LF → \n。
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

# log_event SEVERITY event outcome msg...
# LOG_FORMAT=json なら structured JSON、それ以外は既存 [component] text。両経路とも stderr。
log_event() {
  local severity="$1" event="$2" outcome="$3"
  shift 3
  local msg="$*"
  if [ "${LOG_FORMAT:-text}" = "json" ]; then
    local t
    t=$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')
    printf '{"severity":"%s","time":"%s","component":"%s","event":"%s","outcome":"%s","message":"%s"}\n' \
      "$severity" "$t" "$COMPONENT_NAME" "$event" "$outcome" "$(json_escape "$msg")" >&2
  else
    printf '[%s] %s\n' "$COMPONENT_NAME" "$msg" >&2
  fi
}

log() { log_event INFO rotation.message '' "$*"; }

# bash で実行するので実行ビットは不要、存在確認で十分。
[ -f "$WORKER" ] || { log_event ERROR rotation.config_error failure "worker script not found at $WORKER"; exit 1; }

# OneCLI 起動待ち。失敗してもループには入らせる (= 起動完了が ROTATE_READY_RETRIES *
# ROTATE_READY_INTERVAL_SEC 秒以上かかる場合は worker 内の curl が改めて 401/接続失敗
# を出して 1 周期 fail するだけ)。ただしタイムアウト満了を warn で可視化し、運用者が
# 後続の "rotation FAILED" を「OneCLI 未起動」と切り分けられるようにする。
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
  # `set -e` は worker の失敗で wrapper を落とす方向に倒れる。1 周期 fail で
  # sidecar が死ぬと restartPolicy: Always で再起動が連続してログが埋まる + 復旧が
  # 次の周期まで遅れるため、if 文で受けて wrapper 自身は生かす (PoC-5 写経)。
  if bash "$WORKER"; then
    log_event INFO rotation.ok success "GH installation token refreshed (sleep ${ROTATE_INTERVAL_SEC}s)"
  else
    rc=$?
    log_event ERROR rotation.failed failure "exit_code=${rc} (sleep ${ROTATE_INTERVAL_SEC}s and retry)"
  fi
  sleep "$ROTATE_INTERVAL_SEC"
done
