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

# --- 共通 lib を読み込む (info / ok / fail / vertex_host / set_all_agents_mode_all) ---
# shellcheck source=scripts/onecli-lib.sh
. "${ROOT}/scripts/onecli-lib.sh"

# --- 依存確認 ---
for c in curl jq gcloud; do
  command -v "$c" >/dev/null 2>&1 || fail "必須コマンドが見つかりません: $c"
done

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

# set_all_agents_mode_all は scripts/onecli-lib.sh から source 済み
# (PR #6 レビュー I9: Vertex / GH スクリプト間の 32 行重複を解消)。

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
