#!/usr/bin/env bash
# biblio-claw: M3 完成判定 verify (装備機構 + 蔵書一覧 6 assertion 統合 E2E)
#
# 全 6 assertion:
#   1. 装備マーカー検出 (verify-m3-phase-2.sh regression で消化)
#   2. ephemeral 解除 (装備源残置)    (同上)
#   3. 禁書 = clone 残置で再装備可    (verify-m3-phase-3.sh destructive で消化)
#   4. 焼却 = clone 物理削除で装備不可 (同上)
#   5. list-biblio (全件)              (Phase 5 で新規追加)
#   6. list-biblio (カテゴリ別)        (Phase 5 で新規追加)
#
# 引数:
#   --local-only   Docker local 経路のみ (Phase 1-2 regression に透過、Phase 3+5 本体は常に local)
#   --gke-only     GKE 経路のみ (同上。assertion 5/6 (= list-biblio) は常に local 実行のため、
#                  `M3 PASS (gke)` は「Phase 2 GKE assertion が通った + assertion 5/6 が local
#                  で通った」を意味する。完全 GKE-native 検証は将来 phase で別途)
#   (省略)         両方
#
# 環境変数 (必須、未設定で fail-fast = Phase 5 は M3 完成判定 skip 不可):
#   SHELF_REPO_OWNER / SHELF_REPO_NAME            棚 repo (= cleanup の `gh pr list --repo` で使用)
#   SHELF_PR_AUTHOR_NAME / SHELF_PR_AUTHOR_EMAIL  readShelveEnv() が要求 (shelve/unshelve commit author)
#   ANTHROPIC_VERTEX_PROJECT_ID                    host-proxy 経由の Vertex 接続
#   VERIFY_M3_P3_BIBLIO                            destructive E2E 対象 biblio (`<owner>--<name>` 形式、main merged 必須)
#   VERIFY_M3_P3_CATEGORY                          上記 biblio の category (biblio-dev|biblio-art|biblio-bf|biblio-ai)
#
# 前提 (local 経路):
#   - docker compose up -d --wait (= OneCLI gateway 起動 + 健康)
#   - scripts/onecli-vertex-secret.sh + scripts/onecli-gh-secret.sh で secret 投入 + mode=all 昇格済
#   - ./container/build.sh で nanoclaw-agent:latest 焼き済 (= jq + install-biblios.sh 入り)
#   - shelf に biblio が 1 件以上 shelve 済 (= assertion 5/6 が成立する状態、未投入なら biblio-shelve.ts)
#
# 後始末 (cleanup trap、EXIT/INT/TERM):
#   - shelf 上に残った enkin/shokyaku draft PR を `gh pr close --delete-branch` で auto-close
#     (= verify-m3-phase-3.sh:34-39 の手動 cleanup 課題を巻き取る)
#   - $STDERR_DIR を rm -rf
#
# 各 assert 失敗で exit 1。全通過で `M3 PASS (both|local|gke)` を出して exit 0。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# info/warn/fail/extract_result/json_field/json_array_length は verify-m3-helpers.sh に集約
# (PR #21 code-simplifier 推奨の Phase 横断重複解消)。
# shellcheck source=scripts/verify-m3-helpers.sh
source "$(dirname "${BASH_SOURCE[0]}")/verify-m3-helpers.sh"

# --- 引数 parse ---
# Phase 1-3 verify と同形。MODE は最終 PASS 出力でのみ使い、regression chain には
# "${@}" で透過 (= phase-3.sh → phase-2.sh → phase-1.sh が同じフラグを尊重)。
MODE='both'
case "${1:-}" in
  --local-only) MODE='local' ;;
  --gke-only)   MODE='gke'   ;;
  '')           ;;
  *)            fail "unknown arg: $1 — usage: verify-m3.sh [--local-only|--gke-only]" ;;
esac

# --- pre-flight ---
# .env は local 経路 (= docker compose で host から env を渡す) のもの。GKE 経路では
# manifest 経由で orchestrator container に env を直接投入する設計 (= Phase 4.6 bug 4 fix で
# SHELF_* 4 件投入済) のため `.env` ファイルは存在しない = 正常。必須 env の有無は後続の
# `${VAR:?msg}` で一括 fail-fast するので、`.env` 不在は warn 継続で十分。
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . .env
  set +a
