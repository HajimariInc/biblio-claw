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
# とは異なり、~60min ローテーション想定で id 保持を優先 (PoC-4 で確立した流儀)。
#
# あわせて全 agent を secretMode=all に昇格する (selective モードで作られた agent
# の 401 回避 / CLAUDE.md §シークレット 既知 gotcha)。
#
# 秘密の非露出 (絶対):
#   - PEM は `cat $GH_APP_PEM_PATH | node sign_jwt.cjs` の pipe 完結。
#     argv / 一時ファイル / 変数に PEM 値を載せない。
#   - JWT は printf 経由で curl --config - (stdin) に渡し、用済み即破棄 (unset)。
#     curl の -H argv には載らないが、printf の argv には載る (ps / /proc/<pid>/cmdline
#     で観測可能)。base64url のみで quote/backslash 不要のため shell escape 不要。
#   - installation token は env→jq→curl stdin (--data-binary @-) で渡す。
#     argv / shell history / log に出さない。set -x は使わない (トレース漏れ防止)。
#
# 写経元:
#   - 全体構造: biblio-claw scripts/onecli-vertex-secret.sh (.env 読込 / OC_AUTH / main)
#   - JWT / access_tokens: PoC-4 scripts/sidecar.sh:26-83
#   - secret upsert (POST/PATCH): PoC-4 scripts/secret.sh:50-86
#   - agent mode=all: biblio-claw scripts/onecli-vertex-secret.sh:118-149 を自己完結で再実装
#
# 使い方: docker compose up -d --wait + .env
#   (GH_APP_ID/GH_INSTALLATION_ID/GH_APP_PEM_PATH) 投入後に
#   bash scripts/onecli-gh-secret.sh

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

# --- 共通 lib を読み込む (info / ok / fail / set_all_agents_mode_all) ---
# shellcheck source=scripts/onecli-lib.sh
. "${ROOT}/scripts/onecli-lib.sh"

# --- 依存確認 (gcloud は Phase 1 では不要、PEM は local file) ---
for c in curl jq node; do
  command -v "$c" >/dev/null 2>&1 || fail "必須コマンドが見つかりません: $c"
done

# 必須 env チェック (空のまま cat すると曖昧なエラーになるため即 fail)。
# "${!v:-}" は「未設定」と「空文字設定 (= GH_APP_ID=)」を同一扱いするので、
# fail メッセージも両方を示唆する形にする (= 「未設定」だけだと .env で
# 空文字設定したユーザが混乱する)。
need() {
  local v="$1"
  if [ -z "${!v:-}" ]; then
    fail "必須 env が未設定または空: $v (.env に値を設定して再実行)"
  fi
}

# mint_token: PEM → JWT → installation token を発行。
#   成功時: SIDECAR_GH_TOKEN (export) に token、SIDECAR_TOKEN_HTTP に HTTP code を設定。
#   PEM 値は変数 / argv / 一時ファイルに載らない (cat → node の pipe 完結)。
mint_token() {
  info "[sidecar] PEM 読込 ($GH_APP_PEM_PATH) → RS256 JWT 署名 (pipe 完結で PEM 破棄)"
  local jwt rc
  # PEM は cat の stdout を node に直接パイプ。代入されるのは node の出力 (= JWT) であり PEM ではない。
  # set -o pipefail をサブシェル内で明示 ($(...) 内には外の pipefail が継承されない)。
  # これがないと cat の失敗 (EACCES / NFS I/O エラー) が隠れ、node が空 stdin を受けて
  # 「JWT 署名失敗」と誤表記される。
  jwt="$(set -o pipefail; cat "$GH_APP_PEM_PATH" | node "$ROOT/scripts/sign_jwt.cjs")"
  rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$jwt" ]; then
    fail "[sidecar] JWT 取得に失敗 (rc=$rc) — PEM 読込または crypto 署名に問題。GH_APP_PEM_PATH=$GH_APP_PEM_PATH / GH_APP_ID=$GH_APP_ID を確認"
  fi

  info "[sidecar] POST /app/installations/$GH_INSTALLATION_ID/access_tokens (JWT は printf 経由で curl --config - stdin)"
  local resp http body token
  # JWT は curl の直接の argv ではなく、printf 経由で --config - (stdin) に渡す。
  # (printf の argv には載る。base64url のみで quote/backslash 不要のため shell escape 不要)
  resp="$(
    printf 'url = "https://%s/app/installations/%s/access_tokens"\nrequest = "POST"\nheader = "Accept: application/vnd.github+json"\nheader = "X-GitHub-Api-Version: 2022-11-28"\nheader = "Authorization: Bearer %s"\n' \
      "$GH_API_HOST" "$GH_INSTALLATION_ID" "$jwt" \
      | curl --connect-timeout 5 --max-time 15 -sS --config - -w $'\n%{http_code}'
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
    *)
      # body の改行 / CR を除去 — マルチライン JSON エラーで [FAIL] 行が複数行に分散すると
      # 「次のステップの出力か?」と誤読しやすい。
      local body_preview
      body_preview="$(printf '%s' "$body" | head -c 200 | tr '\r\n' '  ')"
      fail "[sidecar] access_tokens が 2xx でない (http=$http) body: ${body_preview}"
      ;;
  esac
  token="$(printf '%s' "$body" | jq -r '.token // empty')"
  body=""; unset body
  [ -n "$token" ] || fail "[sidecar] レスポンスに .token が無い (http=$http)"
  export SIDECAR_GH_TOKEN="$token"
  token=""; unset token
  ok "[sidecar] installation token 取得 (http=$SIDECAR_TOKEN_HTTP / 値は SIDECAR_GH_TOKEN env / 非表示)"
}

