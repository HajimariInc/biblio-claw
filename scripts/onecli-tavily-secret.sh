#!/usr/bin/env bash
# biblio-claw: OneCLI Tavily secret 投入 (M4-F Phase 3、life-capabilities)
#
# `TAVILY_API_KEY` を OneCLI に
#   type:generic + injectionConfig{headerName:"authorization", valueFormat:"Bearer {value}"}
# の secret として投入し、hostPattern=api.tavily.com への request に
# `Authorization: Bearer <TAVILY_API_KEY>` を MITM 注入させる。creds は
# OneCLI secret store のみに置き、agent コンテナには一切渡さない
# (`container_configs.mcp_servers.tavily.env` は placeholder のまま)。
#
# あわせて全 agent を secretMode=all に昇格する (selective モードで作られた agent
# の 401 回避 / CLAUDE.md §シークレット gotcha)。
#
# ## TAVILY_API_KEY の取得順序 (env → Secret Manager → fail)
# 1. **env 経由** (`$TAVILY_API_KEY` が設定済の場合): local dev で `.env` から
#    set -a 経由に export されている、または shell 変数として明示 export されている経路。
#    これが最優先 = 開発者が手元で緊急デバッグする経路を潰さない。
# 2. **Secret Manager fallback** (env 未設定、gcloud CLI + IAM が使える場合):
#    `gcloud secrets versions access latest --secret=$TAVILY_SM_SECRET
#     --project=$TAVILY_SM_PROJECT` で取得。GKE 経路 (orchestrator Pod 内 gcloud + WI
#    で orchestrator GSA を impersonate、`terraform/tavily-secret/` module が
#    `roles/secretmanager.secretAccessor` を secret scope で付与済) の primary path。
# 3. **両方失敗**: need() で fail-fast (loud fail、silent skip なし)。
#
# ## Tavily / Vertex / GH の差分
# - Tavily = **static key** (rotate 不要、TTL 事実上無期限)。
#   Tavily Dashboard で key regenerate 時のみ `terraform apply` で新 version 追加 + 本 script 再実行。
# - Vertex = ADC token (~60min TTL、40min 周期で rotator sidecar が自動再投入)。
# - GH = installation token (~60min TTL、50min 周期で gh-token-rotator が自動再投入)。
#
# Tavily の再実行頻度が極端に低い (= 通常は初回投入 + api key 再発行時のみ) ため、
# 本 script は **rotator sidecar を持たない**。DEN さんが手動 or `/init-project` 経由で叩く。
#
# 写経元: scripts/onecli-vertex-secret.sh (ADC 取得ロジックを TAVILY_API_KEY 読取に置換)
#
# 使い方 (local): `.env` に `TAVILY_API_KEY=tvly-...` を貼って `bash scripts/onecli-tavily-secret.sh`
#   or gcloud 経由: `TF_VAR_tavily_api_key=tvly-... terraform apply` (`terraform/tavily-secret/`) 済で
#   `bash scripts/onecli-tavily-secret.sh` (env 未設定なら SM 経由取得)
# 使い方 (GKE):
#   `terraform/tavily-secret/` apply 済の状態で
#   `kubectl exec -n biblio-claw biblio-orchestrator-0 -c orchestrator -- sh -c "cd /app && bash scripts/onecli-tavily-secret.sh"`
#   (env 経由不要、script が SM から取得。`gcloud` は orchestrator image に既存)

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
: "${TAVILY_SECRET_NAME:=biblio-claw-tavily}"
: "${TAVILY_API_HOST:=api.tavily.com}"
# Secret Manager fallback 用: secret 名 + project ID。両方 override 可能で、default は
# terraform/tavily-secret/ module が作成する `biblio-tavily-api-key` on `<your-gcp-project>`。
: "${TAVILY_SM_SECRET:=biblio-tavily-api-key}"
: "${TAVILY_SM_PROJECT:=${ANTHROPIC_VERTEX_PROJECT_ID:?required (export ANTHROPIC_VERTEX_PROJECT_ID or TAVILY_SM_PROJECT)}}"