else
  warn ".env が見つかりません — GKE 経路 (manifest env 直接投入) と想定して継続 (現在地: $PWD)"
fi

# 必須 env (Phase 5 = M3 完成判定 = skip 不可、未設定で fail-fast)。
# `${VAR:?msg}` は VAR が unset または empty なら msg を stderr に出して exit 1。
: "${SHELF_REPO_OWNER:?SHELF_REPO_OWNER must be set in .env (cleanup の gh pr list --repo で使用)}"
: "${SHELF_REPO_NAME:?SHELF_REPO_NAME must be set in .env}"
: "${SHELF_PR_AUTHOR_NAME:?SHELF_PR_AUTHOR_NAME must be set in .env (shelve/unshelve commit author)}"
: "${SHELF_PR_AUTHOR_EMAIL:?SHELF_PR_AUTHOR_EMAIL must be set in .env}"
: "${ANTHROPIC_VERTEX_PROJECT_ID:?ANTHROPIC_VERTEX_PROJECT_ID must be set in .env (vertex-client / host-proxy)}"
: "${VERIFY_M3_P3_BIBLIO:?VERIFY_M3_P3_BIBLIO must be set (Phase 5 は destructive E2E 必須 = 例: <owner>--<name>)}"
: "${VERIFY_M3_P3_CATEGORY:?VERIFY_M3_P3_CATEGORY must be set (例: biblio-dev|biblio-art|biblio-bf|biblio-ai)}"

# OneCLI proxy 到達確認 (= verify-m2.sh パターン、fail-slow 防止)。
# OneCLI 未起動 / 未認証で待たされるのを 数分 → 数秒 に縮める。
# probe_onecli は curl 優先 / node fetch fallback (= helpers 参照)、GKE distroless 対応。
# fail メッセージは MODE で local / gke 別の対処を案内 (= silent-failure-hunter 指摘で正、
# 旧版は GKE 経路でも「docker compose up」を提案して operator を誤誘導していた)。
ONECLI_URL_CHECK="${ONECLI_URL:-http://localhost:10254}"
if ! probe_onecli "$ONECLI_URL_CHECK"; then
  case "$MODE" in
    gke)
      fail "OneCLI proxy (${ONECLI_URL_CHECK}/v1/agents) に到達できません。
    対処 (GKE): orchestrator Pod 内 OneCLI sidecar が落ちている可能性。kubectl logs biblio-orchestrator-0 -n biblio-claw -c onecli で確認、必要なら kubectl rollout restart statefulset/biblio-orchestrator -n biblio-claw" ;;
    *)
      fail "OneCLI proxy (${ONECLI_URL_CHECK}/v1/agents) に到達できません。
    対処 (local): docker compose up -d --wait + scripts/onecli-{vertex,gh}-secret.sh で secret 投入" ;;
  esac
fi

# --- cleanup trap ---
# verify が立てた destructive draft PR を後始末する。Phase 3 destructive (enkin + shokyaku) が
# 各々 draft PR を残置するため、本 Phase 5 verify では trap で「`enkin/...` / `shokyaku/...`
# branch かつ open かつ draft」の PR を全部 close する。誤爆防止のため `is:pr is:open draft:true`
# + `head:enkin/ OR head:shokyaku/` の 3 条件で絞る。`gh pr close` 失敗は warn で続行
# (= cleanup ベストエフォート、verify 結果には影響させない)。
STDERR_DIR="$(mktemp -d -t biblio-m3-stderr-XXXXXX)"
LAST_HARNESS_STDERR=''

