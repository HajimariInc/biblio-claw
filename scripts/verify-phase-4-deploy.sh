#!/usr/bin/env bash
# biblio-claw: Phase 4 (deploy-verify) GKE 統合 verify
#
# init-project-gcp PRD Phase 4 の本丸。GKE Autopilot biblio-prod に対して以下 3 ブロックを実行:
#
#   Block 1: Phase 2 構造化ログの GKE 実機観測
#     - kubectl logs biblio-orchestrator-0 -c orchestrator --since=300s から JSON 行を取得
#     - 必須 4 field (severity / message / time / component) を node で assert
#     - component=host-orchestrator (= k8s/10-orchestrator-statefulset.yaml:186 で投入) を確認
#     - gh-token-rotator も同様。ただし 50min 周期 rotation のため直近 600s に出ない場合は WARN
#
#   Block 2: M3 装備機構の GKE 動作
#     - 既存 scripts/verify-m3-phase-2.sh --gke-only を call (= PVC fixture 投入 + spawn-verify)
#     - exit code で pass/fail を判定
#
#   Block 3: M3 蔵書リスト (list_biblio) の GKE 動作
#     - kubectl exec biblio-orchestrator-0 -c orchestrator -- sh -c "cd /app && pnpm exec tsx scripts/biblio-list.ts"
#     - 全件 + 4 カテゴリ (biblio-dev|biblio-art|biblio-bf|biblio-ai) を RESULT 解析で assert
#
# 引数: なし (= GKE 経路のみ、cluster context gate で biblio-prod 専用)
#
# 前提:
#   - kubectl context = gke_*_biblio-prod (= verify-phase-2-wiring.sh と同じ gate)
#   - orchestrator StatefulSet readyReplicas=1 (= Block 1 開始前に確認)
#   - LOG_FORMAT=json + LOG_COMPONENT=host-orchestrator が StatefulSet env で投入済 (Phase 2)
#   - 棚 (HajimariInc/biblio-shelf) に biblio 1 件以上 (Block 3 の total>0 assertion)
#
# 各 assert 失敗で exit 1。全通過で `Phase 4 PASS (GKE deploy-verify)` を出して exit 0。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# info/warn/fail/extract_result/json_field/json_array_length は verify-m3-helpers.sh に集約
# (M3 PRD Phase 5 PR #21 code-simplifier 推奨)。本 Phase 4 で必要だが helpers に未集約な
# ok() のみ局所定義 (= onecli-lib.sh と verify-m3-helpers.sh の両 source は info/warn/fail の
# 二重定義で責任境界を曖昧にするため避ける流儀、CLAUDE.md memory biblio-design-overthinking-avoidance と整合)。
# shellcheck source=scripts/verify-m3-helpers.sh
source "$(dirname "${BASH_SOURCE[0]}")/verify-m3-helpers.sh"
ok() { printf '[OK]   %s\n' "$*" >&2; }

NS='biblio-claw'
ORCH_POD='biblio-orchestrator-0'

info "==== Phase 4 GKE deploy-verify (namespace=$NS) ===="

# --- pre-flight: kubectl context gate ---
# 別 cluster で誤実行しないための gate (= verify-phase-2-wiring.sh:32-36 と同パターン)。
ctx="$(kubectl config current-context 2>/dev/null || echo '<none>')"
case "$ctx" in
  gke_*_biblio-prod) ok "[ctx] $ctx" ;;
  *) fail "[ctx] kubectl context が biblio-prod ではない (= $ctx)。実行: gcloud container clusters get-credentials biblio-prod --region=asia-northeast1 --project=hajimari-ai-hackathon-2026" ;;
esac

# --- pre-flight: orchestrator StatefulSet ready ---
# Block 1 (kubectl logs) / Block 2 (verify-m3-phase-2.sh --gke-only) / Block 3 (kubectl exec) の
# 全てが orchestrator Pod が Running 前提。先に弾く。
ready="$(kubectl get statefulset biblio-orchestrator -n "$NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)"
[ "$ready" = "1" ] || fail "[orchestrator] StatefulSet readyReplicas != 1 (actual=$ready)。kubectl describe statefulset biblio-orchestrator -n $NS で原因確認"
ok "[orchestrator] StatefulSet ready=$ready"

# === Block 1: Phase 2 ログ GKE 実機観測 ============================================
info '=== Block 1: Phase 2 構造化ログの GKE 実機観測 ==='

# orchestrator container の直近 300s の JSON ログを取得。
# ANSI escape 剥がし必須 (= verify-phase-2-wiring.sh:157 と同パターン、剥がさないと grep regex が外れる)。
# container 名は `-c orchestrator` で明示 (= 同 Pod 内に onecli / cloud-sql-proxy / gh-token-rotator /
# vertex-token-rotator が居るためデフォルト推定に頼らない)。
recent_logs="$(kubectl logs "$ORCH_POD" -n "$NS" -c orchestrator --since=300s 2>/dev/null \
  | sed -r 's/\x1b\[[0-9;]*m//g' \
  | grep -E '^\{.*"severity":.*"component":.*\}' \
  | head -20 || true)"
