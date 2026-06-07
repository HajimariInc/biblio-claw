#!/usr/bin/env bash
# biblio-claw: Phase 1 結線の自動検証 (Task 7)
#
# 親 scripts/verify-phase-1.sh は Phase 1 完全版の入口で、その下流にいる本
# スクリプトが Task 1-5 (= 土台起動 + Vertex 接続) の自動検証を担う。
# Task 6/7 (Slack 往復) は外部依存 (Slack token + Event Subscriptions
# 設定 = DEN さん操作) のため、自動チェックは「Slack adapter が
# 取り込まれているか」と「.env に token が入っているか」までで、
# 1 往復の事実上は host を起動して手動確認する。
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

# --- ログヘルパ (stderr) ---
info() { printf '[INFO] %s\n' "$*" >&2; }
ok()   { printf '[OK] %s\n' "$*" >&2; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
fail() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }

# --- .env 読み込み (あれば、無くても進行) ---
if [ -f "${ROOT}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${ROOT}/.env"
  set +a
fi
: "${ONECLI_URL:=http://localhost:10254}"
: "${ANTHROPIC_VERTEX_PROJECT_ID:=hajimari-ai-hackathon-2026}"
: "${CLOUD_ML_REGION:=global}"
ONECLI_API="${ONECLI_URL%/}/v1"

# --- 1. compose 土台 ---
info "[1/5] docker compose 土台 (OneCLI + postgres)"
docker compose ps --format json 2>/dev/null | jq -r '.Name + " " + .State' | grep -q "biblio-onecli running" \
  || fail "biblio-onecli が起動していない — 'docker compose up -d --wait' を実行"
docker compose ps --format json 2>/dev/null | jq -r '.Name + " " + .State' | grep -q "biblio-claw-postgres-1 running" \
  || fail "biblio-claw-postgres-1 が起動していない — 'docker compose up -d --wait' を実行"
ok "OneCLI + postgres 起動中"

# --- 2. OneCLI REST 疎通 ---
info "[2/5] OneCLI REST 疎通 (${ONECLI_API}/secrets)"
http_code=$(curl -s -o /dev/null -w "%{http_code}" "${ONECLI_API}/secrets")
[ "$http_code" = "200" ] || fail "OneCLI REST が 200 を返さない (got=${http_code})"
ok "OneCLI REST OK (HTTP 200)"

# --- 3. Vertex secret 存在 ---
info "[3/5] Vertex secret (type=generic, host=vertex) が投入済か"
host_pattern=$([ "${CLOUD_ML_REGION}" = "global" ] \
  && echo "aiplatform.googleapis.com" \
  || echo "${CLOUD_ML_REGION}-aiplatform.googleapis.com")
curl -fsS "${ONECLI_API}/secrets" \
  | jq -e --arg h "$host_pattern" 'any(.[];
      .type=="generic" and .hostPattern==$h
      and .injectionConfig.headerName=="authorization"
      and (.injectionConfig.valueFormat|test("Bearer";"i")))' >/dev/null \
  || fail "Vertex secret が未投入 — 'bash scripts/onecli-vertex-secret.sh' を実行"
ok "Vertex secret OK (host=${host_pattern}, headerName=authorization, valueFormat=Bearer {value})"

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

# --- 6. Slack 結線状態 (自動チェックは存在確認のみ) ---
info "[+] Slack 結線状態 (参考: 自動チェックは存在確認のみ)"
slack_adapter_present="no"
slack_token_present="no"
[ -f "${ROOT}/src/channels/slack.ts" ] && grep -q "^import './slack.js';" "${ROOT}/src/channels/index.ts" 2>/dev/null \
  && slack_adapter_present="yes"
[ -n "${SLACK_BOT_TOKEN:-}" ] && [ -n "${SLACK_APP_TOKEN:-}" ] && slack_token_present="yes"
info "  slack adapter 取り込み: ${slack_adapter_present}"
info "  slack token (.env): ${slack_token_present}"
if [ "$slack_adapter_present" = "no" ] || [ "$slack_token_present" = "no" ]; then
  warn "Slack 1 往復 (Task 6/7 完全版) はまだ実行できない。次の plan で取り込み + DEN さん操作 (Slack app Event Subscriptions) 待ち"
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
ok " Slack 1 往復は Task 6 (Slack adapter 取り込み) 完了 + DEN さんの"
ok " Slack app 設定 (Event Subscriptions) 後に手動で確認 → 次の plan"
ok "================================================================"