cleanup_destructive_prs() {
  # `enkin/<cat>--<name>-<ts>` / `shokyaku/<cat>--<name>-<ts>` branch 命名 (verify-m3-phase-3.sh:36-39)。
  # `head:enkin/` の prefix match で他用途の branch を誤って close しないよう絞る。
  # `gh pr list` 失敗 (= 認証切れ / network 障害 / repo 未存在) は cleanup ベストエフォート
  # 設計につき verify 結果には影響させないが、stderr を STDERR_DIR に取り込み warn で可視化
  # する (旧実装は `2>/dev/null || true` で失敗理由が完全に見えず、手動 cleanup 時に
  # 気づくしかなかった silent fail)。
  #
  # PR 作成直後の GitHub Search index eventual consistency ウィンドウ (= 5 秒以内に
  # search index が更新されない) を跨ぐため、search 前に短い sleep を入れる (= PR #20
  # Manual run で PR #13 取りこぼし観測 → PR #21 silent-failure-hunter Important で
  # `sleep 5` 追加が指摘された)。
  sleep 5
  local prs
  local pr_list_err="$STDERR_DIR/cleanup-gh-pr-list.stderr"
  prs="$(gh pr list --repo "$SHELF_REPO_OWNER/$SHELF_REPO_NAME" \
    --search 'is:pr is:open draft:true (head:enkin/ OR head:shokyaku/)' \
    --json number --jq '.[].number' 2>"$pr_list_err" || true)"
  if [ -s "$pr_list_err" ]; then
    warn "cleanup: gh pr list 失敗 (draft PR cleanup スキップの可能性、手動で gh pr list --repo $SHELF_REPO_OWNER/$SHELF_REPO_NAME --state open --search 'in:title enkin OR in:title shokyaku' を確認): $(tr '\n' ' ' < "$pr_list_err")"
  fi
  if [ -z "$prs" ]; then
    return
  fi
  local pr
  for pr in $prs; do
    info "cleanup: closing destructive draft PR #$pr on $SHELF_REPO_OWNER/$SHELF_REPO_NAME"
    if ! gh pr close --repo "$SHELF_REPO_OWNER/$SHELF_REPO_NAME" --delete-branch "$pr" >/dev/null 2>&1; then
      warn "draft PR close 失敗: #$pr (gh 認証 / 権限を確認、手動 close 可)"
    fi
  done
}

