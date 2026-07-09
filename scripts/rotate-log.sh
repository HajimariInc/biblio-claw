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

# --- log_event_with_fields (issue #136 A1) ---------------------------------
# log_event の拡張版: severity/event/outcome/message に加えて追加 field を
# `key=value` 形式の可変引数として受け取り JSON emit する (LOG_FORMAT=json 時のみ)。
# 非 json 時は既存 log_event と同じ [component] プレフィクス + `msg (key=v...)` で吐く。
#
# 設計方針:
#   - `jq` 依存を避ける (Alpine BusyBox 環境で jq が必ずしも入っていないため既存
#     log_event が bash native json_escape で emit している流儀を継承)
#   - `key=value` は最初の `=` で split (value に `=` が含まれる可能性を許容)
#   - key / value ともに json_escape で `\` / `"` / 制御文字を escape
#   - 空 key / 空 value は skip (空 payload の silent なゴミ field を防ぐ)
#
# 使い方 (rotator layer で ADC token の lifecycle を log emit):
#   log_event_with_fields INFO vertex.rotator.token_injected success \
#     "Vertex ADC token injected" \
#     "token_iat=1704067200" "token_exp=1704070800" "token_hash=abc123def456"
log_event_with_fields() {
  local severity="$1" event="$2" outcome="$3" message="$4"
  shift 4
  if [ "${LOG_FORMAT:-text}" = "json" ]; then
    local t json_extras='' kv key value
    t=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
    for kv in "$@"; do
      [ -n "$kv" ] || continue
      key="${kv%%=*}"
      value="${kv#*=}"
      # `=` を含まないもの (= key のみ) は skip (silent 化しない、明示形式強制)
      [ "$key" != "$kv" ] || continue
      [ -n "$key" ] || continue
      json_extras+=",\"$(json_escape "$key")\":\"$(json_escape "$value")\""
    done
    printf '{"severity":"%s","time":"%s","component":"%s","event":"%s","outcome":"%s","message":"%s"%s}\n' \
      "$severity" "$t" "$COMPONENT_NAME" "$event" "$outcome" "$(json_escape "$message")" "$json_extras" >&2
  else
    printf '[%s] %s (%s)\n' "$COMPONENT_NAME" "$message" "$*" >&2
  fi
}
