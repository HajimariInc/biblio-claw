#!/usr/bin/env bash
# biblio-claw: OneCLI Drive ADC token secret 投入 (M4-F Phase 3、life-capabilities)
#
# host / orchestrator Pod 側で発行した ADC アクセストークンを OneCLI に
#   type:generic + injectionConfig{headerName:"authorization", valueFormat:"Bearer {value}"}
# の secret として投入し、hostPattern=www.googleapis.com への request に
# `Authorization: Bearer <ADC token>` を MITM 注入させる。creds は
# OneCLI secret store のみに置き、agent コンテナ (Drive MCP server) には一切渡さない
# (Drive MCP server は `Authorization: Bearer placeholder` を送るだけ)。
#
# あわせて全 agent を secretMode=all に昇格する。
#
# 写経元: scripts/onecli-vertex-secret.sh (ADC 取得ロジックの核 = `gcloud auth
# application-default print-access-token` は同一。Vertex 固有の project/region env
# (`ANTHROPIC_VERTEX_PROJECT_ID` / `CLOUD_ML_REGION`) と `vertex_host()` 呼出しは
# Drive 版では削除、hostPattern / SECRET_NAME を差し替え)。
#
# ## scope 判断
# `gcloud auth application-default print-access-token` の default (cloud-platform scope) は
# **Drive API で 403 PERMISSION_DENIED / insufficientPermissions** を返す (2026-07-05 実測)。
# したがって `--scopes=https://www.googleapis.com/auth/drive.readonly` を明示する。
# **GCE account type (= GKE Autopilot Pod 内 WI 経由 impersonate 経路) では
# `WARNING: --scopes flag may not work as expected and will be ignored for account type gce`
# が stderr に出るが、実測では scope 明示が effective** (warning は誤り、Google 側 auth-library の
# 挙動と warning が不整合)。stderr は捨てて noise を抑える。
#
# ## Vertex / GH との差分
# - Vertex = aiplatform.googleapis.com (region 別 host、`vertex_host()` 経由)
# - GH = api.github.com (installation token 経路、PEM → JWT → access_tokens)
# - Drive = www.googleapis.com (static host、ADC 直接、gcloud のみで足りる)
#
# 使い方 (local): docker compose up -d --wait + gcloud auth application-default login 後に
#   bash scripts/onecli-drive-secret.sh
# 使い方 (GKE): orchestrator Pod 内で drive-token-rotator sidecar が 40min 周期で自動実行。
#   初回投入までの gap を避けたい場合のみ手動で 1 回:
#   kubectl exec -n biblio-claw biblio-orchestrator-0 -c drive-token-rotator -- bash /scripts/onecli-drive-secret.sh

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
: "${DRIVE_SECRET_NAME:=biblio-claw-drive}"
: "${DRIVE_API_HOST:=www.googleapis.com}"

ONECLI_API="${ONECLI_URL%/}/v1"

# OneCLI REST の認証 (AUTH_MODE=local では不要)。
OC_AUTH=()
if [ -n "${ONECLI_API_KEY:-}" ]; then
  OC_AUTH=(-H "Authorization: Bearer ${ONECLI_API_KEY}")
fi

# --- 共通 lib を読み込む (info / ok / fail / set_all_agents_mode_all) ---
# shellcheck source=scripts/onecli-lib.sh
. "${ROOT}/scripts/onecli-lib.sh"

# --- 依存確認 ---
for c in curl jq gcloud; do
  command -v "$c" >/dev/null 2>&1 || fail "必須コマンドが見つかりません: $c"
done

# secret_id: name=$DRIVE_SECRET_NAME の secret id を stdout に返す (無ければ空)。
secret_id() {
  local out id
  out="$(curl -fsS "${OC_AUTH[@]}" "${ONECLI_API}/secrets")" \
    || fail "GET /v1/secrets への接続に失敗 (secret_id)"
  id="$(printf '%s' "$out" \
    | jq -r --arg n "$DRIVE_SECRET_NAME" '.[] | select(.name==$n) | .id' | head -n1)" \
    || fail "GET /v1/secrets のレスポンスが JSON パース不能 (OneCLI ログを確認)"
  printf '%s' "$id"
}

# ensure_secret: ADC token を type:generic + authorization:Bearer の secret として投入。
#   未存在: POST /v1/secrets (期待 201、pathPattern は省略 = 全パスマッチ)
#   既存:   PATCH /v1/secrets/:id で value のみ partial update
#           (期待 200、id 保持 = rotation gap なし)
#
# pathPattern は省略 (repo 全体原則、issue #36)。
# Drive scope 明示が必要な場合は `--scopes=https://www.googleapis.com/auth/drive.readonly`
# を print-access-token の後段に追記する (Task 8b 実測後の判断で有効化)。
ensure_secret() {
  local host token id
  host="$DRIVE_API_HOST"
  # Drive scope 明示 (Task 8b 実測、2026-07-05): cloud-platform default では Drive API が
  # 403 PERMISSION_DENIED を返すため `--scopes=drive.readonly` を明示する。stderr の GCE
  # account type warning は harmless で捨てる (script header の scope 判断節参照)。
  # gcloud 実 error は rc != 0 で捕捉できるため stderr 捨てても debug 可能。
  token="$(gcloud auth application-default print-access-token \
    --scopes=https://www.googleapis.com/auth/drive.readonly 2>/dev/null)" \
    || fail "ADC アクセストークン取得に失敗 (未ログインなら gcloud auth application-default login。詳細は 'gcloud auth application-default print-access-token --scopes=https://www.googleapis.com/auth/drive.readonly' を stderr 込みで叩いて確認)"
  [ -n "$token" ] || fail "ADC アクセストークンが空"
  id="$(secret_id)"
  if [ -z "$id" ] || [ "$id" = "null" ]; then
    info "[secret] 未存在 → POST /v1/secrets で作成 (name=$DRIVE_SECRET_NAME / host=$host / pathPattern=omitted / header=authorization)"
    ( set -o pipefail
      SECRET_TOKEN="$token" jq -n \
          --arg name "$DRIVE_SECRET_NAME" --arg host "$host" \
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
  ok "Drive secret 投入 OK (name=${DRIVE_SECRET_NAME} / type=generic / host=${host} / headerName=authorization / valueFormat=Bearer {value} / 値はマスク)"
}

main() {
  info "OneCLI REST=${ONECLI_API} / Drive host=${DRIVE_API_HOST}"
  # stderr を捨てない: curl の接続エラーが「到達できない」だけだと debug 不能。
  curl -fsS "${OC_AUTH[@]}" "${ONECLI_API}/secrets" >/dev/null \
    || fail "OneCLI REST に到達できない (${ONECLI_API}) — 'docker compose up -d --wait' 済みか確認"
  ensure_secret
  set_all_agents_mode_all
  ok "完了: Drive Bearer secret 投入 + agent all 化 (ADC token は ~1h で失効 → GKE では drive-token-rotator sidecar が 40min 周期で自動再投入)"
}

main "$@"
