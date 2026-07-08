#!/usr/bin/env bash
# biblio-claw: Phase 1 結線の自動検証
#
# 親 scripts/verify-phase-1.sh の下流で、土台起動 (docker compose) +
# OneCLI 疎通 + Vertex secret 投入 + provider 配線 を 5 段で自動検証する。
# Slack 往復は外部依存 (Slack token + Event Subscriptions 設定 = DEN さん操作)
# のため本スクリプトの範囲外。参考として Slack 取り込み状態 + token 有無は
# 末尾で表示するが、自動 fail にはしない。1 往復の事実は host を起動して
# 手動確認する。
#
# 使い方:
#   bash scripts/verify-phase-1-wiring.sh
#
# 終了コード:
#   0  自動チェック全通過
#   1  自動チェックで失敗 (どの段で失敗したかは [FAIL] 行に出力)
#
# 前提:
#   .env を .env.example から作って Vertex project / region を埋めること。
#   gcloud auth application-default login --project <project> 済みであること。
#   smoke を回す場合は agent コンテナイメージが build 済みであること
#   (`./container/build.sh`)。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# --- .env 読み込み (あれば、無くても進行) ---
if [ -f "${ROOT}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${ROOT}/.env"
  set +a
fi
: "${ONECLI_URL:=http://localhost:10254}"
: "${ANTHROPIC_VERTEX_PROJECT_ID:?required (export ANTHROPIC_VERTEX_PROJECT_ID)}"
: "${CLOUD_ML_REGION:=global}"
ONECLI_API="${ONECLI_URL%/}/v1"

# --- 共通 lib を読み込む (info / ok / warn / fail / vertex_host)。
# 本 verify は set_all_agents_mode_all を呼ばないため OC_AUTH は不要。
# shellcheck source=scripts/onecli-lib.sh
. "${ROOT}/scripts/onecli-lib.sh"

# --- 1. compose 土台 ---
info "[1/5] docker compose 土台 (OneCLI + postgres)"
# stderr を捨てない — docker daemon 未起動 / compose ファイル不正 / permission
# 不足が「コンテナが起動していない」エラーに化けるのを防ぐ (本 PR レビュー指摘)。
compose_ps="$(docker compose ps --format json | jq -r '.Name + " " + .State')"
echo "$compose_ps" | grep -q "biblio-onecli running" \
  || fail "biblio-onecli が起動していない — 'docker compose up -d --wait' を実行 (docker daemon の起動も確認)"
echo "$compose_ps" | grep -q "biblio-postgres running" \
  || fail "biblio-postgres が起動していない — 'docker compose up -d --wait' を実行"
ok "OneCLI + postgres 起動中"

# --- 2. OneCLI REST 疎通 ---
info "[2/5] OneCLI REST 疎通 (${ONECLI_API}/secrets)"
# -sS: 進捗バーは抑制、curl 自身のエラー (DNS / TLS / 接続失敗) は stderr に
# 出す。curl が exit 非 0 で終わると %{http_code} が出力されないため、その
# 場合は "000" を明示代入して fail メッセージに「接続失敗」と分かる形にする。
http_code=$(curl -sS -o /dev/null -w "%{http_code}" "${ONECLI_API}/secrets") || http_code="000"
[ "$http_code" = "200" ] || fail "OneCLI REST が 200 を返さない (got=${http_code} / 000=接続失敗、それ以外は HTTP code)"
ok "OneCLI REST OK (HTTP 200)"

# --- 3. Vertex secret 存在 ---
info "[3/5] Vertex secret (type=generic, host=vertex) が投入済か"
# vertex_host は scripts/onecli-lib.sh で定義
host_pattern="$(vertex_host)"
# curl と jq の失敗を 1 つの `curl | jq || fail` にまとめると、curl の接続失敗
# (DNS / TLS / ポート不通) も「Vertex secret が未投入」と誤報して操作者を
# scripts/onecli-vertex-secret.sh の再実行に誘導する。curl と jq の失敗を分離。
# `2>&1` を使うと curl の stderr 警告 (TLS deprecation など) が body に混入して
# jq が parse 失敗するため、curl の成功/失敗判定だけ取り、失敗時の診断は別経路。
# step 3 で 1 回取得 → step 3.5 で再利用 (compose_ps と同じパターン)。
if ! secrets_resp="$(curl -fsS "${ONECLI_API}/secrets")"; then
  fail "OneCLI /secrets への接続失敗 (step 2 通過後) — OneCLI が落ちた可能性 (docker compose logs onecli) / 詳細は `curl -v ${ONECLI_API}/secrets` を手動実行"
fi
printf '%s' "$secrets_resp" \
  | jq -e --arg h "$host_pattern" 'any(.[];
      .type=="generic" and .hostPattern==$h
      and .injectionConfig.headerName=="authorization"
      and (.injectionConfig.valueFormat|test("Bearer";"i")))' >/dev/null \
  || fail "Vertex secret が未投入 — 'bash scripts/onecli-vertex-secret.sh' を実行"
