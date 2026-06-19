#!/usr/bin/env bash
# biblio-claw: M2 PRD B Phase 2 (検品) 機構 verify
#
# 4 fixture (src/biblio/__fixtures__/) を一時 quarantine にコピーし、host proxy +
# Vertex ProxyAgent 経由で inspect() を回して 3 値判定 (ACCEPT/HOLD/REJECT) と
# reason を assert する。PoC-14 verify.sh の assert スタイルを踏襲。
#
# 決定性検証 (= PRD 成功シグナル「同じ biblio に対し 3 回連続で判定が一致」):
#   4 fixture をそれぞれ 3 回ループし、全 12 回が期待 verdict / reason に一致することを確認する。
#
# 前提 (local docker compose 経路 — pre-flight で assert):
#   - docker compose up -d --wait 済 (OneCLI gateway = localhost:10254 / proxy = :10255)
#   - .env に ANTHROPIC_VERTEX_PROJECT_ID / CLOUD_ML_REGION 設定済
#   - host (pnpm run dev) は起動不要 — 本スクリプトが harness 内で initHostProxy/setupVertexProxy
#   - scripts/onecli-vertex-secret.sh で Vertex secret 投入 + 全 agent mode=all 昇格済
#     (host agent biblio-orchestrator-host が mode=all であることを pre-flight で確認)
#
# 各 assert 失敗で exit 1。全通過で "M2-B-P2 PASS" を出して exit 0。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

info() { printf '[INFO] %s\n' "$*" >&2; }
fail() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }

HARNESS="pnpm exec tsx scripts/biblio-inspect.ts"
HOST_AGENT_ID="biblio-orchestrator-host"
ONECLI_URL="${ONECLI_URL:-http://localhost:10254}"

FIXTURES_DIR="$ROOT/src/biblio/__fixtures__"
# 一時 quarantine — PID で衝突回避、trap で確実に掃除する (冪等 teardown)。
TMP_QUARANTINE="$(mktemp -d -t biblio-phase-2-verify-XXXXXX)"
cleanup() { rm -rf "$TMP_QUARANTINE"; }
trap cleanup EXIT INT TERM

# --- pre-flight 1: fixture 4 つが揃っているか ---
for name in clean-biblio bad-schema no-modify-license dangerous-code; do
  test -f "$FIXTURES_DIR/$name/.claude-plugin/plugin.json" \
    || fail "fixture が欠落: $FIXTURES_DIR/$name/.claude-plugin/plugin.json"
done

# --- pre-flight 2: host agent 登録 + mode=all 昇格 ---
# Phase 1 verify と同じ流れで host agent を OneCLI に作っておく (--register-only 経路を
# scripts/biblio-acquire.ts に温存)。biblio-inspect.ts も initHostProxy() で
# ensureAgent するため、ここで明示的に呼ばずとも初回 inspect で登録されるが、後続の
# mode=all 昇格 (= Vertex secret 注入の前提) を一発で済ませるためにここで先に登録する。
info "step 1: host agent を OneCLI に登録 (--register-only 経由)"
pnpm exec tsx scripts/biblio-acquire.ts --register-only >/dev/null 2>&1 \
  || fail "host agent 登録に失敗 (OneCLI 未起動?)"

# --- pre-flight 3: Vertex secret 投入 + mode=all 昇格 (実 LLM 経路) ---
info "step 2: onecli-vertex-secret.sh で Vertex secret 投入 + 全 agent mode=all"
bash "$ROOT/scripts/onecli-vertex-secret.sh" >/dev/null 2>&1 \
  || fail "onecli-vertex-secret.sh に失敗 (ADC 未認証 / OneCLI 未起動?)"

# --- pre-flight 4: host agent が mode=all になっているか確認 ---
# 「実 LLM で 3 回一致」が PRD 成功シグナルなので、ここを mock で逃さない設計
# (= 未充足なら手順を出して即 fail、部分検証へフォールバックしない、plan §リスク)。
info "step 3: host agent の secretMode を確認"
HOST_MODE="$(curl -fsS "$ONECLI_URL/v1/agents" 2>/dev/null \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d).find(x=>x.identifier==='$HOST_AGENT_ID');process.stdout.write(a?a.secretMode||'<none>':'<not-found>');})" \
  || echo '<curl-failed>')"
if [ "$HOST_MODE" != "all" ]; then
  fail "host agent ($HOST_AGENT_ID) の secretMode が 'all' ではない (got: $HOST_MODE)。再実行: bash scripts/onecli-vertex-secret.sh"
fi
info "  → host agent secretMode = all"

# --- 一時 quarantine に fixture を複製 ---
info "step 4: 4 fixture を一時 quarantine に複製: $TMP_QUARANTINE"
for name in clean-biblio bad-schema no-modify-license dangerous-code; do
  cp -r "$FIXTURES_DIR/$name" "$TMP_QUARANTINE/"
done

# harness の stdout から RESULT=<json> 行を取り出す。
run_inspect() {
  local name="$1" out
  out="$($HARNESS "$name" "$TMP_QUARANTINE" 2>/dev/null | sed -n 's/^RESULT=//p')" \
    || fail "harness 実行に失敗: $name"
  [ -n "$out" ] || fail "harness が RESULT を出さなかった: $name"
  printf '%s' "$out"
}

assert_verdict() {
  local json="$1" expected_verdict="$2" expected_reason="${3:-}"
  local got_verdict got_reason
  got_verdict="$(printf '%s' "$json" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{process.stdout.write(JSON.parse(d).verdict||'<missing>')})")"
  [ "$got_verdict" = "$expected_verdict" ] \
    || fail "verdict 不一致: expected=$expected_verdict got=$got_verdict json=$json"
  if [ -n "$expected_reason" ]; then
    got_reason="$(printf '%s' "$json" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{process.stdout.write(JSON.parse(d).reason||'<missing>')})")"
    [ "$got_reason" = "$expected_reason" ] \
      || fail "reason 不一致: expected=$expected_reason got=$got_reason json=$json"
  fi
}

# --- 4 fixture × 3 回ループ ---
# 期待 verdict / reason: clean=ACCEPT / bad-schema=REJECT/schema_invalid /
# no-modify-license=HOLD/license_denied / dangerous-code=REJECT/dangerous_code
declare -A EXPECTED_VERDICT EXPECTED_REASON
EXPECTED_VERDICT[clean-biblio]=ACCEPT
EXPECTED_REASON[clean-biblio]=
EXPECTED_VERDICT[bad-schema]=REJECT
EXPECTED_REASON[bad-schema]=schema_invalid
EXPECTED_VERDICT[no-modify-license]=HOLD
EXPECTED_REASON[no-modify-license]=license_denied
EXPECTED_VERDICT[dangerous-code]=REJECT
EXPECTED_REASON[dangerous-code]=dangerous_code

for name in clean-biblio bad-schema no-modify-license dangerous-code; do
  info "step 5: $name × 3 回 (期待 ${EXPECTED_VERDICT[$name]}${EXPECTED_REASON[$name]:+/${EXPECTED_REASON[$name]}})"
  for i in 1 2 3; do
    JSON="$(run_inspect "$name")"
    assert_verdict "$JSON" "${EXPECTED_VERDICT[$name]}" "${EXPECTED_REASON[$name]}"
    info "  iter $i ok"
  done
done

echo "M2-B-P2 PASS"