# secret_id: name=$GH_SECRET_NAME の OneCLI secret id を stdout に返す (無ければ空)。
#   curl 出力を変数に受けてから jq に流す。curl 失敗を fail で止めないと、
#   呼び出し側が「未存在」と誤判定して二重 POST 投入する Critical なバグになる。
secret_id() {
  local out
  out="$(curl --connect-timeout 5 --max-time 15 -fsS "${OC_AUTH[@]}" "${ONECLI_API}/secrets")" \
    || fail "GET /v1/secrets への接続に失敗 (secret_id)"
  printf '%s' "$out" \
    | jq -r --arg n "$GH_SECRET_NAME" '.[] | select(.name==$n) | .id' | head -n1
}

# upsert_gh_secret: SIDECAR_GH_TOKEN を OneCLI に投入。
#   未存在: POST /v1/secrets (期待 201、pathPattern は省略 = 全パスマッチ)
#   既存:   PATCH /v1/secrets/:id で value のみ partial update
#           (期待 200、id 保持 = hostPattern 解決の安定性)
#
#   pathPattern を省略する論拠 (issue #36、2026-06-24 解析):
#   - OneCLI v1.30.0 では pathPattern を string で明示すると GKE 環境で MITM
#     Authorization injection が呼ばれず 401 になる (= ローカルでは動くが GKE で skip
#     される環境差分。WHY 3 の根本原因は未解明、修復候補 B の別 issue 候補)。
#   - vertex 側 (scripts/onecli-vertex-secret.sh) + PoC-2/4/12 は全て pathPattern
#     省略経路で両環境で injection 動作実証済 (= dependable な唯一の経路)。
#   - scope 最小化は GH App installation の repo 限定 (= biblio-shelf + biblio-claw
#     の 2 repo) で別経路担保。pathPattern による最小権限化は採用しない。
#   - PATCH では value のみ送る (= hostPattern / injectionConfig / 既存 pathPattern
#     は OneCLI 側で保持される)。**新規環境では POST 経路で pathPattern キーを送らない
#     ことで wildcard match を確立できる**。ただし既存環境で旧 pathPattern が残置済の
#     場合は、本スクリプトの再実行 (= PATCH partial update) だけでは null 化されない
#     — `docs/operations-runbook.md` §「落とし穴: OneCLI pathPattern を string で
#     明示すると GKE で injection skip」§既存環境の修復 の DELETE + POST 手順を参照。
#
#   jq | curl のパイプ全体はサブシェルで set -o pipefail を有効化。
#   有効化しないと jq の失敗 (invalid JSON 生成) が curl の rc に隠れる。
#   token は SECRET_TOKEN env 経由で jq に渡す (シェル変数 / argv 非経由)。
#
#   response body 検証は意図的に行わない (curl `-fsS ... >/dev/null` で body 破棄)。
#   OneCLI v1.30.0 仕様では 2xx 応答 → injectionConfig / hostPattern が effective が
#   保証されている。将来仕様変化で「2xx を返しながら設定を黙って無視」する silent
#   regression が起きうるリスクは残るが、現在の防衛線は `/init-project verify` の
#   Section 1 (= GET /v1/secrets で設定 test) + scripts/verify-m2.sh の E2E (= 棚リポ
#   操作が authenticated で通れば secret が effective)。自動 assertion を入れるなら
#   本関数末尾で GET /v1/secrets/<id> 再取得 + jq assert する形 (= 別タスク、既存
#   vertex / GH 双方の curl 流儀を見直す範囲)。
upsert_gh_secret() {
  local id
  id="$(secret_id)"
  if [ -z "$id" ] || [ "$id" = "null" ]; then
    info "[secret] 未存在 → POST /v1/secrets で作成 (name=$GH_SECRET_NAME / host=$GH_API_HOST / pathPattern=omitted / header=$GH_SECRET_HEADER)"
    ( set -o pipefail
      SECRET_TOKEN="$SIDECAR_GH_TOKEN" jq -n \
          --arg name "$GH_SECRET_NAME" --arg host "$GH_API_HOST" \
          --arg header "$GH_SECRET_HEADER" --arg vfmt "$GH_SECRET_VALUE_FORMAT" \
          '{name:$name, type:"generic", value:env.SECRET_TOKEN, hostPattern:$host,
            injectionConfig:{headerName:$header, valueFormat:$vfmt}}' \
        | curl --connect-timeout 5 --max-time 15 -fsS "${OC_AUTH[@]}" -X POST "${ONECLI_API}/secrets" \
            -H 'Content-Type: application/json' --data-binary @- >/dev/null
    ) || fail "secret 投入 (POST /v1/secrets) に失敗"
    SECRET_OP="post"
  else
    info "[secret] 既存 (id=$id) → PATCH /v1/secrets/$id で value のみ partial update (pathPattern は省略 = OneCLI 側保持)"
    ( set -o pipefail
      SECRET_TOKEN="$SIDECAR_GH_TOKEN" jq -n \
          '{value:env.SECRET_TOKEN}' \
        | curl --connect-timeout 5 --max-time 15 -fsS "${OC_AUTH[@]}" -X PATCH "${ONECLI_API}/secrets/$id" \
            -H 'Content-Type: application/json' --data-binary @- >/dev/null
    ) || fail "secret 更新 (PATCH /v1/secrets/$id) に失敗"
    SECRET_OP="patch"
  fi
  unset SECRET_TOKEN
  ok "[secret] $SECRET_OP 完了 (name=${GH_SECRET_NAME} / host=${GH_API_HOST} / pathPattern=omitted / valueFormat=${GH_SECRET_VALUE_FORMAT} / 値はマスク)"
}