cleanup() {
  local exit_code=$?
  cleanup_destructive_prs
  rm -rf "$STDERR_DIR"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

# --- [1-4/6] Phase 1-3 regression chain ---
# verify-m3-phase-3.sh が verify-m3-phase-2.sh → verify-m3-phase-1.sh の chain を内側で持つ。
# 引数透過で --local-only / --gke-only / 空 が Phase 1-2 まで届く。Phase 3 destructive は
# 本スクリプトの pre-flight で env 必須化済みのため skip 経路には倒れない (= 必ず enkin/shokyaku
# が走り、後段の cleanup_destructive_prs で draft PR が回収される)。
info '=== [1-4/6] Phase 1-3 regression chain (verify-m3-phase-3.sh) ==='
info '  → assertion 1+2 (装備マーカー + ephemeral 解除) は Phase 2 で消化'
info '  → assertion 3+4 (禁書 + 焼却)               は Phase 3 destructive で消化'
bash scripts/verify-m3-phase-3.sh "${@}"

# --- [5/6] list-biblio (全件) ---
# `scripts/biblio-list.ts` は host-proxy + ProxyAgent を立ち上げて listBiblio() を直接呼ぶ
# 純粋関数経路 (= Slack adapter / MCP tool を通さない)。assertion は ok=true + total>0 +
# items.length===total の 3 つ。total=0 (= shelf に biblio 0 件) は seed 不足として fail する。
info '=== [5/6] list-biblio (全件) ==='
LAST_HARNESS_STDERR="$STDERR_DIR/list-all.stderr"
list_all_result="$(pnpm exec tsx scripts/biblio-list.ts \
  2>"$LAST_HARNESS_STDERR" | extract_result)"
[ -n "$list_all_result" ] || fail 'list-biblio (全件) が RESULT を出さなかった'

list_all_ok="$(json_field "$list_all_result" 'ok')"
[ "$list_all_ok" = 'true' ] || fail "list-biblio ok!=true: $list_all_result"

list_all_total="$(json_field "$list_all_result" 'total')"
# `<missing>` だと integer 比較で stderr に warning → `2>/dev/null` で抑止して
# fail メッセージで正しい原因 (= total が JSON に無い) を出す。
[ "$list_all_total" -gt 0 ] 2>/dev/null \
  || fail "list-biblio total<=0 (= shelf に biblio 0 件、bash scripts/biblio-shelve.ts ... で 1 件以上 seed してください): $list_all_result"

list_all_items_len="$(json_array_length "$list_all_result" 'items')"
[ "$list_all_items_len" = "$list_all_total" ] \
  || fail "list-biblio items.length($list_all_items_len) != total($list_all_total): $list_all_result"
info "  → 全件 $list_all_total 件取得 OK"

# --- [6/6] list-biblio (カテゴリ別、shelve 済 only) ---
# BIBLIO_CATEGORIES は src/biblio/types.ts:103 の正本 (= 4 値ハードコード)。
# 4 カテゴリへの shelve 配置は強制しない (= shelf 状態に強い前提を置かない)、0 件カテゴリは
# warn skip、1 件でも assertion を実行できれば PASS。全 4 カテゴリ 0 件のみ fail-fast。
info '=== [6/6] list-biblio (カテゴリ別、shelve 済 only) ==='
asserted_count=0
for cat in biblio-dev biblio-art biblio-bf biblio-ai; do
  cat_count="$(json_field "$list_all_result" "counts.$cat")"
  # cat_count が '<missing>' (JSON キー欠落) または <=0 (0 件) なら skip。
  # `-le` の前に文字列比較を先行させないと `<missing>` が数値比較に流れ込んで stderr に
  # warning が出るため `2>/dev/null` で抑止 (= 抑止対象は integer parse の warning のみ、
  # 本物のエラーは fail() 側で表示)。
  if [ "$cat_count" = '<missing>' ] || [ "$cat_count" -le 0 ] 2>/dev/null; then
    warn "  → $cat: shelf に 0 件、assertion skip"
    continue
  fi

  LAST_HARNESS_STDERR="$STDERR_DIR/list-$cat.stderr"
  cat_result="$(pnpm exec tsx scripts/biblio-list.ts "$cat" \
    2>"$LAST_HARNESS_STDERR" | extract_result)"
  [ -n "$cat_result" ] || fail "list-biblio($cat) が RESULT を出さなかった"

  cat_ok="$(json_field "$cat_result" 'ok')"
  cat_applied="$(json_field "$cat_result" 'appliedFilter')"
  cat_items_len="$(json_array_length "$cat_result" 'items')"

  [ "$cat_ok" = 'true' ] || fail "list-biblio($cat) ok!=true: $cat_result"
  [ "$cat_applied" = "$cat" ] || fail "list-biblio($cat) appliedFilter!=$cat: $cat_result"
  [ "$cat_items_len" = "$cat_count" ] \
    || fail "list-biblio($cat) items.length($cat_items_len) != counts.$cat($cat_count): $cat_result"

  # items 全件の category が一致することを確認 (= フィルタロジックの不変条件)。
  # 1 件でも違うと filter のバグ。node で in-process 比較 → exit 1 で本シェルに伝播。
  printf '%s' "$cat_result" | node -e "
let d=''; process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  const items = JSON.parse(d).items;
  const wrong = items.find(i => i.category !== process.argv[1]);
  if (wrong) { console.error('mismatch:', JSON.stringify(wrong)); process.exit(1); }
});" -- "$cat" \
    || fail "list-biblio($cat) で category 不一致な item を含む: $cat_result"

  info "  → $cat: $cat_count 件絞り込み OK"
  asserted_count=$((asserted_count + 1))
done
[ "$asserted_count" -gt 0 ] \
  || fail 'カテゴリ別 assertion を 1 件も実行できなかった (= 4 カテゴリ全てが 0 件、bash scripts/biblio-shelve.ts ... で seed してください)'
info "  → カテゴリ別 assertion 完了 ($asserted_count / 4 カテゴリ)"

# --- PASS 出力 ---
case "$MODE" in
  local) echo 'M3 PASS (local)' ;;
  gke)   echo 'M3 PASS (gke)' ;;
  *)     echo 'M3 PASS (both)' ;;
esac
