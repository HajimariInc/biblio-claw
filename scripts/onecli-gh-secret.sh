#!/usr/bin/env bash
# biblio-claw: OneCLI GitHub installation token secret 投入 (Phase 1 Task 7-B / Sidecar 経路)
#
# GitHub App PEM → RS256 JWT → installation access token を発行し、OneCLI に
#   type:generic + injectionConfig{headerName:"authorization", valueFormat:"Bearer {value}"}
# の secret として投入する。OneCLI gateway は hostPattern=api.github.com 一致時に
# 上記ヘッダを MITM 注入するので、agent コンテナは creds 配付なしに `gh` で
# GitHub REST API に到達できる (= 認可は OneCLI 側に集約)。
#
# 既存 secret は PATCH /v1/secrets/:id で value 単独更新 (200, id 保持)、
# 未存在は POST /v1/secrets で作成 (201)。Vertex スクリプトの DELETE→POST 流儀
# とは異なり、~60min ローテーション想定で id 保持を優先 (PoC-12 で確定済の流儀)。
#
# あわせて全 agent を secretMode=all に昇格する (selective モードで作られた agent
# の 401 回避 / CLAUDE.md §シークレット 既知 gotcha)。
#
# 秘密の非露出 (絶対):
#   - PEM は `cat $GH_APP_PEM_PATH | node sign_jwt.cjs` の pipe 完結。
#     argv / 一時ファイル / 変数に PEM 値を載せない。
#   - JWT は curl --config - (stdin) で渡し、用済み即破棄 (unset)。
#   - installation token は env→jq→curl stdin (--data-binary @-) で渡す。
#     argv / shell history / log に出さない。set -x は使わない (トレース漏れ防止)。
#
# 写経元:
#   - 全体構造: biblio-claw scripts/onecli-vertex-secret.sh (.env 読込 / OC_AUTH / main)
#   - JWT / access_tokens: PoC-4 scripts/sidecar.sh:26-83
#   - secret upsert (POST/PATCH): PoC-4 scripts/secret.sh:50-86
#   - agent mode=all: biblio-claw scripts/onecli-vertex-secret.sh:118-149 を自己完結で再実装
#
# 使い方: docker compose up -d --wait + .env (GH_APP_ID/GH_INSTALLATION_ID/GH_APP_PEM_PATH) 投入後に
#   bash scripts/onecli-gh-secret.sh

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
: "${GH_API_HOST:=api.github.com}"
: "${GH_SECRET_NAME:=biblio-claw-gh-token}"
: "${GH_SECRET_HEADER:=authorization}"
: "${GH_SECRET_VALUE_FORMAT:=Bearer {value}}"
: "${JWT_EXP_SECONDS:=540}"

ONECLI_API="${ONECLI_URL%/}/v1"

# OneCLI REST の認証 (AUTH_MODE=local では不要)。
OC_AUTH=()
if [ -n "${ONECLI_API_KEY:-}" ]; then
  OC_AUTH=(-H "Authorization: Bearer ${ONECLI_API_KEY}")
fi

# --- 依存確認 (gcloud は Phase 1 では不要、PEM は local file) ---
for c in curl jq node; do
  command -v "$c" >/dev/null 2>&1 || fail "必須コマンドが見つかりません: $c"
done

# 必須 env チェック (空のまま cat すると曖昧なエラーになるため即 fail)。
need() {
  local v="$1"
  if [ -z "${!v:-}" ]; then
    fail "必須 env が未設定: $v (.env に追記して再実行)"
  fi
}

# mint_token: PEM → JWT → installation token を発行。
#   成功時: SIDECAR_GH_TOKEN (export) に token、SIDECAR_TOKEN_HTTP に HTTP code を設定。
#   PEM 値は変数 / argv / 一時ファイルに載らない (cat → node の pipe 完結)。
mint_token() {
  info "[sidecar] PEM 読込 ($GH_APP_PEM_PATH) → RS256 JWT 署名 (pipe 完結で PEM 破棄)"
  local jwt rc
  # PEM は cat の stdout を node に直接パイプ。代入されるのは node の出力 (= JWT) であり PEM ではない。
  jwt="$(cat "$GH_APP_PEM_PATH" | node "$ROOT/scripts/sign_jwt.cjs")"
  rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$jwt" ]; then
    fail "[sidecar] JWT 署名に失敗 (rc=$rc) — GH_APP_PEM_PATH=$GH_APP_PEM_PATH / GH_APP_ID=$GH_APP_ID を確認"
  fi

  info "[sidecar] POST /app/installations/$GH_INSTALLATION_ID/access_tokens (JWT は curl --config - stdin)"
  local resp http body token
  # JWT は curl の argv ではなく --config - (stdin) で渡す (base64url のみ、quote/backslash 不要)。
  resp="$(
    printf 'url = "https://%s/app/installations/%s/access_tokens"\nrequest = "POST"\nheader = "Accept: application/vnd.github+json"\nheader = "X-GitHub-Api-Version: 2022-11-28"\nheader = "Authorization: Bearer %s"\n' \
      "$GH_API_HOST" "$GH_INSTALLATION_ID" "$jwt" \
      | curl -sS --config - -w $'\n%{http_code}'
  )"
  rc=$?
  # JWT は用済み。確実に破棄。
  jwt=""; unset jwt
  if [ "$rc" -ne 0 ] || [ -z "$resp" ]; then
    fail "[sidecar] access_tokens エンドポイント呼び出しに失敗 (rc=$rc)"
  fi
  http="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  export SIDECAR_TOKEN_HTTP="$http"
  case "$http" in
    2??) : ;;
    *) fail "[sidecar] access_tokens が 2xx でない (http=$http / body 先頭は $(printf '%s' "$body" | head -c 200))" ;;
  esac
  token="$(printf '%s' "$body" | jq -r '.token // empty')"
  body=""; unset body
  [ -n "$token" ] || fail "[sidecar] レスポンスに .token が無い (http=$http)"
  export SIDECAR_GH_TOKEN="$token"
  token=""; unset token
  ok "[sidecar] installation token 取得 (http=$SIDECAR_TOKEN_HTTP / 値は SIDECAR_GH_TOKEN env / 非表示)"
}

