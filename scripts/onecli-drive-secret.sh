#!/usr/bin/env bash
# biblio-claw: OneCLI Drive access token secret 投入 (M4-F Phase 3、life-capabilities)
#
# host / orchestrator Pod 側で「drive.readonly scope 付きの access token」を発行して
# OneCLI に投入する。secret shape (type:generic + injectionConfig{Bearer {value}}) は
# 従来通り、変わるのは token 発行経路のみ。
#
# ## Token 発行経路 (R4: SA 2 段 impersonation + generateAccessToken)
# 1. metadata server から呼び出し元 SA (biblio-orchestrator@) の caller token を取得
#    (cloud-platform scope の ADC、GKE Workload Identity 経路)
# 2. IAM Credentials API の generateAccessToken に caller token で認証、
#    target = biblio-google-drive-user@ SA を impersonate、
#    scope = drive.readonly を明示 → drive.readonly scope 付き access token を発行
#    (Google 公式 pattern、`iamcredentials.googleapis.com`、~1h TTL)
# 3. 得た access token を OneCLI に PATCH (既存) or POST (新規) で投入
#
# ## なぜ R4 経路か
# 旧 script は `gcloud auth application-default print-access-token --scopes=drive.readonly` に
# 依存していたが、GKE Autopilot の WI 経由 metadata server の scope は cloud-platform に
# 固定されており、`--scopes` は GCE account type では silent ignored (2026-07-05 実測)。
# したがって Drive API が 403 PERMISSION_DENIED / insufficientPermissions を返す構造的問題があった。
# R4 経路は SA を分離 (biblio-google-drive-user@) + impersonation で drive.readonly scope の
# token を発行するため metadata の scope 制約に影響されない。
#
# ## 前提となる IAM binding
# biblio-orchestrator@ が biblio-google-drive-user@ に対して
# `roles/iam.serviceAccountTokenCreator` を持つこと (`terraform/iam-drive-user/`
# module で宣言済)。ない場合 generateAccessToken が 403 で fail する。
#
# ## Drive フォルダ ACL
# biblio-google-drive-user@ SA email を Drive フォルダの「閲覧者」として共有すること。
# 権限は Drive リソース側 ACL で決まる (project 内 IAM とは別レイヤ)。
#
# ## Vertex / GH との差分
# - Vertex = aiplatform.googleapis.com (self ADC の cloud-platform scope で通る)
# - GH = api.github.com (installation token 経路、PEM → JWT → access_tokens)
# - Drive = www.googleapis.com (target SA impersonation で drive.readonly scope 明示、R4)
#
# 使い方 (GKE): orchestrator Pod 内で drive-token-rotator sidecar が 40min 周期で自動実行。
#   初回投入までの gap を避けたい場合のみ手動で 1 回:
#   kubectl exec -n biblio-claw biblio-orchestrator-0 -c drive-token-rotator -- bash /scripts/onecli-drive-secret.sh
# 使い方 (local): 本 script は GKE 前提 (metadata server 依存)。local dev では別途
#   ADC user consent 経由 (未実装、Phase 4 検討) or 手動投入経路が必要。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- .env 読み込み (あれば、local override 用) ---
if [ -f "${ROOT}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${ROOT}/.env"
  set +a
fi

: "${ONECLI_URL:=http://localhost:10254}"
: "${DRIVE_SECRET_NAME:=biblio-claw-drive}"
: "${DRIVE_API_HOST:=www.googleapis.com}"
: "${DRIVE_USER_SA:=biblio-google-drive-user@hajimari-ai-hackathon-2026.iam.gserviceaccount.com}"
: "${DRIVE_SCOPE:=https://www.googleapis.com/auth/drive.readonly}"
: "${DRIVE_TOKEN_LIFETIME:=3600s}"
: "${METADATA_HOST:=metadata.google.internal}"

ONECLI_API="${ONECLI_URL%/}/v1"

# OneCLI REST の認証 (AUTH_MODE=local では不要)。
OC_AUTH=()
if [ -n "${ONECLI_API_KEY:-}" ]; then
  OC_AUTH=(-H "Authorization: Bearer ${ONECLI_API_KEY}")
fi

# --- 共通 lib を読み込む (info / ok / fail / set_all_agents_mode_all) ---
# shellcheck source=scripts/onecli-lib.sh
. "${ROOT}/scripts/onecli-lib.sh"

# --- 依存確認 (gcloud は不要、curl + jq のみ) ---
for c in curl jq; do
  command -v "$c" >/dev/null 2>&1 || fail "必須コマンドが見つかりません: $c"
done

# fetch_caller_token: metadata server から呼び出し元 SA (biblio-orchestrator@) の
# ADC access token を取得 (cloud-platform scope、この token 自体は Drive API を叩けない)。
fetch_caller_token() {
  curl -fsS -H 'Metadata-Flavor: Google' \
    "http://${METADATA_HOST}/computeMetadata/v1/instance/service-accounts/default/token" \
    | jq -r .access_token
}

# fetch_drive_token: caller token で biblio-google-drive-user@ を impersonate、
# drive.readonly scope 付き access token を generateAccessToken 経路で発行する。
# 呼出元 SA (biblio-orchestrator@) が target SA に対して roles/iam.serviceAccountTokenCreator を
# 持つことが前提。ない場合は 403 で fail。
fetch_drive_token() {
  local caller resp http body token
  caller="$(fetch_caller_token)" || fail "caller token 取得失敗 (metadata server 到達不能)"
  # `jq -r .access_token` は該当 field 不在の 200 応答 (metadata API version 差異 /
  # proxy 応答改変等) に対して文字列 "null" を出力し exit 0 = 非空チェックだけでは
  # 素通しする。後段の generateAccessToken が `Bearer null` で 401/400 を返し、
  # 「IAM binding 未設定」等と誤診断されるのを防ぐため、非空 + "null" 非一致で fail。
  # (L110 の accessToken 側チェックと対称)
  [ -n "$caller" ] && [ "$caller" != "null" ] || fail "caller token が空または malformed (metadata server 応答に access_token field なし)"

  resp="$(jq -n --arg scope "$DRIVE_SCOPE" --arg lifetime "$DRIVE_TOKEN_LIFETIME" \
    '{scope:[$scope], lifetime:$lifetime}' \
    | curl -sS -w '\n%{http_code}' -X POST \
        -H "Authorization: Bearer $caller" \
        -H 'Content-Type: application/json' --data-binary @- \
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${DRIVE_USER_SA}:generateAccessToken")" \
    || fail "generateAccessToken 呼出し失敗 (network / TLS)"
  # HTTP code / body 分割は bash parameter expansion で完結 (subprocess fork ゼロ、
  # `onecli-lib.sh:56-57` の set_all_agents_mode_all と同 idiom で統一)。
  http="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  [ "$http" = "200" ] || fail "generateAccessToken HTTP=$http: $(printf '%s' "$body" | head -c 400)"
  token="$(printf '%s' "$body" | jq -r .accessToken)"
  [ -n "$token" ] && [ "$token" != "null" ] || fail "generateAccessToken response に accessToken なし"
  printf '%s' "$token"
}

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

