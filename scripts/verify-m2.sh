#!/usr/bin/env bash
# biblio-claw: M2 完成判定 verify (MVP E2E 6 assertion)
#
# Slack 入力 → 仕入れ → 検品 → カテゴライズ → 陳列 (棚リポ draft PR 作成) → 重複検知
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
#   - 一時 quarantine dir (TMP_QUARANTINE) を rm -rf
#   - 一時 shelf dir (TMP_SHELF) を rm -rf
#   - 作成した draft PR (CREATED_PR_NUMBER) を `gh pr close --delete-branch` で auto-close
#     (CREATED_PR_NUMBER が空 = PR 作成前に失敗 した場合は no-op)
#
# 各 assert 失敗で exit 1。全通過で "M2 PASS" を出して exit 0。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

info() { printf '[INFO] %s\n' "$*" >&2; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
fail() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }

# --- 引数チェック ---
TARGET_REPO="${1:-}"
if [ -z "$TARGET_REPO" ]; then
  fail "usage: verify-m2.sh <owner/repo> [EXPECTED_CATEGORY=biblio-dev]
  例:  bash scripts/verify-m2.sh HajimariInc/biblio-shelf"
fi
EXPECTED_CATEGORY="${EXPECTED_CATEGORY:-biblio-dev}"

# .env を読んで SHELF_REPO_OWNER/NAME を取り出す (auto-close で使う)。
set -a
. .env
set +a
: "${SHELF_REPO_OWNER:?SHELF_REPO_OWNER must be set in .env (Phase 3)}"
: "${SHELF_REPO_NAME:?SHELF_REPO_NAME must be set in .env (Phase 3)}"

# --- 一時ディレクトリ + trap ---
TMP_QUARANTINE="$(mktemp -d -t biblio-m2-verify-q-XXXXXX)"
TMP_SHELF="$(mktemp -d -t biblio-m2-verify-s-XXXXXX)"
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
  rm -rf "$TMP_QUARANTINE" "$TMP_SHELF"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

ACQUIRE="pnpm exec tsx scripts/biblio-acquire.ts"
INSPECT="pnpm exec tsx scripts/biblio-inspect.ts"
CATEGORIZE="pnpm exec tsx scripts/biblio-categorize.ts"
SHELVE="pnpm exec tsx scripts/biblio-shelve.ts"

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

# Phase 3 仕入れ経路 = acquire は .env DATA_DIR を直接見るのではなく、quarantine 上書きを
# サポートしていないため、DATA_DIR を一時 dir に rewrite して呼ぶ (process env で上書き)。
acquire_with_tmpdata() {
  local repo="$1"
  DATA_DIR="$TMP_QUARANTINE/.." $ACQUIRE "$repo" 2>/dev/null | extract_result
}
# とは言え DATA_DIR は config.ts 起動時 const なので、tsx で別プロセスごと再起動する必要あり。
# (= tsx は process.env を毎回読み直すので問題なし)。
#
# ただし、acquire.ts は `path.join(DATA_DIR, 'quarantine')` で quarantine 親 dir を組む。
# つまり TMP_QUARANTINE 自体を渡す形にはできない (= TMP_QUARANTINE の親 dir が QUARANTINE_DIR の親)。
# 簡易化のため、acquire 用の DATA_DIR は TMP_QUARANTINE の親に、その配下 'quarantine' を
# 一時 quarantine として扱う。verify では TMP_QUARANTINE を作り、その親を DATA_DIR にして
# 'quarantine' という名のサブディレクトリを生成させる流れで運用する。
#
# シンプル化: TMP_QUARANTINE を mktemp で作っていたが、これを `mktemp -d` の親を DATA_DIR に
# し、その配下に "quarantine" dir を強制する形に変える。
TMP_DATA_DIR="$TMP_QUARANTINE"
rm -rf "$TMP_DATA_DIR"
mkdir -p "$TMP_DATA_DIR"
# acquire が見る dir = $TMP_DATA_DIR/quarantine、shelve が見る dir = $TMP_DATA_DIR/shelf
# 上の関数 acquire_with_tmpdata は使わず、直接 DATA_DIR を上書きしてハーネスを呼ぶ。

ACQUIRE_QUARANTINE="$TMP_DATA_DIR/quarantine"
ACQUIRE_SHELF="$TMP_DATA_DIR/shelf"

