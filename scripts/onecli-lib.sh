#!/usr/bin/env bash
# biblio-claw: OneCLI 関連 shell script の共通ヘルパ。
#
# 利用元: scripts/onecli-vertex-secret.sh / onecli-gh-secret.sh /
#         verify-phase-1{,-wiring}.sh
#
# 全関数共通の前提: `set -euo pipefail` が有効であること。
# set_all_agents_mode_all を呼ぶ場合のみ追加で必要:
#   - ONECLI_API (例: http://localhost:10254/v1) が設定済
#   - OC_AUTH (配列、AUTH_MODE=local では空配列) が設定済
# verify スクリプトのように info/ok/warn/fail と vertex_host だけ使う場合は
# OC_AUTH / ONECLI_API を設定する必要はない (set -u 違反は発生しない)。
#
# 提供:
#   - info / ok / warn / fail (stderr 出力ヘルパ)
#   - vertex_host (CLOUD_ML_REGION → Vertex host)
#   - set_all_agents_mode_all (全 agent を secret-mode=all に昇格、idempotent)

# --- ログヘルパ (機密は出さない。全て stderr) -------------------------------
info() { printf '[INFO] %s\n' "$*" >&2; }
ok()   { printf '[OK] %s\n' "$*" >&2; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
fail() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }

# --- vertex_host -----------------------------------------------------------
# CLOUD_ML_REGION から Vertex host を導出。global → aiplatform.googleapis.com
# region 指定 → ${REGION}-aiplatform.googleapis.com
vertex_host() {
  if [ "${CLOUD_ML_REGION:-global}" = "global" ]; then
    printf 'aiplatform.googleapis.com'
  else
    printf '%s-aiplatform.googleapis.com' "${CLOUD_ML_REGION}"
  fi
}

# --- set_all_agents_mode_all -----------------------------------------------
# 既存全 agent を secretMode=all に昇格 (selective 401 回避)。
#   agent がまだ無ければスキップ (host 初回 spawn 後に再実行で all 化される)。
#   GET /v1/agents の失敗は 404 (バージョン差で endpoint 無し) を除いて fail
#   に格上げする。5xx / 接続失敗を info で握りつぶすと、secret 投入は成功して
#   いるのに agent が selective のまま残り、後続の全 API 呼び出しが silent
#   401 になる。
#   個別 agent への PATCH は best-effort で継続 (1 agent の問題で全体を止めない)。
#   ただし「全 agent で PATCH 失敗」のサイレント完了を防ぐため失敗件数を集計し、
#   1 件でも失敗していれば warn を発火する (操作者が「0 件適用 + ok」で完了
#   扱いにできないようにする)。
#
# 一時ファイル + trap RETURN を使わない理由: bash の trap RETURN は当該関数の
#   return だけでなく後続の他関数 (= main) の return でも発火し、set -u 配下で
#   `body_file: unbound variable` の latent バグになる (PR #5 で実走行検出)。
# 対策: curl -w で http_code を末尾付与し、1 変数で body + code を受ける。
set_all_agents_mode_all() {
  local resp http_code body ids n=0 failed=0
  resp="$(curl --connect-timeout 5 --max-time 15 -sS -w $'\n%{http_code}' "${OC_AUTH[@]}" "${ONECLI_API}/agents")" \
    || fail "GET /v1/agents への接続に失敗 — OneCLI が起動しているか確認 (docker compose logs onecli)"
  http_code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  case "$http_code" in
    200) ;;
    404)
      info "GET /v1/agents が 404 — OneCLI バージョン差の可能性。secret-mode 設定をスキップ"
      return 0
      ;;
    *)
      fail "GET /v1/agents が HTTP ${http_code} を返した — OneCLI ログを確認: docker compose logs onecli"
      ;;
  esac
  # jq が pipefail で死んだ場合の [FAIL] なし終了を回避 (OneCLI が配列以外を返した場合)。
  ids="$(printf '%s' "$body" | jq -r '.[].id' 2>/dev/null)" \
    || fail "GET /v1/agents のレスポンスが期待する配列形式でない — OneCLI バージョン差の可能性 (body 先頭: ${body:0:200})"
  if [ -z "$ids" ]; then
    info "agent がまだ存在しない — host が初回 spawn した後に本スクリプトを再実行すると all 化される"
    return 0
  fi
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    if curl --connect-timeout 5 --max-time 15 -fsS "${OC_AUTH[@]}" -X PATCH "${ONECLI_API}/agents/${id}/secret-mode" \
        -H 'Content-Type: application/json' -d '{"mode":"all"}' >/dev/null; then
      n=$((n + 1))
    else
      failed=$((failed + 1))
      # LOG_LEVEL=warn 以上のフィルタ環境でも個別 agent ID 追跡可能にするため warn 昇格。
      warn "agent ${id} の secret-mode=all 更新に失敗 (継続)"
    fi
  done <<< "$ids"
  if [ "$failed" -gt 0 ]; then
    warn "secret-mode=all 適用: 成功 ${n} 件 / 失敗 ${failed} 件 — 失敗した agent は selective のままで 401 が継続する可能性"
  else
    ok "secret-mode=all を ${n} 件の agent に適用"
  fi
}