# ensure_secret: R4 経路で発行した access token を type:generic の secret として投入。
#   未存在: POST /v1/secrets (期待 201、pathPattern は省略 = 全パスマッチ)
#   既存:   PATCH /v1/secrets/:id で value のみ partial update (期待 200、id 保持)
ensure_secret() {
  local host token id
  host="$DRIVE_API_HOST"
  token="$(fetch_drive_token)"
  id="$(secret_id)"
  if [ -z "$id" ] || [ "$id" = "null" ]; then
    info "[secret] 未存在 → POST /v1/secrets で作成 (name=$DRIVE_SECRET_NAME / host=$host / SA=$DRIVE_USER_SA / scope=$DRIVE_SCOPE)"
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
  ok "Drive secret 投入 OK (name=${DRIVE_SECRET_NAME} / host=${host} / SA=${DRIVE_USER_SA} / scope=${DRIVE_SCOPE})"
}

main() {
  info "OneCLI REST=${ONECLI_API} / Drive host=${DRIVE_API_HOST} / target SA=${DRIVE_USER_SA}"
  curl -fsS "${OC_AUTH[@]}" "${ONECLI_API}/secrets" >/dev/null \
    || fail "OneCLI REST に到達できない (${ONECLI_API}) — sidecar 経路なら OneCLI Native sidecar startup 完了確認"
  ensure_secret
  set_all_agents_mode_all
  ok "完了: Drive Bearer secret 投入 + agent all 化 (~1h TTL、GKE では drive-token-rotator sidecar が 40min 周期で自動再投入)"
}

main "$@"
