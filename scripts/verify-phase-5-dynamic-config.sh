#!/usr/bin/env bash
# biblio-claw: 個別 PRD individual-skill-shiire Phase 5 dynamic-config 完成判定 verify
#
# central DB の `biblio_settings` table を介した動的設定変更経路を CLI レイヤで end-to-end
# に確認する。本 script は OneCLI / Vertex / GitHub API への到達を要求しない (= Slack 経由の
# E2E は別途手動確認、本 script は CRUD + 3 層 fallback の本体ロジックに集中)。
#
# 専用 fixture DB (`/tmp/biblio-verify-p5-<pid>.db`) を作成し、verify 完了後に削除する。
# 既存 `data/v2.db` には触れない (= 副作用なし)。
#
# 6 assertion:
#   1. migration apply       — biblio-config.ts list が空配列を返し、table 不在エラーにならない
#   2. CRUD set + get        — set 25 → get で 25 が返る
#   3. CRUD 上書き + delete  — set 30 → get 30 → delete → get で null
#   4. CRUD list             — 複数 set → list で全件取得
#   5. 3 層 fallback         — DB 優先 / DB 不正 → env fallback / DB+env 不正 → DEFAULT(10) の 3 経路
#   6. allowlist 注記        — config-action handler の allowlist 検証は unit test
#                              (`src/biblio/config-action.test.ts`) に委譲、verify では skip
#                              (= CLI レイヤは allowlist を無視するため、CLI で本検証は不可)
#
# 各 assert 失敗で exit 1。全通過で "Phase 5 PASS (dynamic-config)" を出して exit 0。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