# --- JWT decode / SHA256 helpers (issue #136 A1) ---------------------------
# rotator layer で ADC token の lifecycle を BQ 相関可能にするための構造化ログ用 helper。
# 全て fail-open (= decode 失敗しても rotation を止めない) 設計:
#   - JWT decode 失敗 → 空文字を返す (呼出側は空文字なら「decode 不能」と扱う)
#   - openssl / base64 が無い環境 → 空文字を返す
# 生 token を argv に残さないため、呼出側は必ず変数経由 (= "$1" 参照) で渡し、
# stdin を汚さない設計。

# base64url → base64 変換 + padding 補完で decode。busybox base64 (Alpine) と
# coreutils base64 (Debian) の両方で `-d` decode を採る。JSON.parse は shell では
# jq 依存になるため、単純な iat/exp のみ regex で切り出す。iat/exp は数値なので
# `"iat":<number>` 形式のみ match、負値 / hex は Vertex ADC の仕様外 = 想定外。
_jwt_decode_payload() {
  # payload (2 番目の segment) を base64url decode → utf-8 string で stdout 出力。
  local token="$1" payload out
  payload="$(printf '%s' "$token" | cut -d. -f2 2>/dev/null)"
  [ -n "$payload" ] || return 1
  # base64url → base64 変換 ('-'→'+', '_'→'/'、= padding 補完)
  out="$(printf '%s' "$payload" \
    | tr '_-' '/+' \
    | awk '{ l=length; p=(4-l%4)%4; while(p-->0) $0=$0"="; print }' \
    | base64 -d 2>/dev/null)" || return 1
  printf '%s' "$out"
}

# JWT payload の `iat` claim (unix sec) を stdout に返す。失敗 or opaque token
# (= `ya29.*` access token = JWT 形式でない) は空文字 (fail-open)。
jwt_decode_iat() {
  local token="$1" payload
  payload="$(_jwt_decode_payload "$token" 2>/dev/null)" || { printf ''; return 0; }
  # `"iat":<digits>` の <digits> を抽出。sed は BSD / GNU 両対応の basic regex 記法。
  # awk / grep -oE の方が読みやすいが、BusyBox でも動くこと最優先。
  printf '%s' "$payload" | grep -oE '"iat"[[:space:]]*:[[:space:]]*[0-9]+' \
    | head -n1 | grep -oE '[0-9]+' | head -n1
}

# JWT payload の `exp` claim (unix sec) を stdout に返す。失敗時は空文字。
jwt_decode_exp() {
  local token="$1" payload
  payload="$(_jwt_decode_payload "$token" 2>/dev/null)" || { printf ''; return 0; }
  printf '%s' "$payload" | grep -oE '"exp"[[:space:]]*:[[:space:]]*[0-9]+' \
    | head -n1 | grep -oE '[0-9]+' | head -n1
}

# SHA256 hash 先頭 12 hex chars を stdout に返す (`fugue-rate-limit.ts:tokenDigest`
# pattern の bash 版)。生 token を argv に残さないよう変数経由 + `printf` で stdin 化。
# 失敗時は空文字を返す (sha256sum が無い環境等)。
token_sha256_12() {
  local token="$1" hash
  hash="$(printf '%s' "$token" | sha256sum 2>/dev/null | cut -c1-12)" || { printf ''; return 0; }
  printf '%s' "$hash"
}
