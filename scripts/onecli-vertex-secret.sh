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
#   - GET /v1/secrets は値を返さない (AES-256-GCM マスク)。更新は PATCH で value のみ。
#   - pathPattern は省略 (v1.30.0 は null を 400 で拒否。未指定で全パスにマッチ)。
#   - ADC token は ~1h で失効 → 再実行で PATCH フレッシュ化 (Phase 2 で Sidecar 化済 = vertex-token-rotator)。
#
# 更新流儀 (issue #49 で DELETE→POST から PATCH/POST 分岐に変更):
#   旧: 毎回 DELETE → POST で secret を完全再投入。DELETE と POST の隙間に
#       Vertex リクエストが届くと vault に secret が一時不在で Authorization が
#       注入されず 401 を踏む rotation gap が発生していた。
#   新: gh-secret.sh と同じ upsert 流儀 (未存在: POST、既存: PATCH /v1/secrets/:id
#       で value のみ partial update)。id 保持 + gap なし。OneCLI v1.30.0 で
#       PATCH の partial update (value のみ送信、hostPattern / injectionConfig /
#       既存 pathPattern は OneCLI 側保持) が動作することは gh-secret.sh で実証済。
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
#   呼び出し側が「未存在」と誤判定して二重 POST 投入してしまうため明示 fail。
secret_id() {
  local out id
  out="$(curl -fsS "${OC_AUTH[@]}" "${ONECLI_API}/secrets")" \
    || fail "GET /v1/secrets への接続に失敗 (secret_id)"
  # jq の失敗 (= OneCLI が HTML エラーページ等の非 JSON 200 を返した場合) は
  # pipefail で非ゼロ伝播するが、`id="$(secret_id)"` 側の set -e 経由で
  # 黙って exit してしまい [FAIL] 行が残らないため明示的に || fail を発行する。
  id="$(printf '%s' "$out" \
    | jq -r --arg n "$VERTEX_SECRET_NAME" '.[] | select(.name==$n) | .id' | head -n1)" \
    || fail "GET /v1/secrets のレスポンスが JSON パース不能 (OneCLI ログを確認: kubectl logs ... -c onecli)"
  printf '%s' "$id"
}

# ensure_secret: ADC token を type:generic + authorization:Bearer の secret として投入。
#   未存在: POST /v1/secrets (期待 201、pathPattern は省略 = 全パスマッチ)
#   既存:   PATCH /v1/secrets/:id で value のみ partial update
#           (期待 200、id 保持 = hostPattern 解決の安定性 + rotation gap なし)
#
# issue #49 で DELETE→POST から本流儀に変更。DELETE と POST の隙間に Vertex
# リクエストが届くと vault に secret が一時不在で Authorization 注入されず 401
# を踏む rotation gap を消滅させるため。流儀は scripts/onecli-gh-secret.sh の
# upsert_gh_secret パターンを写経 (= v1.30.0 で PATCH の value 単独更新が動作
# することは GH 経路で実証済)。
ensure_secret() {
  local host token id
  host="$(vertex_host)"
  # gcloud の stderr は捨てない。失敗時の理由 (credential 破損 / permission /
  # クォータ等) がユーザーに見えないと debug 不能になる。ADC token 自体は
  # stdout (= "$()" 経由でシェル変数) にのみ流れ、stderr には出ない。
  token="$(gcloud auth application-default print-access-token)" \
    || fail "ADC アクセストークン取得に失敗 (上の gcloud エラーを確認。未ログインなら: gcloud auth application-default login --project ${ANTHROPIC_VERTEX_PROJECT_ID})"
  [ -n "$token" ] || fail "ADC アクセストークンが空"
  id="$(secret_id)"
  if [ -z "$id" ] || [ "$id" = "null" ]; then
    info "[secret] 未存在 → POST /v1/secrets で作成 (name=$VERTEX_SECRET_NAME / host=$host / pathPattern=omitted / header=authorization)"
    ( set -o pipefail
      SECRET_TOKEN="$token" jq -n \
          --arg name "$VERTEX_SECRET_NAME" --arg host "$host" \
          '{name:$name, type:"generic", value:env.SECRET_TOKEN, hostPattern:$host,
            injectionConfig:{headerName:"authorization", valueFormat:"Bearer {value}"}}' \
        | curl -fsS "${OC_AUTH[@]}" -X POST "${ONECLI_API}/secrets" \
            -H 'Content-Type: application/json' --data-binary @- >/dev/null
    ) || fail "secret 投入 (POST /v1/secrets) に失敗"
  else
    info "[secret] 既存 (id=$id) → PATCH /v1/secrets/$id で value のみ partial update (pathPattern は省略 = OneCLI 側保持、rotation gap なし)"
    ( set -o pipefail
      SECRET_TOKEN="$token" jq -n '{value:env.SECRET_TOKEN}' \
        | curl -fsS "${OC_AUTH[@]}" -X PATCH "${ONECLI_API}/secrets/$id" \
            -H 'Content-Type: application/json' --data-binary @- >/dev/null
    ) || fail "secret 更新 (PATCH /v1/secrets/$id) に失敗"
  fi
  unset SECRET_TOKEN token
  ok "Vertex secret 投入 OK (name=${VERTEX_SECRET_NAME} / type=generic / host=${host} / headerName=authorization / valueFormat=Bearer {value} / 値はマスク)"
}

# set_all_agents_mode_all は scripts/onecli-lib.sh で定義済み。

main() {
  info "OneCLI REST=${ONECLI_API} / project=${ANTHROPIC_VERTEX_PROJECT_ID} / region=${CLOUD_ML_REGION}"
  # stderr を捨てない — curl の接続エラー (DNS / TLS / 接続拒否のメッセージ) が
  # 「到達できない」だけだと debug 不能になるため、curl 自身のエラーは端末に流す。
  curl -fsS "${OC_AUTH[@]}" "${ONECLI_API}/secrets" >/dev/null \
    || fail "OneCLI REST に到達できない (${ONECLI_API}) — 'docker compose up -d --wait' 済みか確認"
  ensure_secret
  set_all_agents_mode_all
  ok "完了: Vertex Bearer secret 投入 + agent all 化 (ADC token は ~1h で失効 → 再実行で PATCH フレッシュ化)"
}

main "$@"
