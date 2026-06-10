#!/usr/bin/env bash
# biblio-claw: OneCLI Vertex secret 投入 (Phase 1 Task 4)
#
# host 側で発行した ADC アクセストークンを OneCLI に
#   type:generic + injectionConfig{headerName:"authorization", valueFormat:"Bearer {value}"}
# の secret として投入し、Vertex host (global = aiplatform.googleapis.com) への
# リクエストに `Authorization: Bearer <ADC token>` を MITM 注入させる。creds は
# OneCLI secret store のみに置き、agent コンテナには一切渡さない。
#
# あわせて全 agent を secretMode=all に昇格する。OneCLI は POST /v1/agents で
# 作った agent を selective モードにするため、host が初回 spawn した agent は
# vault に secret があっても割り当てられず 401 になる (CLAUDE.md §シークレット)。
# REST の PATCH /v1/agents/:id/secret-mode {"mode":"all"} で解消する。
#
# 写経元: PoC-2 scripts/{secret.sh,onecli.sh,lib.sh} (v1.30.0 で実測確定)。
#   - type は {anthropic, openai, generic}。任意 host に Authorization: Bearer を
#     入れるには type:generic + injectionConfig が必須 (anthropic は x-api-key 固定)。
#   - GET /v1/secrets は値を返さない (AES-256-GCM マスク)。更新は DELETE→POST。
#   - pathPattern は省略 (v1.30.0 は null を 400 で拒否。未指定で全パスにマッチ)。
#   - ADC token は ~1h で失効 → 再実行で DELETE→POST フレッシュ化 (Phase 2 で Sidecar 自動化)。
#
# 重要: ADC token は argv / stdout / stderr / ファイルに残さない。jq へは env 経由
#       (argv 非経由)、curl へは stdin (--data-binary @-) で渡す。
#
# 使い方: docker compose up -d --wait 後に `bash scripts/onecli-vertex-secret.sh`

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- ログヘルパ (機密は出さない。全て stderr) ---
info() { printf '[INFO] %s\n' "$*" >&2; }
ok()   { printf '[OK] %s\n' "$*" >&2; }
fail() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }

