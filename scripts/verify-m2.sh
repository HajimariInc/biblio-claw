#!/usr/bin/env bash
# biblio-claw: M2 完成判定 verify (MVP E2E 6 assertion)
#
# Slack 入力 → 仕入れ → 検品 → カテゴライズ → 陳列 (棚リポ draft PR 作成) → 再 shelve graceful 失敗
# の 6 ステップを 1 度に流し、各段の RESULT を assert する。Phase 1+2 の Phase 単独
# verify を「順次連結」した構造 — 各 CLI ハーネス (`biblio-{acquire,inspect,categorize,shelve}.ts`)
# が `RESULT=<json>` を吐く流儀を踏襲。
#
# 前提 (local docker compose 経路 — pre-flight で assert):
#   - docker compose up -d --wait 済 (OneCLI gateway = localhost:10254 / proxy = :10255)
#   - .env に Vertex / GH / SHELF_* / CATEGORIZE_MODEL / INSPECT_DANGEROUS_MODEL 設定済
#   - scripts/onecli-vertex-secret.sh + onecli-gh-secret.sh で Vertex/GH secret 投入 + mode=all 昇格済
#   - GH App `hj-biblio-github-app` が SHELF_REPO_OWNER/SHELF_REPO_NAME に installation 済
#     (Task 0 で確認、permission = contents:write + pull_requests:write 必須)
#
# 引数:
#   $1 (必須): 仕入れ対象 repo (`owner/repo` 短縮形 or GitHub URL)
#   EXPECTED_CATEGORY env: 期待カテゴリ (既定 biblio-dev、判定が一致しなくても warn のみで fail にはしない)
#
# 後始末 (trap cleanup):
#   - 一時 DATA_DIR (TMP_DATA_DIR、配下に quarantine/ + shelf/) を rm -rf
#   - 作成した draft PR (CREATED_PR_NUMBER) を `gh pr close --delete-branch` で auto-close
#     (CREATED_PR_NUMBER が空 = PR 作成前に失敗 した場合は no-op)
#   - 各 harness の stderr を STDERR_DIR にキャプチャ、assert 失敗時に直近 1 つ分を表示
#
# 各 assert 失敗で exit 1。全通過で "M2 PASS" を出して exit 0。
#
# 6/6 assertion について (= 「重複検知」ではなく「再 shelve の graceful 失敗」):
#   verify は draft PR を main に merge しないため、棚リポ main の marketplace.json は
#   更新されない → 重複検知 (= shelve.ts:fetchMarketplace の plugins[].name 照合) は
#   常に「entry なし」と判定し、2 回目の shelve は重複として弾かれない。代わりに branch
#   作成で 422 (Reference already exists) で graceful に失敗する。verify はこの 2 経路の
#   どちらでも 「再 shelve が安全に止まる」ことを assertion 6 で確認する (= 重複検知機能の
#   完全な検証は marketplace.json が merge 後の状態でのみ可能、それは別途実機運用で確認)。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