ONECLI_API="${ONECLI_URL%/}/v1"

# OneCLI REST の認証 (AUTH_MODE=local では不要)。
OC_AUTH=()
if [ -n "${ONECLI_API_KEY:-}" ]; then
  OC_AUTH=(-H "Authorization: Bearer ${ONECLI_API_KEY}")
fi

# --- 共通 lib を読み込む (info / ok / fail / set_all_agents_mode_all) ---
# shellcheck source=scripts/onecli-lib.sh
. "${ROOT}/scripts/onecli-lib.sh"

# --- 依存確認 (Tavily は gcloud は SM fallback で optional、env のみで走らせる場合は不要) ---
for c in curl jq; do
  command -v "$c" >/dev/null 2>&1 || fail "必須コマンドが見つかりません: $c"
done

# 必須 env: TAVILY_API_KEY (env → Secret Manager fallback を通っても未取得なら fail)。
# onecli-gh-secret.sh の need() と同流儀 (「未設定」と「空文字設定」を同一扱い)。
need() {
  local v="$1"
  if [ -z "${!v:-}" ]; then
    fail "必須 env が未設定または空: $v (env / Secret Manager どちらでも未解決。local dev は .env に TAVILY_API_KEY=tvly-... を設定、GKE は 'terraform apply -var=\"tavily_api_key=tvly-...\"' で SM に投入して再実行、取得は https://tavily.com/)"
  fi
}

# resolve_tavily_key: env → Secret Manager → (fail は need() に委任) の順で解決する。
# 冪等 = 既に env に非空値があれば SM を叩かず即 return (無駄な gcloud call と audit log を抑制)。
# gcloud 不在 (local で SDK 入っていない環境) は SM 経路を skip する (info で明示、silent skip 撲滅)。
resolve_tavily_key() {
  if [ -n "${TAVILY_API_KEY:-}" ]; then
    info "[resolve] TAVILY_API_KEY を env 経由で取得 (local .env or shell 変数、SM 経路 skip)"
    return 0
  fi
  if ! command -v gcloud >/dev/null 2>&1; then
    info "[resolve] TAVILY_API_KEY env 未設定 + gcloud 不在 = Secret Manager fallback skip (この後 need() で fail-fast)"
    return 0
  fi
  info "[resolve] TAVILY_API_KEY env 未設定 → Secret Manager から取得を試行 (secret=$TAVILY_SM_SECRET / project=$TAVILY_SM_PROJECT)"
  # 失敗 (secret 未存在 / IAM 不足 / API 未有効化 / auth 切れ) は || true で捕捉して continue、
  # 直後の空値 check で分岐する。gcloud の stderr は捨てない (原因追跡のため素通し)。
  local sm_value
  sm_value="$(gcloud secrets versions access latest \
    --secret="$TAVILY_SM_SECRET" \
    --project="$TAVILY_SM_PROJECT" 2>&1)" \
    || {
      info "[resolve] gcloud secrets versions access が失敗 (上の gcloud エラーを確認。secret 未存在 / IAM 不足 / API 未有効化 / auth 切れの可能性、env fallback もなければ need() で fail-fast)"
      return 0
    }
  if [ -n "$sm_value" ]; then
    TAVILY_API_KEY="$sm_value"
    export TAVILY_API_KEY
    sm_value=""; unset sm_value
    ok "[resolve] Secret Manager から取得成功 (env fallback を経由せず SM primary path で確立)"
  else
    info "[resolve] Secret Manager から空値が返却 (secret 存在するが version data が空、この後 need() で fail-fast)"
  fi
}