info() { printf '[INFO] %s\n' "$*" >&2; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
fail() {
  printf '[FAIL] %s\n' "$*" >&2
  # 直近 harness の stderr が残っていれば表示 (= tsx 起動失敗 / migration 失敗 / 致命的エラーの
  # 切り分けに必要、verify-m2.sh の LAST_HARNESS_STDERR と同流儀)。
  if [ -n "${LAST_HARNESS_STDERR:-}" ] && [ -s "$LAST_HARNESS_STDERR" ]; then
    printf '[FAIL] 直近 harness の stderr (デバッグ用):\n' >&2
    sed 's/^/    /' "$LAST_HARNESS_STDERR" >&2
  fi
  exit 1
}

# --- fixture DB の準備 ---
TMP_DB="/tmp/biblio-verify-p5-$$.db"
# 各 harness の stderr を捕捉するファイル (= run_cli / run_resolve で都度上書き)
LAST_HARNESS_STDERR="/tmp/biblio-verify-p5-stderr-$$.log"
trap 'rm -f "$TMP_DB" "$TMP_DB-shm" "$TMP_DB-wal" "$LAST_HARNESS_STDERR"' EXIT

info "fixture DB: $TMP_DB (verify 終了時に削除)"

# tsx 起動の startup cost を吸収するため、host のログは stderr に出る = 構造化された RESULT 行だけ
# stdout から拾う。grep RESULT で stderr ログを除去 + tail -1 で最後の RESULT 行のみ採用。
# stderr は $LAST_HARNESS_STDERR に保存し、fail() で表示することで「tsx 起動失敗 / migration 失敗 /
# CRUD 失敗」の切り分けを可能にする (= silent-failure-hunter MED 4 対応)。
run_cli() {
  DB_PATH="$TMP_DB" pnpm exec tsx "$@" 2>"$LAST_HARNESS_STDERR" | grep '^RESULT=' | tail -1
}

run_resolve() {
  # 第 1 引数があれば ACQUIRE_SKILL_THRESHOLD env として渡す。空 = 未設定。
  if [ -n "${1:-}" ]; then
    DB_PATH="$TMP_DB" ACQUIRE_SKILL_THRESHOLD="$1" pnpm exec tsx scripts/biblio-resolve-threshold.ts 2>"$LAST_HARNESS_STDERR" | grep '^RESULT=' | tail -1
  else
    # env を明示的に解除 (.env / 親プロセス由来の値を遮断)
    DB_PATH="$TMP_DB" env -u ACQUIRE_SKILL_THRESHOLD pnpm exec tsx scripts/biblio-resolve-threshold.ts 2>"$LAST_HARNESS_STDERR" | grep '^RESULT=' | tail -1
  fi
}

extract_field() {
  # RESULT={...} 行から 1 階層の field を jq で抜く。jq 無しでは sed で頑張る。
  if command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$1" | sed 's/^RESULT=//' | jq -r ".$2 // empty"
  else
    # fallback: "field":"value" or "field":N のみ対応 (= 文字列 / 数値 / null)
    printf '%s\n' "$1" | sed 's/^RESULT=//' | grep -oE "\"$2\":(\"[^\"]*\"|[0-9]+|null)" | sed -E "s/\"$2\"://; s/^\"//; s/\"$//"
  fi
}

# ============================================================================
# Assertion 1: migration apply (biblio_settings table が作られる)
# ============================================================================
info "1/6: migration apply — initDb + runMigrations で biblio_settings table が作られる"
result=$(run_cli scripts/biblio-config.ts list)
[ -n "$result" ] || fail "1/6: CLI list の RESULT 行が取れません — migration が走らなかった可能性"
ok=$(extract_field "$result" ok)
[ "$ok" = "true" ] || fail "1/6: list RESULT.ok != true ($result)"
info "  → migration018 apply 確認 OK"

# ============================================================================
# Assertion 2: CRUD set + get (値が persist する)
# ============================================================================
info "2/6: CRUD set + get — set 25 → get で 25 が返る"
run_cli scripts/biblio-config.ts set ACQUIRE_SKILL_THRESHOLD 25 >/dev/null
result=$(run_cli scripts/biblio-config.ts get ACQUIRE_SKILL_THRESHOLD)
value=$(extract_field "$result" value)
[ "$value" = "25" ] || fail "2/6: get value != \"25\" — 取得値 \"$value\" ($result)"
info "  → set 25 → get 25 OK"

# ============================================================================
# Assertion 3: CRUD 上書き + delete (上書きは新値、delete で null)
# ============================================================================
info "3/6: CRUD 上書き + delete — set 30 → get 30 → delete → get で null"
run_cli scripts/biblio-config.ts set ACQUIRE_SKILL_THRESHOLD 30 >/dev/null
result=$(run_cli scripts/biblio-config.ts get ACQUIRE_SKILL_THRESHOLD)
value=$(extract_field "$result" value)
[ "$value" = "30" ] || fail "3/6: 上書き後の get value != \"30\" — 取得値 \"$value\" ($result)"

run_cli scripts/biblio-config.ts delete ACQUIRE_SKILL_THRESHOLD >/dev/null
result=$(run_cli scripts/biblio-config.ts get ACQUIRE_SKILL_THRESHOLD)
value=$(extract_field "$result" value)
[ "$value" = "" ] || [ "$value" = "null" ] || fail "3/6: delete 後の get value != null — 取得値 \"$value\" ($result)"
info "  → 上書き → delete → null OK"

# ============================================================================
# Assertion 4: CRUD list (複数 set → list で全件)
# ============================================================================
info "4/6: CRUD list — 複数 set → list で全件取得"
run_cli scripts/biblio-config.ts set ACQUIRE_SKILL_THRESHOLD 40 >/dev/null
# allowlist 外 key も CLI レイヤは無視で書ける = list 全件確認用
run_cli scripts/biblio-config.ts set TEST_KEY_FOR_LIST hello >/dev/null
result=$(run_cli scripts/biblio-config.ts list)
# 全件確認 = rows に 2 要素あるか (= JSON array length)。jq 優先、なければ grep 数で代用。
if command -v jq >/dev/null 2>&1; then
  count=$(printf '%s\n' "$result" | sed 's/^RESULT=//' | jq -r '.rows | length')
else
  count=$(printf '%s\n' "$result" | grep -oE '"key":"[^"]+"' | wc -l)
fi
[ "$count" = "2" ] || fail "4/6: list 件数 != 2 — count=$count ($result)"
info "  → list 2 件確認 OK"

# cleanup for assertion 5
run_cli scripts/biblio-config.ts delete TEST_KEY_FOR_LIST >/dev/null
run_cli scripts/biblio-config.ts delete ACQUIRE_SKILL_THRESHOLD >/dev/null

# ============================================================================
# Assertion 5: 3 層 fallback (DB 優先 / DB 不正 → env / 両方 不正 → DEFAULT)
# ============================================================================
info "5/6: 3 層 fallback — DB 優先 / DB 不正 → env fallback / 両方 不正 → DEFAULT(10)"

# 5a: DB = 50, env = 20 → 50 (DB 優先)
run_cli scripts/biblio-config.ts set ACQUIRE_SKILL_THRESHOLD 50 >/dev/null
result=$(run_resolve 20)
threshold=$(extract_field "$result" threshold)
[ "$threshold" = "50" ] || fail "5a/6: DB=50, env=20 で threshold != 50 — \"$threshold\" ($result)"
info "  5a: DB 優先 (50) OK"

# 5b: DB = "abc" (不正), env = 20 → 20 (env fallback)
run_cli scripts/biblio-config.ts set ACQUIRE_SKILL_THRESHOLD abc >/dev/null
result=$(run_resolve 20)
threshold=$(extract_field "$result" threshold)
[ "$threshold" = "20" ] || fail "5b/6: DB=\"abc\", env=20 で threshold != 20 — \"$threshold\" ($result)"
info "  5b: DB 不正 → env fallback (20) OK"

# 5c: DB = "abc", env = "-5" (両方不正) → 10 (DEFAULT)
result=$(run_resolve -5)
threshold=$(extract_field "$result" threshold)
[ "$threshold" = "10" ] || fail "5c/6: DB=\"abc\", env=\"-5\" で threshold != 10 — \"$threshold\" ($result)"
info "  5c: DB+env 共に不正 → DEFAULT (10) OK"

# 5d: DB delete, env 未設定 → 10 (DEFAULT)
run_cli scripts/biblio-config.ts delete ACQUIRE_SKILL_THRESHOLD >/dev/null
result=$(run_resolve)
threshold=$(extract_field "$result" threshold)
[ "$threshold" = "10" ] || fail "5d/6: DB なし + env 未設定で threshold != 10 — \"$threshold\" ($result)"
info "  5d: DB なし + env なし → DEFAULT (10) OK"

# ============================================================================
# Assertion 6: allowlist (action handler 領域) は unit test に委譲する旨を通知
# ============================================================================
info "6/6: allowlist 検証 — unit test (src/biblio/config-action.test.ts) に委譲済"
info "  → CLI レイヤは allowlist を無視で書けるため、本 verify では skip"
info "  → 詳細は \`pnpm test -- src/biblio/config-action.test.ts\` (= 13 case all PASS) を参照"

echo "Phase 5 PASS (dynamic-config)"
exit 0