# --- .env 読み込み (あれば) ---
if [ -f "${ROOT}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${ROOT}/.env"
  set +a
fi

: "${ONECLI_URL:=http://localhost:10254}"
: "${ANTHROPIC_VERTEX_PROJECT_ID:=hajimari-ai-hackathon-2026}"
: "${CLOUD_ML_REGION:=global}"
: "${VERTEX_SECRET_NAME:=biblio-claw-vertex}"

ONECLI_API="${ONECLI_URL%/}/v1"

# OneCLI REST の認証。AUTH_MODE=local (compose 既定) では不要。API キーが
# 設定されている場合のみ Authorization を付ける (非空時だけ argv に出る)。
OC_AUTH=()
if [ -n "${ONECLI_API_KEY:-}" ]; then
  OC_AUTH=(-H "Authorization: Bearer ${ONECLI_API_KEY}")
fi

# --- 依存確認 ---
for c in curl jq gcloud; do
  command -v "$c" >/dev/null 2>&1 || fail "必須コマンドが見つかりません: $c"
done

# vertex_host: region から Vertex host を導出。global → aiplatform.googleapis.com
vertex_host() {
  if [ "${CLOUD_ML_REGION}" = "global" ]; then
    printf 'aiplatform.googleapis.com'
  else
    printf '%s-aiplatform.googleapis.com' "${CLOUD_ML_REGION}"
  fi
}

# secret_id: name=VERTEX_SECRET_NAME の secret id を stdout に返す (無ければ空)。
#   curl 出力を変数に受けてから jq に流す。curl 失敗を fail で止めないと、
#   呼び出し側が「未存在」と誤判定する (Vertex は DELETE→POST 流儀のため
#   GH ほど深刻ではないが、可観測性のため fail を発行する)。
secret_id() {
  local out
  out="$(curl -fsS "${OC_AUTH[@]}" "${ONECLI_API}/secrets")" \
    || fail "GET /v1/secrets への接続に失敗 (secret_id)"
  printf '%s' "$out" \
    | jq -r --arg n "$VERTEX_SECRET_NAME" '.[] | select(.name==$n) | .id' | head -n1
}

# delete_secret: 既存 Vertex secret を削除 (無ければ何もしない / 冪等)。
#   curl 失敗時は素の set -e で「[FAIL] なしの silent 終了」になり、操作者が
#   「DELETE 失敗 / DELETE 成功で次の POST がコケた」を判別できなくなるため、
#   明示的に || fail を発行する (PR #6 レビュー I1)。
delete_secret() {
  local id
  id="$(secret_id)"
  if [ -n "$id" ] && [ "$id" != "null" ]; then
    curl -fsS "${OC_AUTH[@]}" -X DELETE "${ONECLI_API}/secrets/${id}" >/dev/null \
      || fail "DELETE /v1/secrets/${id} に失敗 — OneCLI ログを確認 (docker compose logs onecli)"
  fi
  return 0
}

# ensure_secret: ADC token を type:generic + authorization:Bearer の secret として投入。
#   既存は DELETE してから POST (毎回フレッシュなトークンに更新)。token はログ/argv に残さない。
ensure_secret() {
  local host token
  host="$(vertex_host)"
  # gcloud の stderr は捨てない。失敗時の理由 (credential 破損 / permission /
  # クォータ等) がユーザーに見えないと debug 不能になる。ADC token 自体は
  # stdout (= "$()" 経由でシェル変数) にのみ流れ、stderr には出ない。
  token="$(gcloud auth application-default print-access-token)" \
    || fail "ADC アクセストークン取得に失敗 (上の gcloud エラーを確認。未ログインなら: gcloud auth application-default login --project ${ANTHROPIC_VERTEX_PROJECT_ID})"
  [ -n "$token" ] || fail "ADC アクセストークンが空"
  delete_secret
  SECRET_TOKEN="$token" jq -n \
      --arg name "$VERTEX_SECRET_NAME" --arg host "$host" \
      '{name:$name, type:"generic", value:env.SECRET_TOKEN, hostPattern:$host,
        injectionConfig:{headerName:"authorization", valueFormat:"Bearer {value}"}}' \
    | curl -fsS "${OC_AUTH[@]}" -X POST "${ONECLI_API}/secrets" \
        -H 'Content-Type: application/json' --data-binary @- >/dev/null \
    || fail "secret 投入 (POST /v1/secrets) に失敗"
  unset SECRET_TOKEN token
  ok "Vertex secret 投入 OK (name=${VERTEX_SECRET_NAME} / type=generic / host=${host} / headerName=authorization / valueFormat=Bearer {value} / 値はマスク)"
}

# set_all_agents_mode_all: 既存全 agent を secretMode=all に昇格 (selective 401 回避)。
#   agent がまだ無ければスキップ (host 初回 spawn 後に再実行で all 化される)。
#   重要: GET /agents の失敗は 404 (バージョン差で endpoint 無し) を除いて fail
#   に格上げする。5xx / 接続失敗を info で握りつぶすと、secret 投入は成功して
#   いるのに agent が selective のまま残り、後続の全 Vertex 呼び出しが silent
#   401 になる (本 PR レビュー Critical 指摘)。
#   個別 agent への PATCH は best-effort で継続 (1 agent の問題で全体を止めない)。
# 一時ファイル + trap RETURN を使わない理由:
#   bash の `trap ... RETURN` は当該関数の return だけでなく、後続の他関数
#   (= main) の return でも発火する仕様 (extdebug off の標準動作)。その時点で
#   `local body_file` は scope を抜けて unset 扱い (set -u 配下で unbound) に
#   なり、機能成功後に「body_file: unbound variable」で exit 1 になる既存
#   latent バグがあった (PR #5 の gh スクリプト実走行で検出、Vertex 側も同症状)。
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

main() {
  info "OneCLI REST=${ONECLI_API} / project=${ANTHROPIC_VERTEX_PROJECT_ID} / region=${CLOUD_ML_REGION}"
  # stderr を捨てない — curl の接続エラー (DNS / TLS / 接続拒否のメッセージ) が
  # 「到達できない」だけだと debug 不能になるため、curl 自身のエラーは端末に流す。
  curl -fsS "${OC_AUTH[@]}" "${ONECLI_API}/secrets" >/dev/null \
    || fail "OneCLI REST に到達できない (${ONECLI_API}) — 'docker compose up -d --wait' 済みか確認"
  ensure_secret
  set_all_agents_mode_all
  ok "完了: Vertex Bearer secret 投入 + agent all 化 (ADC token は ~1h で失効 → 再実行でフレッシュ化)"
}

main "$@"