# secret_id: name=$TAVILY_SECRET_NAME の secret id を stdout に返す (無ければ空)。
#   curl 失敗を fail で止めないと、呼び出し側が「未存在」と誤判定して
#   二重 POST 投入する Critical なバグになる (vertex-secret.sh:79-85 と同流儀)。
secret_id() {
  local out id
  out="$(curl -fsS "${OC_AUTH[@]}" "${ONECLI_API}/secrets")" \
    || fail "GET /v1/secrets への接続に失敗 (secret_id)"
  id="$(printf '%s' "$out" \
    | jq -r --arg n "$TAVILY_SECRET_NAME" '.[] | select(.name==$n) | .id' | head -n1)" \
    || fail "GET /v1/secrets のレスポンスが JSON パース不能 (OneCLI ログを確認)"
  printf '%s' "$id"
}

# ensure_secret: TAVILY_API_KEY を type:generic + authorization:Bearer の secret として投入。
#   未存在: POST /v1/secrets (期待 201、pathPattern は省略 = 全パスマッチ)
#   既存:   PATCH /v1/secrets/:id で value のみ partial update
#           (期待 200、id 保持 = hostPattern 解決の安定性)
#
# pathPattern 省略の repo 全体原則は issue #36 (2026-06-24 解消、PR #38) 準拠。
# 明示すると GKE で MITM injection が skip される既知障害の唯一の dependable 経路。
ensure_secret() {
  local host id
  host="$TAVILY_API_HOST"
  # TAVILY_API_KEY 自体は env で持ち、jq には env 経由 (argv 非経由) で流す。
  id="$(secret_id)"
  if [ -z "$id" ] || [ "$id" = "null" ]; then
    info "[secret] 未存在 → POST /v1/secrets で作成 (name=$TAVILY_SECRET_NAME / host=$host / pathPattern=omitted / header=authorization)"
    ( set -o pipefail
      SECRET_TOKEN="$TAVILY_API_KEY" jq -n \
          --arg name "$TAVILY_SECRET_NAME" --arg host "$host" \
          '{name:$name, type:"generic", value:env.SECRET_TOKEN, hostPattern:$host,
            injectionConfig:{headerName:"authorization", valueFormat:"Bearer {value}"}}' \
        | curl -fsS "${OC_AUTH[@]}" -X POST "${ONECLI_API}/secrets" \
            -H 'Content-Type: application/json' --data-binary @- >/dev/null
    ) || fail "secret 投入 (POST /v1/secrets) に失敗"
  else
    info "[secret] 既存 (id=$id) → PATCH /v1/secrets/$id で value のみ partial update (pathPattern は省略 = OneCLI 側保持)"
    ( set -o pipefail
      SECRET_TOKEN="$TAVILY_API_KEY" jq -n '{value:env.SECRET_TOKEN}' \
        | curl -fsS "${OC_AUTH[@]}" -X PATCH "${ONECLI_API}/secrets/$id" \
            -H 'Content-Type: application/json' --data-binary @- >/dev/null
    ) || fail "secret 更新 (PATCH /v1/secrets/$id) に失敗"
  fi
  unset SECRET_TOKEN
  ok "Tavily secret 投入 OK (name=${TAVILY_SECRET_NAME} / type=generic / host=${host} / headerName=authorization / valueFormat=Bearer {value} / 値はマスク)"
}

main() {
  resolve_tavily_key
  need TAVILY_API_KEY
  info "OneCLI REST=${ONECLI_API} / Tavily host=${TAVILY_API_HOST} / rotate=none (static key)"
  # stderr を捨てない: curl の接続エラーが「到達できない」だけだと debug 不能。
  curl -fsS "${OC_AUTH[@]}" "${ONECLI_API}/secrets" >/dev/null \
    || fail "OneCLI REST に到達できない (${ONECLI_API}) — 'docker compose up -d --wait' 済みか確認"
  ensure_secret
  set_all_agents_mode_all
  ok "完了: Tavily Bearer secret 投入 + agent all 化 (static key = 再実行は Tavily Dashboard で key regenerate 時のみ)"
}

main "$@"