if [ -z "$recent_logs" ]; then
  fail "[log-gke] orchestrator container の直近 300s に JSON ログ 1 行も観測できない (= LOG_FORMAT=json env 未反映 / Pod がログを吐いていない可能性)。kubectl logs $ORCH_POD -c orchestrator -n $NS で生ログ確認"
fi
info "[log-gke] orchestrator JSON 行 $(printf '%s\n' "$recent_logs" | wc -l) 件観測"

# 1 行 sample で必須 4 field (severity/message/time/component) + component 値を assert。
# parse 失敗時の sample 出力で原因可視化 (= silent-failure-hunter 観点)。
sample_line="$(printf '%s\n' "$recent_logs" | head -1)"
printf '%s' "$sample_line" | node -e "
let d='';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(d);
    for (const k of ['severity', 'message', 'time', 'component']) {
      if (j[k] === undefined) {
        process.stderr.write('missing key: ' + k + '\n');
        process.exit(1);
      }
    }
    if (j.component !== 'host-orchestrator') {
      process.stderr.write('component expected host-orchestrator, got: ' + j.component + '\n');
      process.exit(1);
    }
  } catch (e) {
    process.stderr.write('parse error: ' + e.message + '\n');
    process.exit(1);
  }
});
" || fail "[log-gke] orchestrator JSON ログに必須 4 field が揃わない (sample: $sample_line)"
ok "[log-gke] orchestrator JSON ログ必須 field (severity/message/time/component=host-orchestrator) OK"

# gh-token-rotator container の直近 600s も同様に確認。
# 50min 周期 rotation のため直近 600s に出ないタイミングがある → FAIL ではなく WARN。
rotator_logs="$(kubectl logs "$ORCH_POD" -n "$NS" -c gh-token-rotator --since=600s 2>/dev/null \
  | sed -r 's/\x1b\[[0-9;]*m//g' \
  | grep -E '^\{.*"severity":.*"component":.*\}' \
  | head -5 || true)"
if [ -z "$rotator_logs" ]; then
  warn "[log-gke] gh-token-rotator の直近 600s に JSON ログなし (= 50min 周期 rotation のタイミング次第、WARN 継続)"
else
  rotator_sample="$(printf '%s\n' "$rotator_logs" | head -1)"
  printf '%s' "$rotator_sample" | node -e "
let d='';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(d);
    for (const k of ['severity', 'message', 'time', 'component']) {
      if (j[k] === undefined) {
        process.stderr.write('missing key: ' + k + '\n');
        process.exit(1);
      }
    }
    if (j.component !== 'gh-token-rotator') {
      process.stderr.write('component expected gh-token-rotator, got: ' + j.component + '\n');
      process.exit(1);
    }
  } catch (e) {
    process.stderr.write('parse error: ' + e.message + '\n');
    process.exit(1);
  }
});
" || fail "[log-gke] gh-token-rotator JSON ログに必須 4 field が揃わない or component 不一致 (sample: $rotator_sample)"
  ok "[log-gke] gh-token-rotator JSON 行 $(printf '%s\n' "$rotator_logs" | wc -l) 件 + 必須 field (component=gh-token-rotator) OK"
fi

# === Block 2: M3 装備機構 GKE 動作 ====================================================
info '=== Block 2: M3 装備機構 GKE 動作 (verify-m3-phase-2.sh --gke-only) ==='

if [ ! -f "$ROOT/scripts/verify-m3-phase-2.sh" ]; then
  fail "[equip-gke] scripts/verify-m3-phase-2.sh が存在しない"
fi

if bash "$ROOT/scripts/verify-m3-phase-2.sh" --gke-only; then
  ok "[equip-gke] verify-m3-phase-2.sh --gke-only PASS"
else
  fail "[equip-gke] verify-m3-phase-2.sh --gke-only FAILED (= M3 装備機構 が GKE で動かない、上記 stderr を確認)"
fi

# === Block 3: M3 蔵書リスト GKE 動作 ==================================================
info '=== Block 3: M3 蔵書リスト (list_biblio) の GKE 動作 ==='

# STDERR_DIR / LAST_HARNESS_STDERR は verify-m3-helpers.sh の fail() が参照するグローバル。
# Block 3 内で kubectl exec の stderr を受けて fail メッセージに付ける流儀 (= verify-m3.sh と同形)。
STDERR_DIR="$(mktemp -d -t biblio-p4-list-XXXXXX)"
LAST_HARNESS_STDERR=''
trap 'rm -rf "$STDERR_DIR"' EXIT

