#!/usr/bin/env bash
# biblio-claw: M2 PRD B Phase 1 (仕入れ) 機構 verify
#
# host proxy 経由で acquire() を直接駆動し、(1) 成功 + (2) ネガティブ対照 2 件
# (404 / manifest 不在) を assert する。PoC-7 verify.sh の assert スタイルを踏襲。
#
# 前提 (local docker compose 経路):
#   - docker compose up -d --wait 済 (OneCLI gateway = localhost:10254 / proxy = :10255)
#   - .env に GH_APP_ID / GH_INSTALLATION_ID / GH_APP_PEM_PATH 設定済
#     (host agent に GH token を mode=all 注入するため)
#   - host (pnpm run dev) は起動不要 — 本スクリプトが harness 内で initHostProxy を呼ぶ
#
# フロー:
#   1. harness --register-only で host agent を OneCLI に登録 (mode=all 昇格の前提)
#   2. onecli-gh-secret.sh で GH token 投入 + 全 agent mode=all (host agent 含む)
#   3. acquire を 3 ケース実行し reason を assert
#
# 各 assert 失敗で exit 1。全通過で "M2-B-P1 PASS" を出して exit 0。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

info() { printf '[INFO] %s\n' "$*" >&2; }
fail() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }

HARNESS="pnpm exec tsx scripts/biblio-acquire.ts"

# 対象 repo (差し替え可)。実在 biblio = manifest を持つ public repo を既定にする。
OK_REPO="${OK_REPO:-HajimariInc/biblio-shelf}"
# 404 対照: 実在しない repo。
NOT_FOUND_REPO="${NOT_FOUND_REPO:-HajimariInc/biblio-does-not-exist-m2bp1}"
# manifest 不在対照: 実在するが marketplace.json も SKILL.md も持たない public repo。
NO_MANIFEST_REPO="${NO_MANIFEST_REPO:-octocat/Hello-World}"

# harness の stdout から RESULT=<json> 行を取り出し、jq で .reason / .ok を読む。
run_acquire() {
  local repo="$1" out
  out="$($HARNESS "$repo" 2>/dev/null | sed -n 's/^RESULT=//p')" || fail "harness 実行に失敗: $repo"
  [ -n "$out" ] || fail "harness が RESULT を出さなかった: $repo"
  printf '%s' "$out"
}

assert_reason() {
  local json="$1" expected="$2"
  local got
  got="$(printf '%s' "$json" | jq -r '.reason // empty')"
  [ "$got" = "$expected" ] || fail "reason 不一致: expected=$expected got=${got:-<ok>} json=$json"
}

# --- 1. host agent 登録 ---
info "step 1: host agent を OneCLI に登録 (--register-only)"
$HARNESS --register-only >/dev/null 2>&1 || fail "host agent 登録に失敗 (OneCLI 未起動?)"

# --- 2. GH token 投入 + mode=all 昇格 ---
info "step 2: onecli-gh-secret.sh で GH token 投入 + 全 agent mode=all"
bash "$ROOT/scripts/onecli-gh-secret.sh" || fail "onecli-gh-secret.sh に失敗"

# --- 3a. 成功ケース ---
info "step 3a: 成功ケース $OK_REPO → quarantine 配置"
OK_JSON="$(run_acquire "$OK_REPO")"
[ "$(printf '%s' "$OK_JSON" | jq -r '.ok')" = "true" ] \
  || fail "成功ケースが ok:true にならない: $OK_JSON"
QPATH="$(printf '%s' "$OK_JSON" | jq -r '.quarantinePath')"
test -d "$QPATH" || fail "quarantine ディレクトリが無い: $QPATH"
info "  → 配置確認 OK: $QPATH"

# --- 3b. ネガティブ対照: 404 ---
info "step 3b: 404 対照 $NOT_FOUND_REPO → not_found"
assert_reason "$(run_acquire "$NOT_FOUND_REPO")" "not_found"

# --- 3c. ネガティブ対照: manifest 不在 ---
info "step 3c: manifest 不在対照 $NO_MANIFEST_REPO → manifest_missing"
assert_reason "$(run_acquire "$NO_MANIFEST_REPO")" "manifest_missing"

echo "M2-B-P1 PASS"