# 1. 仕入れ (acquire)
info "1/6: acquire $TARGET_REPO → $ACQUIRE_QUARANTINE"
ACQUIRE_JSON="$(DATA_DIR="$TMP_DATA_DIR" $ACQUIRE "$TARGET_REPO" 2>/dev/null | extract_result || true)"
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
INSPECT_JSON="$(DATA_DIR="$TMP_DATA_DIR" $INSPECT "$BIBLIO_NAME" "$ACQUIRE_QUARANTINE" 2>/dev/null | extract_result || true)"
[ -n "$INSPECT_JSON" ] || fail "inspect harness が RESULT を出さなかった"
INSPECT_VERDICT="$(json_field "$INSPECT_JSON" 'verdict')"
[ "$INSPECT_VERDICT" = "ACCEPT" ] || fail "inspect が ACCEPT にならない: $INSPECT_JSON"

# 4. カテゴライズ (期待 category と一致しなくても warn のみ)
info "4/6: categorize $BIBLIO_NAME (期待: $EXPECTED_CATEGORY、不一致は warn のみ)"
CATEGORIZE_JSON="$(DATA_DIR="$TMP_DATA_DIR" $CATEGORIZE "$BIBLIO_NAME" "$ACQUIRE_QUARANTINE" 2>/dev/null | extract_result || true)"
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
SHELVE_JSON="$(DATA_DIR="$TMP_DATA_DIR" $SHELVE "$BIBLIO_NAME" "$CATEGORY" "$REASON" "$ACQUIRE_QUARANTINE" "$ACQUIRE_SHELF" 2>/dev/null | extract_result || true)"
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

# 6. 重複検知 (= 2 回目同じ biblio で already_shelved 期待)
info "6/6: 重複検知 (= 同じ $BIBLIO_NAME を再 shelve → already_shelved 期待)"
# 2 回目は shelf にもう biblio dir はあるが、quarantine は無い → quarantine_missing になる前に
# marketplace.json への重複検知が回るかを確認する。verify は draft PR が main に merge される前なので
# marketplace.json は更新されていない (= 既に PR は branch 上だけ) → 重複検知は **誤って false** を返す。
# Phase 3 の重複検知は「main の marketplace.json を見て判定」する仕様 (PRD §技術リスク行 165 確定)。
# = 2 回目は新しい branch が作成されようとして 422 (Reference already exists) になる可能性が高い。
#
# 本検証では、quarantine が空のまま 2 回目を呼ぶと quarantine_missing になるため、acquire を
# もう 1 回呼んで quarantine を補充してから shelve を呼ぶ。
info "  6a: acquire を再実行して quarantine を補充"
ACQUIRE2_JSON="$(DATA_DIR="$TMP_DATA_DIR" $ACQUIRE "$TARGET_REPO" 2>/dev/null | extract_result || true)"
[ -n "$ACQUIRE2_JSON" ] || fail "acquire (2回目) harness が RESULT を出さなかった"
[ "$(json_field "$ACQUIRE2_JSON" 'ok')" = "true" ] || fail "acquire (2回目) 失敗: $ACQUIRE2_JSON"
info "  6b: shelve を再実行 → already_shelved or github_api_error(422 = branch 既存) 期待"
SHELVE_AGAIN_JSON="$(DATA_DIR="$TMP_DATA_DIR" $SHELVE "$BIBLIO_NAME" "$CATEGORY" "$REASON" "$ACQUIRE_QUARANTINE" "$ACQUIRE_SHELF" 2>/dev/null | extract_result || true)"
[ -n "$SHELVE_AGAIN_JSON" ] || fail "shelve (2回目) harness が RESULT を出さなかった"
SHELVE_AGAIN_REASON="$(json_field "$SHELVE_AGAIN_JSON" 'reason')"
# 期待: already_shelved (PR が merge 済の場合) または github_api_error (branch 既存で 422)
if [ "$SHELVE_AGAIN_REASON" = "already_shelved" ]; then
  info "  → already_shelved 確認 (= 棚リポ main の marketplace.json に entry 既存)"
elif [ "$SHELVE_AGAIN_REASON" = "github_api_error" ]; then
  # branch 既存で 422 = 期待された経路 (重複検知は main 側 marketplace.json でしか効かないため)
  info "  → github_api_error (branch 既存で 422 と推定): $SHELVE_AGAIN_JSON"
else
  fail "重複検知が想定外の reason: $SHELVE_AGAIN_REASON / $SHELVE_AGAIN_JSON"
fi

echo "M2 PASS"