# secret_id: name=$GH_SECRET_NAME の OneCLI secret id を stdout に返す (無ければ空)。
secret_id() {
  curl -fsS "${OC_AUTH[@]}" "${ONECLI_API}/secrets" \
    | jq -r --arg n "$GH_SECRET_NAME" '.[] | select(.name==$n) | .id' | head -n1
}

# upsert_gh_secret: SIDECAR_GH_TOKEN を OneCLI に投入。
#   未存在: POST /v1/secrets (期待 201)
#   既存: PATCH /v1/secrets/:id で value 単独更新 (期待 200、id 保持 = hostPattern 解決の安定性)
upsert_gh_secret() {
  local id
  id="$(secret_id)"
  if [ -z "$id" ] || [ "$id" = "null" ]; then
    info "[secret] 未存在 → POST /v1/secrets で作成 (name=$GH_SECRET_NAME / host=$GH_API_HOST / header=$GH_SECRET_HEADER)"
    SECRET_TOKEN="$SIDECAR_GH_TOKEN" jq -n \
        --arg name "$GH_SECRET_NAME" --arg host "$GH_API_HOST" \
        --arg header "$GH_SECRET_HEADER" --arg vfmt "$GH_SECRET_VALUE_FORMAT" \
        '{name:$name, type:"generic", value:env.SECRET_TOKEN, hostPattern:$host,
          injectionConfig:{headerName:$header, valueFormat:$vfmt}}' \
      | curl -fsS "${OC_AUTH[@]}" -X POST "${ONECLI_API}/secrets" \
          -H 'Content-Type: application/json' --data-binary @- >/dev/null \
      || fail "secret 投入 (POST /v1/secrets) に失敗"
    SECRET_OP="post"
  else
    info "[secret] 既存 (id=$id) → PATCH /v1/secrets/$id で value 単独更新"
    SECRET_TOKEN="$SIDECAR_GH_TOKEN" jq -n \
        '{value:env.SECRET_TOKEN}' \
      | curl -fsS "${OC_AUTH[@]}" -X PATCH "${ONECLI_API}/secrets/$id" \
          -H 'Content-Type: application/json' --data-binary @- >/dev/null \
      || fail "secret 更新 (PATCH /v1/secrets/$id) に失敗"
    SECRET_OP="patch"
  fi
  unset SECRET_TOKEN
  ok "[secret] $SECRET_OP 完了 (name=${GH_SECRET_NAME} / host=${GH_API_HOST} / valueFormat=${GH_SECRET_VALUE_FORMAT} / 値はマスク)"
}

# set_all_agents_mode_all: 既存全 agent を secretMode=all に昇格 (selective 401 回避)。
#   GET /v1/agents の失敗は 404 (バージョン差) を除いて fail。agent 未登録時は info でスキップ。
#   個別 PATCH は best-effort で継続 (Vertex スクリプトの実装をそのまま再実装 / 共有 lib 化はしない)。
set_all_agents_mode_all() {
  local body_file http_code ids n=0
  body_file="$(mktemp)"
  trap 'rm -f "$body_file"' RETURN
  http_code="$(curl -sS -o "$body_file" -w '%{http_code}' "${OC_AUTH[@]}" "${ONECLI_API}/agents")" \
    || fail "GET /v1/agents への接続に失敗 — OneCLI が起動しているか確認 (docker compose logs onecli)"
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
  ids="$(jq -r '.[].id' < "$body_file")"
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
  info "OneCLI REST=${ONECLI_API} / GH App=${GH_APP_ID:-(未設定)} / Installation=${GH_INSTALLATION_ID:-(未設定)}"
  need GH_APP_ID
  need GH_INSTALLATION_ID
  need GH_APP_PEM_PATH
  [ -r "$GH_APP_PEM_PATH" ] || fail "PEM ファイルが読めない: $GH_APP_PEM_PATH"
  curl -fsS "${OC_AUTH[@]}" "${ONECLI_API}/secrets" >/dev/null 2>&1 \
    || fail "OneCLI REST に到達できない (${ONECLI_API}) — 'docker compose up -d --wait' 済みか確認"
  mint_token
  upsert_gh_secret
  set_all_agents_mode_all
  unset SIDECAR_GH_TOKEN
  ok "完了: GH installation token 投入 + agent all 化 (token は ~60min で失効 → 再実行でフレッシュ化)"
}

main "$@"