info() { printf '[INFO] %s\n' "$*" >&2; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
fail() {
  printf '[FAIL] %s\n' "$*" >&2
  # 直近 harness の stderr があれば表示 (デバッグ支援)。
  if [ -n "${LAST_HARNESS_STDERR:-}" ] && [ -s "$LAST_HARNESS_STDERR" ]; then
    printf '[FAIL] 直近 harness の stderr (デバッグ用):\n' >&2
    sed 's/^/    /' "$LAST_HARNESS_STDERR" >&2
  fi
  exit 1
}

# --- 引数チェック ---
TARGET_REPO="${1:-}"
if [ -z "$TARGET_REPO" ]; then
  fail "usage: verify-m2.sh <owner/repo> [EXPECTED_CATEGORY=biblio-dev]
  例:  bash scripts/verify-m2.sh example-org/test-biblio-minimal"
fi
EXPECTED_CATEGORY="${EXPECTED_CATEGORY:-biblio-dev}"

# --- pre-flight ---
# 失敗を fail-slow (= LLM 401 retry を 3-5 分待ってから判定不能で死ぬ) ではなく fail-fast に
# 倒すための前提検証。token 期限切れ / OneCLI 未起動 / 必須 env 未設定をここで止めるだけで
# 体感の debug 時間が数分 → 数秒に縮む。
[ -f .env ] || fail ".env が見つかりません — repo root で実行してください (現在地: $PWD)。手順は docs/operations-runbook.md §「M2 完成判定 verify」を参照。"

set -a
. .env
set +a

# 必須 env の存在確認。SHELF_REPO_* は auto-close で使い、それ以外は各 harness 内部で参照する。
# ANTHROPIC_VERTEX_PROJECT_ID / CLOUD_ML_REGION は categorize.ts / vertex-client.ts が読む。
: "${SHELF_REPO_OWNER:?SHELF_REPO_OWNER must be set in .env}"
: "${SHELF_REPO_NAME:?SHELF_REPO_NAME must be set in .env}"
: "${ANTHROPIC_VERTEX_PROJECT_ID:?ANTHROPIC_VERTEX_PROJECT_ID must be set in .env}"
: "${INSPECT_DANGEROUS_MODEL:?INSPECT_DANGEROUS_MODEL must be set in .env}"
: "${CATEGORIZE_MODEL:?CATEGORIZE_MODEL must be set in .env}"

# OneCLI proxy の起動確認 (= docker compose up + 健康な状態であることを管理 API で確認)。
# token 期限切れの fail-slow 防止: secret 投入忘れの状態で 3-5 分待つのを避ける。
ONECLI_URL_CHECK="${ONECLI_URL:-http://localhost:10254}"
if ! curl -fsS --max-time 5 "${ONECLI_URL_CHECK}/v1/agents" >/dev/null 2>&1; then
  fail "OneCLI proxy (${ONECLI_URL_CHECK}/v1/agents) に到達できません。\
  対処: docker compose up -d --wait で起動確認 + scripts/onecli-{vertex,gh}-secret.sh で secret 投入"
fi

# --- 一時ディレクトリ + trap ---
# TMP_DATA_DIR を DATA_DIR として使い、その配下に quarantine/ と shelf/ を作らせる。
# (acquire.ts は `path.join(DATA_DIR, 'quarantine')` で組むため、DATA_DIR の親ではなく
#  DATA_DIR 自体を mktemp の dir に向ける)
TMP_DATA_DIR="$(mktemp -d -t biblio-m2-verify-XXXXXX)"
STDERR_DIR="$(mktemp -d -t biblio-m2-stderr-XXXXXX)"
LAST_HARNESS_STDERR=""
CREATED_PR_NUMBER=""
CREATED_BRANCH=""

cleanup() {
  local exit_code=$?
  if [ -n "$CREATED_PR_NUMBER" ]; then
    info "cleanup: closing draft PR #$CREATED_PR_NUMBER on $SHELF_REPO_OWNER/$SHELF_REPO_NAME"
    if ! gh pr close --repo "$SHELF_REPO_OWNER/$SHELF_REPO_NAME" --delete-branch "$CREATED_PR_NUMBER" >/dev/null 2>&1; then
      warn "draft PR close 失敗 (gh CLI 未認証 / 未インストール?): #$CREATED_PR_NUMBER。手動で close してください。"
    fi
  fi
  rm -rf "$TMP_DATA_DIR" "$STDERR_DIR"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

ACQUIRE="pnpm exec tsx scripts/biblio-acquire.ts"
INSPECT="pnpm exec tsx scripts/biblio-inspect.ts"
CATEGORIZE="pnpm exec tsx scripts/biblio-categorize.ts"
SHELVE="pnpm exec tsx scripts/biblio-shelve.ts"

ACQUIRE_QUARANTINE="$TMP_DATA_DIR/quarantine"
ACQUIRE_SHELF="$TMP_DATA_DIR/shelf"

# RESULT=<json> を取り出すヘルパ (verify-m2-b-phase-2.sh と同形)。
extract_result() {
  sed -n 's/^RESULT=//p'
}

# JSON フィールドを取り出すヘルパ (node 経由、jq 非依存)。
json_field() {
  local json="$1" key="$2"
  printf '%s' "$json" | node -e "
let d='';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(d);
    const k = process.argv[1];
    const v = k.split('.').reduce((acc, p) => acc?.[p], j);
    if (v === undefined || v === null) process.stdout.write('<missing>');
    else process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
  } catch (e) {
    process.stdout.write('<parse-error>');
  }
});
" -- "$key"
}

