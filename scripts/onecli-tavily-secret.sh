#!/usr/bin/env bash
# biblio-claw: OneCLI Tavily secret 投入 (M4-F Phase 3、life-capabilities)
#
# `.env` の `TAVILY_API_KEY` を OneCLI に
#   type:generic + injectionConfig{headerName:"authorization", valueFormat:"Bearer {value}"}
# の secret として投入し、hostPattern=api.tavily.com への request に
# `Authorization: Bearer <TAVILY_API_KEY>` を MITM 注入させる。creds は
# OneCLI secret store のみに置き、agent コンテナには一切渡さない
# (`container_configs.mcp_servers.tavily.env` は placeholder のまま)。
#
# あわせて全 agent を secretMode=all に昇格する (selective モードで作られた agent
# の 401 回避 / CLAUDE.md §シークレット gotcha)。
#
# ## Tavily / Vertex / GH の差分
# - Tavily = **static key** (rotate 不要、TTL 事実上無期限)。
#   `.env` の TAVILY_API_KEY 再取得 or Tavily Dashboard で regenerate 時のみ再実行。
# - Vertex = ADC token (~60min TTL、40min 周期で rotator sidecar が自動再投入)。
# - GH = installation token (~60min TTL、50min 周期で gh-token-rotator が自動再投入)。
#
# Tavily の再実行頻度が極端に低い (= 通常は初回投入 + api key 再発行時のみ) ため、
# 本 script は **rotator sidecar を持たない**。DEN さんが手動 or `/init-project` 経由で叩く。
#
# 写経元: scripts/onecli-vertex-secret.sh (ADC 取得ロジックを TAVILY_API_KEY 読取に置換)
#
# 使い方 (local): docker compose up -d --wait 後に `bash scripts/onecli-tavily-secret.sh`
# 使い方 (GKE):
#   TAVILY_API_KEY=tvly-... kubectl exec -n biblio-claw biblio-orchestrator-0 -c orchestrator -- \
#     env TAVILY_API_KEY=$TAVILY_API_KEY bash /scripts/onecli-tavily-secret.sh
#   (bootstrap 用の 1 回。Secret Manager 化 = Task 10 判断、runbook §M4-F Phase 3 参照)

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

ONECLI_API="${ONECLI_URL%/}/v1"

# OneCLI REST の認証 (AUTH_MODE=local では不要)。
OC_AUTH=()
if [ -n "${ONECLI_API_KEY:-}" ]; then
  OC_AUTH=(-H "Authorization: Bearer ${ONECLI_API_KEY}")
fi

# --- 共通 lib を読み込む (info / ok / fail / set_all_agents_mode_all) ---
# shellcheck source=scripts/onecli-lib.sh
. "${ROOT}/scripts/onecli-lib.sh"

# --- 依存確認 (Tavily は gcloud 不要 = static key) ---
for c in curl jq; do
  command -v "$c" >/dev/null 2>&1 || fail "必須コマンドが見つかりません: $c"
done

# 必須 env: TAVILY_API_KEY (`.env` or process.env)。空 or 未設定は fail-fast。
# onecli-gh-secret.sh の need() と同流儀 (「未設定」と「空文字設定」を同一扱い)。
need() {
  local v="$1"
  if [ -z "${!v:-}" ]; then
    fail "必須 env が未設定または空: $v (.env に TAVILY_API_KEY=tvly-... を設定して再実行、取得は https://tavily.com/)"
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
