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
  resp="$(curl -sS -w $'\n%{http_code}' "${OC_AUTH[@]}" "${ONECLI_API}/agents")" \
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
    if curl -fsS "${OC_AUTH[@]}" -X PATCH "${ONECLI_API}/agents/${id}/secret-mode" \
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