# harness 呼び出しヘルパ — stderr を STDERR_DIR に取り込み、assert 失敗時に表示できるよう保持する。
# stdout から RESULT=<json> 行のみ抽出。引数: $1=label (debug 用), $2-=実行コマンド
run_harness() {
  local label="$1"
  shift
  LAST_HARNESS_STDERR="$STDERR_DIR/$label.stderr"
  DATA_DIR="$TMP_DATA_DIR" "$@" 2>"$LAST_HARNESS_STDERR" | extract_result || true
}

# 1. 仕入れ (acquire)
info "1/6: acquire $TARGET_REPO → $ACQUIRE_QUARANTINE"
ACQUIRE_JSON="$(run_harness 'acquire-1' $ACQUIRE "$TARGET_REPO")"
[ -n "$ACQUIRE_JSON" ] || fail "acquire harness が RESULT を出さなかった"
ACQUIRE_OK="$(json_field "$ACQUIRE_JSON" 'ok')"
[ "$ACQUIRE_OK" = "true" ] || fail "acquire 失敗: $ACQUIRE_JSON"
BIBLIO_NAME="$(json_field "$ACQUIRE_JSON" 'biblioName')"
QUARANTINE_PATH="$(json_field "$ACQUIRE_JSON" 'quarantinePath')"
info "  → biblioName=$BIBLIO_NAME, quarantinePath=$QUARANTINE_PATH"

# 2. quarantine 配置確認
info "2/6: quarantine 配置確認: $QUARANTINE_PATH"
[ -d "$QUARANTINE_PATH" ] || fail "quarantine dir が存在しない: $QUARANTINE_PATH"

# 3. 検品 (inspect ACCEPT 期待)
info "3/6: inspect $BIBLIO_NAME (期待: ACCEPT)"
INSPECT_JSON="$(run_harness 'inspect' $INSPECT "$BIBLIO_NAME" "$ACQUIRE_QUARANTINE")"
[ -n "$INSPECT_JSON" ] || fail "inspect harness が RESULT を出さなかった"
INSPECT_VERDICT="$(json_field "$INSPECT_JSON" 'verdict')"
[ "$INSPECT_VERDICT" = "ACCEPT" ] || fail "inspect が ACCEPT にならない: $INSPECT_JSON"

# 4. カテゴライズ (期待 category と一致しなくても warn のみ)
info "4/6: categorize $BIBLIO_NAME (期待: $EXPECTED_CATEGORY、不一致は warn のみ)"
CATEGORIZE_JSON="$(run_harness 'categorize' $CATEGORIZE "$BIBLIO_NAME" "$ACQUIRE_QUARANTINE")"
[ -n "$CATEGORIZE_JSON" ] || fail "categorize harness が RESULT を出さなかった"
CATEGORIZE_OK="$(json_field "$CATEGORIZE_JSON" 'ok')"
[ "$CATEGORIZE_OK" = "true" ] || fail "categorize が ok:true にならない: $CATEGORIZE_JSON"
CATEGORY="$(json_field "$CATEGORIZE_JSON" 'category')"
REASON="$(json_field "$CATEGORIZE_JSON" 'reason')"
info "  → category=$CATEGORY"
if [ "$CATEGORY" != "$EXPECTED_CATEGORY" ]; then
  warn "判定 ($CATEGORY) が期待 ($EXPECTED_CATEGORY) と一致しません — そのまま陳列を続行します"
fi