# --- 全件 ---
LAST_HARNESS_STDERR="$STDERR_DIR/list-all.stderr"
# kubectl exec で複数引数を渡すときは `sh -c "cd /app && ..."` で wrap する流儀。
# `kubectl exec ... -- pnpm exec tsx scripts/biblio-list.ts` だと WORKDIR / pnpm lookup の組み合わせで
# 稀に失敗するため、init-first-agent-gke.sh:69-77 と同じく sh -c でラップ。
list_all_result="$(kubectl exec "$ORCH_POD" -n "$NS" -c orchestrator -- \
  sh -c 'cd /app && pnpm exec tsx scripts/biblio-list.ts' \
  2>"$LAST_HARNESS_STDERR" | extract_result || true)"
[ -n "$list_all_result" ] || fail "[list-gke] 全件: RESULT=<json> が空 (kubectl exec / tsx 失敗の可能性、上記 stderr を確認)"

list_all_ok="$(json_field "$list_all_result" 'ok')"
[ "$list_all_ok" = 'true' ] || fail "[list-gke] 全件: ok!=true (got: $list_all_ok) raw: $list_all_result"

list_all_total="$(json_field "$list_all_result" 'total')"
[ "$list_all_total" -gt 0 ] 2>/dev/null \
  || fail "[list-gke] 全件: total<=0 (= 棚に biblio 0 件、$SHELF_REPO_OWNER/biblio-shelf に shelve 済 biblio が必要) raw: $list_all_result"

list_all_items_len="$(json_array_length "$list_all_result" 'items')"
[ "$list_all_items_len" = "$list_all_total" ] \
  || fail "[list-gke] 全件: items.length($list_all_items_len) != total($list_all_total) raw: $list_all_result"

ok "[list-gke] 全件 OK (total=$list_all_total)"

# --- カテゴリ別 (4 カテゴリ) ---
# 4 カテゴリへの shelve 配置は強制しない (= shelf 状態に強い前提を置かない)。0 件カテゴリは
# warn skip、1 件以上の category で assertion を実行できれば PASS (= verify-m3.sh:174-216 と同形)。
asserted_count=0
for cat in biblio-dev biblio-art biblio-bf biblio-ai; do
  cat_count_in_all="$(json_field "$list_all_result" "counts.$cat")"
  if [ "$cat_count_in_all" = '<missing>' ] || [ "$cat_count_in_all" -le 0 ] 2>/dev/null; then
    warn "[list-gke] $cat: 棚に 0 件、assertion skip"
    continue
  fi

  LAST_HARNESS_STDERR="$STDERR_DIR/list-$cat.stderr"
  cat_result="$(kubectl exec "$ORCH_POD" -n "$NS" -c orchestrator -- \
    sh -c "cd /app && pnpm exec tsx scripts/biblio-list.ts $cat" \
    2>"$LAST_HARNESS_STDERR" | extract_result || true)"
  [ -n "$cat_result" ] || fail "[list-gke] $cat: RESULT=<json> が空 (上記 stderr を確認)"

  cat_ok="$(json_field "$cat_result" 'ok')"
  cat_applied="$(json_field "$cat_result" 'appliedFilter')"
  cat_items_len="$(json_array_length "$cat_result" 'items')"

  [ "$cat_ok" = 'true' ] || fail "[list-gke] $cat: ok!=true raw: $cat_result"
  [ "$cat_applied" = "$cat" ] || fail "[list-gke] $cat: appliedFilter!=$cat (got: $cat_applied) raw: $cat_result"
  [ "$cat_items_len" = "$cat_count_in_all" ] \
    || fail "[list-gke] $cat: items.length($cat_items_len) != counts.$cat($cat_count_in_all) raw: $cat_result"

  # items 全件の category 不変条件 (= filter ロジックのバグ検出、verify-m3.sh:203-210 と同形)
  printf '%s' "$cat_result" | node -e "
let d='';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  const items = JSON.parse(d).items;
  const wrong = items.find(i => i.category !== process.argv[1]);
  if (wrong) { console.error('mismatch:', JSON.stringify(wrong)); process.exit(1); }
});" -- "$cat" \
    || fail "[list-gke] $cat: category 不一致 item を検出 raw: $cat_result"

  info "[list-gke] $cat: $cat_count_in_all 件 OK"
  asserted_count=$((asserted_count + 1))
done

[ "$asserted_count" -gt 0 ] \
  || fail "[list-gke] カテゴリ別 assertion を 1 件も実行できなかった (= 4 カテゴリ全て 0 件)"
ok "[list-gke] カテゴリ別 OK ($asserted_count / 4 カテゴリ)"

rm -rf "$STDERR_DIR"
trap - EXIT

# === 全 PASS =========================================================================
echo 'Phase 4 PASS (GKE deploy-verify) — Block 1 (Phase 2 ログ観測) + Block 2 (装備機構) + Block 3 (蔵書リスト) all OK'
