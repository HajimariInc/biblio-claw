# rotator sidecar 共通ログ関数。gh-rotate.sh / vertex-rotate.sh が source して使う。
# 呼び出し側で COMPONENT_NAME を設定済みであることが前提 (= 各 rotator が固有値を持つため)。
#
# 設計:
#   - LOG_FORMAT=json なら Cloud Logging 自動解析対応の JSON (severity/time/component/event/outcome/message)
#   - それ以外は既存の [component] msg プレーンテキスト
#   - time は秒精度の RFC3339 UTC (= BusyBox date が %3N 非対応のため秒精度に統一、
#     Alpine ベースの gh-token-rotator image との互換性確保)
#   - json_escape は \ / " / LF / CR / TAB / 制御文字 を JSON 仕様準拠でエスケープ

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

# log_event SEVERITY event outcome msg...
log_event() {
  local severity="$1" event="$2" outcome="$3"
  shift 3
  local msg="$*"
  if [ "${LOG_FORMAT:-text}" = "json" ]; then
    local t
    t=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
    printf '{"severity":"%s","time":"%s","component":"%s","event":"%s","outcome":"%s","message":"%s"}\n' \
      "$severity" "$t" "$COMPONENT_NAME" "$event" "$outcome" "$(json_escape "$msg")" >&2
  else
    printf '[%s] %s\n' "$COMPONENT_NAME" "$msg" >&2
  fi
}

log() { log_event INFO rotation.message '' "$*"; }