ok "Vertex secret OK (host=${host_pattern}, headerName=authorization, valueFormat=Bearer {value})"

# --- 3.5 GH secret 存在 (= Sidecar 投入済) ---
info "[3.5/5] GH secret (type=generic, host=${GH_API_HOST:-api.github.com}) が投入済か"
# step 3 で取得した secrets_resp を再利用 (step 2 で OneCLI 疎通確認済み)。
printf '%s' "$secrets_resp" \
  | jq -e --arg h "${GH_API_HOST:-api.github.com}" 'any(.[];
      .type=="generic" and .hostPattern==$h
      and .injectionConfig.headerName=="authorization"
      and (.injectionConfig.valueFormat|test("Bearer";"i")))' >/dev/null \
  || fail "GH secret が未投入 — 'bash scripts/onecli-gh-secret.sh' を実行"
ok "GH secret OK (host=${GH_API_HOST:-api.github.com}, headerName=authorization, valueFormat=Bearer {value})"

# --- 4. provider 配線 (claude.ts が index.ts から import されているか) ---
info "[4/5] src/providers/index.ts が claude.ts を import しているか"
grep -q "^import './claude.js';" "${ROOT}/src/providers/index.ts" \
  || fail "src/providers/index.ts に \`import './claude.js';\` が無い — Task 3 が未反映"
ok "providers/index.ts に claude import あり"

# --- 5. host コードが Vertex env を伝搬する形になっているか (静的確認) ---
info "[5/5] claude provider config に Vertex env 群が定義されているか"
for key in CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_SKIP_VERTEX_AUTH ANTHROPIC_VERTEX_PROJECT_ID CLOUD_ML_REGION ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS; do
  grep -q "env\.${key}" "${ROOT}/src/providers/claude.ts" \
    || fail "src/providers/claude.ts に env.${key} の代入が無い — Task 3 が未反映"
done
ok "Vertex env 群 (7 キー) が claude provider config に揃っている"

# --- 6. Slack 結線状態 (自動チェックは存在確認のみ、1 往復は外部依存で手動) ---
info "[+] Slack 結線状態 (参考: 自動チェックは存在確認のみ、1 往復は手動目視)"
slack_adapter_present="no"
slack_token_present="no"
slack_socket_mode="no"
[ -f "${ROOT}/src/channels/slack.ts" ] && grep -q "^import './slack.js';" "${ROOT}/src/channels/index.ts" 2>/dev/null \
  && slack_adapter_present="yes"
[ -n "${SLACK_BOT_TOKEN:-}" ] && [ -n "${SLACK_APP_TOKEN:-}" ] && slack_token_present="yes"
[ -f "${ROOT}/src/channels/slack.ts" ] && grep -q "mode: 'socket'" "${ROOT}/src/channels/slack.ts" 2>/dev/null \
  && slack_socket_mode="yes"
info "  slack adapter 取り込み: ${slack_adapter_present}"
info "  slack adapter Socket Mode 化: ${slack_socket_mode}"
info "  slack token (.env): ${slack_token_present}"
if [ "$slack_adapter_present" = "yes" ] \
  && [ "$slack_socket_mode" = "yes" ] \
  && [ "$slack_token_present" = "yes" ]; then
  ok "Slack adapter + Socket Mode + token 投入済 (1 往復は手動目視確認)"
else
  warn "Slack 1 往復はまだ実行できない — 不足: adapter 取り込み / Socket Mode 化 / token (.env) のいずれか"
fi

# --- 完了 ---
ok "================================================================"
ok " Phase 1 wiring 自動検証: 通過 (土台 + Vertex 接続経路は成立)"
ok ""
ok " Smoke (Vertex 1 往復) を実体で確認するには:"
ok "   1) pnpm exec tsx scripts/init-cli-agent.ts --display-name <name> --agent-name <agent>"
ok "      (まだ cli agent group が無い場合のみ)"
ok "   2) pnpm run dev &  (host を起動)"
ok "   3) pnpm run chat 'Reply with exactly: BIBLIO_WIRING_OK'"
ok "      → 'BIBLIO_WIRING_OK' が返れば Vertex 経路成立"
ok ""
ok " Slack 1 往復は手動で目視確認:"
ok "   1) pnpm run dev &  (host を起動、Slack adapter が socket connected ログを出すこと)"
ok "   2) pnpm exec tsx scripts/init-first-agent.ts \\"
ok "        --channel slack \\"
ok "        --user-id slack:<DEN-Slack-userID> \\"
ok "        --platform-id slack:<DM-channelID> \\"
ok "        --display-name '<司書 agent 名>'"
ok "   3) Slack DM で司書に話しかけ、Vertex 経由応答が返れば Phase 1 マイルストーン達成"
ok "================================================================"
