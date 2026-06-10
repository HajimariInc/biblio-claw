#!/usr/bin/env bash
# biblio-claw: OneCLI 関連 shell script の共通ヘルパ (PR #6 レビュー I9)。
#
# 利用元:
#   - scripts/onecli-vertex-secret.sh
#   - scripts/onecli-gh-secret.sh
#   - scripts/verify-phase-1-wiring.sh
#
# 利用側に求めるもの:
#   - `set -euo pipefail` が既に有効
#   - `ONECLI_API` (例: http://localhost:10254/v1) が設定済
#   - `OC_AUTH` (配列、AUTH_MODE=local では空配列) が設定済
#   - 集約 ID/value のスコープに踏み込まないため、本 lib は I/O のみで状態は持たない
#
# 提供:
#   - info / ok / warn / fail (stderr 出力ヘルパ)
#   - vertex_host (CLOUD_ML_REGION → Vertex host)
#   - set_all_agents_mode_all (全 agent を secret-mode=all に昇格、idempotent)
#
# 注意:
#   - 本 lib を `source` する側は実行ファイルではないので shebang は飾り。
#   - `set_all_agents_mode_all` は OneCLI 操作。Vertex/GH スクリプト共通の
#     32 行重複を解消する目的で切り出した (I9)。挙動は元のままで、PR #5 で確立
#     した「一時ファイル + trap RETURN を避ける」流儀を保持する。

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
#   401 になる (PR #5 レビュー Critical 指摘の歴史)。
#   個別 agent への PATCH は best-effort で継続 (1 agent の問題で全体を止めない)。
#
# 一時ファイル + trap RETURN を使わない理由:
#   bash の `trap ... RETURN` は当該関数の return だけでなく、後続の他関数
#   (= main) の return でも発火する仕様 (extdebug off の標準動作)。その時点で
#   `local body_file` は scope を抜けて unset 扱い (set -u 配下で unbound) に
#   なり、機能成功後に「body_file: unbound variable」で exit 1 になる既存
#   latent バグがあった (PR #5 で実走行検出、Vertex 側も同症状)。
# 対策: curl -w で末尾に http_code を付け、1 変数で body + code を受ける。
#   一時ファイル / trap を完全排除。
set_all_agents_mode_all() {
  local resp http_code body ids n=0
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
  # jq が pipefail で死んだ場合に [FAIL] 表示なしで bash がデフォルト終了する
  # 既存 silent failure を回避 (PR #6 レビュー I2)。OneCLI バージョンアップで
  # GET /v1/agents が配列以外 (例: {"agents":[...]}) を返した場合に発火する。
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
      info "agent ${id} の secret-mode 更新に失敗 (継続)"
    fi
  done <<< "$ids"
  ok "secret-mode=all を ${n} 件の agent に適用"
}