# 5. 陳列 (shelve = shelf 移動 + 棚リポ PR 作成)
info "5/6: shelve $BIBLIO_NAME → $CATEGORY (= 棚リポ $SHELF_REPO_OWNER/$SHELF_REPO_NAME に draft PR 作成)"
SHELVE_JSON="$(run_harness 'shelve-1' $SHELVE "$BIBLIO_NAME" "$CATEGORY" "$REASON" "$ACQUIRE_QUARANTINE" "$ACQUIRE_SHELF")"
[ -n "$SHELVE_JSON" ] || fail "shelve harness が RESULT を出さなかった"
SHELVE_OK="$(json_field "$SHELVE_JSON" 'ok')"
[ "$SHELVE_OK" = "true" ] || fail "shelve 失敗: $SHELVE_JSON"
CREATED_PR_NUMBER="$(json_field "$SHELVE_JSON" 'prNumber')"
CREATED_BRANCH="$(json_field "$SHELVE_JSON" 'branchName')"
SHELVE_PR_URL="$(json_field "$SHELVE_JSON" 'prUrl')"
info "  → PR URL=$SHELVE_PR_URL (branch=$CREATED_BRANCH)"
# shelf 物理配置を確認
SHELF_PATH="$ACQUIRE_SHELF/$CATEGORY/$BIBLIO_NAME"
[ -d "$SHELF_PATH" ] || fail "shelf 物理配置が無い: $SHELF_PATH"

# 6. 再 shelve graceful 失敗 (= 重複検知 OR branch 既存 422 のどちらかで安全に止まる)
#
# verify は draft PR を main に merge しないため、棚リポ main の marketplace.json は
# 更新されない → 重複検知 (= fetchMarketplace の plugins[].name 照合) では誤って「entry なし」
# と判定される。代わりに branch 作成 (POST git/refs) で 422 (Reference already exists) が
# 返り、graceful に shelve が止まる。**重複検知機能そのもの** の完全 verify は marketplace.json
# が merge 後の状態でのみ可能で、本 verify のスコープ外。本 6/6 では「再 shelve が安全に止まる」
# ことを 2 経路の OR 判定で確認する。
info "6/6: 再 shelve が安全に止まる (already_shelved or github_api_error 422 のいずれか)"
info "  6a: acquire を再実行して quarantine を補充 (1 回目の shelve で quarantine は消えている)"
ACQUIRE2_JSON="$(run_harness 'acquire-2' $ACQUIRE "$TARGET_REPO")"
[ -n "$ACQUIRE2_JSON" ] || fail "acquire (2回目) harness が RESULT を出さなかった"
[ "$(json_field "$ACQUIRE2_JSON" 'ok')" = "true" ] || fail "acquire (2回目) 失敗: $ACQUIRE2_JSON"
info "  6b: shelve を再実行"
SHELVE_AGAIN_JSON="$(run_harness 'shelve-2' $SHELVE "$BIBLIO_NAME" "$CATEGORY" "$REASON" "$ACQUIRE_QUARANTINE" "$ACQUIRE_SHELF")"
[ -n "$SHELVE_AGAIN_JSON" ] || fail "shelve (2回目) harness が RESULT を出さなかった"
SHELVE_AGAIN_REASON="$(json_field "$SHELVE_AGAIN_JSON" 'reason')"
# 期待: already_shelved (PR merge 済の場合) または github_api_error (branch 既存で 422)
if [ "$SHELVE_AGAIN_REASON" = "already_shelved" ]; then
  info "  → already_shelved 確認 (= 棚リポ main の marketplace.json に entry 既存、PR が merge 済)"
elif [ "$SHELVE_AGAIN_REASON" = "github_api_error" ]; then
  # branch 既存で 422 (Reference already exists) を確実に判定する (= 想定経路の確認)
  SHELVE_AGAIN_DETAIL="$(json_field "$SHELVE_AGAIN_JSON" 'detail')"
  if printf '%s' "$SHELVE_AGAIN_DETAIL" | grep -q '422'; then
    info "  → github_api_error (branch 既存で 422 = 想定通り): $SHELVE_AGAIN_DETAIL"
  else
    fail "github_api_error だが 422 (Reference already exists) ではない: $SHELVE_AGAIN_JSON"
  fi
else
  fail "再 shelve が想定外の reason: $SHELVE_AGAIN_REASON / $SHELVE_AGAIN_JSON"
fi

echo "M2 PASS"