# set_all_agents_mode_all は scripts/onecli-lib.sh で定義済み。

main() {
  need GH_APP_ID
  need GH_INSTALLATION_ID
  need GH_APP_PEM_PATH
  # pathPattern は省略経路 (= 全パスマッチ) を採用するため SHELF_REPO_OWNER は不要。
  # scope 最小化は GH App installation の repo 限定 (= biblio-shelf + biblio-claw の 2 repo)
  # で担保される。詳細は issue #36 (OneCLI v1.30.0 GKE で pathPattern 明示時 injection skip)。
  # SHELF_REPO_OWNER 自体は verify-m2/m3/slack-e2e-gke の gh pr cleanup で他経路から必要なので
  # .env / manifest からは削除しない (本スクリプトでの依存だけ消す)。
  info "OneCLI REST=${ONECLI_API} / GH App=${GH_APP_ID} / Installation=${GH_INSTALLATION_ID} / pathPattern=<omitted = wildcard match>"
  [ -r "$GH_APP_PEM_PATH" ] || fail "PEM ファイルが読めない: $GH_APP_PEM_PATH"
  # stderr を捨てない — curl の接続エラー (DNS / TLS / 接続拒否のメッセージ) が
  # 「到達できない」だけだと debug 不能になるため、curl 自身のエラーは端末に流す。
  curl --connect-timeout 5 --max-time 15 -fsS "${OC_AUTH[@]}" "${ONECLI_API}/secrets" >/dev/null \
    || fail "OneCLI REST に到達できない (${ONECLI_API}) — 'docker compose up -d --wait' 済みか確認"
  mint_token
  upsert_gh_secret
  set_all_agents_mode_all
  unset SIDECAR_GH_TOKEN
  ok "完了: GH installation token 投入 + agent all 化 (token は ~60min で失効 → 再実行でフレッシュ化)"
}

main "$@"
