#!/usr/bin/env bash
# biblio-claw: Phase 4 (deploy-verify) GKE 統合 verify
#
# init-project-gcp PRD Phase 4 の役割: GKE Autopilot biblio-prod 上で Phase 2 で
# 追加した構造化ログが kubectl logs 経由で観測可能であることを assert する。
#
# Phase 4.5 (image-sync) で本番反映を成立させた後、本 script を `/init-project-gcp
# verify` の Section 4 として組み込み、image-sync の効果を独立スクリプトで再現可能
# に verify する役割を担う (= image-sync 自体の Block 6 も Pod 内 env / M3 ファイル
# 存在を assert するが、本 script は「image-sync 完了後に何度でも回せる log 観測」
# の点で価値がある)。
#
# 構成: Block 1 のみ (= Phase 2 構造化ログの GKE 実機観測)
#
# Note: 当初 plan は 3 ブロック構成 (Block 1 ログ観測 + Block 2 M3 装備機構 GKE +
# Block 3 M3 蔵書リスト GKE) を想定していたが、2026-06-23 実走で M3 PRD の GKE 経路
# 完成度の低さに起因する bug 群 (marker.json 廃止漏れ / mkdir 子 dir 欠落 /
# spawn-verify ensureRuntime 未呼出 / SHELF_* env manifest 未投入 / OneCLI agent
# selective mode で github 認証漏れ) が顕在化したため、Z 案 + δ 案で Block 2/3 を
# Phase 4 plan の Out of Scope に移し、M3 PRD への申し送りとした (auto memory
# `m3-gke-completion-pending` 参照)。Phase 4 plan は Block 1 (= image-sync の
# Phase 2 ログ反映を assert) に閉じる。
#
# 引数: なし (= GKE 経路のみ、cluster context gate で biblio-prod 専用)
#
# 前提:
#   - kubectl context = gke_*_biblio-prod
#   - orchestrator StatefulSet readyReplicas=1 + Pod phase=Running
#   - gh-token-rotator container が Pod spec に含まれる (= manifest 適用済)
#   - LOG_FORMAT=json + LOG_COMPONENT=host-orchestrator が StatefulSet env で投入済
#     (= Phase 2 で k8s/10-orchestrator-statefulset.yaml に追加、Phase 4.5 で GKE に反映)
#
# 各 assert 失敗で exit 1。全通過で `Phase 4 PASS (GKE deploy-verify)` を出して exit 0。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# info/warn/fail は verify-m3-helpers.sh に集約。ok() のみ局所定義
# (= verify-phase-2-log.sh と同流儀、両 source による info/warn/fail 二重定義を回避)。
# shellcheck source=scripts/verify-m3-helpers.sh
source "$(dirname "${BASH_SOURCE[0]}")/verify-m3-helpers.sh"
ok() { printf '[OK]   %s\n' "$*" >&2; }

NS='biblio-claw'
ORCH_POD='biblio-orchestrator-0'

# 直近 harness の stderr 保持用 (verify-m3-helpers.sh の fail() が参照、
# verify-m3-phase-1/2.sh と同形)。未初期化だと fail 時のデバッグ stderr が出ない。
STDERR_DIR="$(mktemp -d -t biblio-p4-stderr-XXXXXX)"
LAST_HARNESS_STDERR=''
trap 'rm -rf "$STDERR_DIR"' EXIT

# JSON ログ必須 field 検証 (severity/message/time/component) + component 値一致を
# 1 関数に集約 (= orchestrator と gh-token-rotator + 将来の vertex-token-rotator で
# component 値のみ異なる同形検査)。process.argv[1] で component 名を受け取る
# (= verify-m3-helpers.sh:json_field と同形)。
assert_log_json_fields() {
  local line="$1"
  local expected_component="$2"
  printf '%s' "$line" | node -e "
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
    const expected = process.argv[1];
    if (j.component !== expected) {
      process.stderr.write('component expected ' + expected + ', got: ' + j.component + '\n');
      process.exit(1);
    }
  } catch (e) {
    process.stderr.write('parse error: ' + e.message + '\n');
    process.exit(1);
  }
});
" -- "$expected_component"
}

info "==== Phase 4 GKE deploy-verify (namespace=$NS) ===="

# --- pre-flight: コマンド存在確認 ---
# kubectl / node が PATH にないと後段で「command not found」になり原因特定コストが
# 高いため、最初に明示 fail する (= verify-m3-phase-1.sh と同パターン)。
command -v kubectl >/dev/null 2>&1 || fail "[pre-flight] kubectl が見つかりません (PATH を確認)"
command -v node    >/dev/null 2>&1 || fail "[pre-flight] node が見つかりません (PATH を確認)"

# --- pre-flight: kubectl context gate ---
# 別 cluster で誤実行しないための gate (= verify-phase-2-wiring.sh:32-36 と同パターン)。
ctx="$(kubectl config current-context 2>/dev/null || echo '<none>')"
case "$ctx" in
  gke_*_biblio-prod) ok "[ctx] $ctx" ;;
  *) fail "[ctx] kubectl context が biblio-prod ではない (= $ctx)。実行: gcloud container clusters get-credentials biblio-prod --region=asia-northeast1 --project=hajimari-ai-hackathon-2026" ;;
esac

# --- pre-flight: orchestrator StatefulSet ready ---
ready="$(kubectl get statefulset biblio-orchestrator -n "$NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)"
[ "$ready" = "1" ] || fail "[orchestrator] StatefulSet readyReplicas != 1 (actual=$ready)。kubectl describe statefulset biblio-orchestrator -n $NS で原因確認"
ok "[orchestrator] StatefulSet ready=$ready"

# --- pre-flight: Pod phase Running ---
# StatefulSet readyReplicas は readiness probe pass を表すが、再起動直後の
# Terminating→Pending gap で false 判定するリスクがあるため Pod phase で追加 gate
# (= verify-m3-phase-1/2.sh と同パターン)。
phase="$(kubectl get pod "$ORCH_POD" -n "$NS" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
[ "$phase" = "Running" ] || fail "[orchestrator] Pod $ORCH_POD が Running でない (現在: ${phase:-不明})。kubectl describe pod $ORCH_POD -n $NS で確認"
ok "[orchestrator] Pod $ORCH_POD phase=$phase"

# --- pre-flight: gh-token-rotator container 存在確認 ---
# rotator container 不在を「50min 周期で未出力」の WARN と混同しないための gate。
# manifest 未適用 / container 名変更を fail で握る (= silent failure 防止)。
containers="$(kubectl get pod "$ORCH_POD" -n "$NS" -o jsonpath='{.spec.containers[*].name}' 2>/dev/null || true)"
case " $containers " in
  *' gh-token-rotator '*) ok "[orchestrator] gh-token-rotator container 存在" ;;
  *) fail "[orchestrator] gh-token-rotator container が Pod spec にない (containers=$containers)。k8s/10-orchestrator-statefulset.yaml の適用状況を確認" ;;
esac

# === Block 1: Phase 2 ログ GKE 実機観測 ============================================
info '=== Block 1: Phase 2 構造化ログの GKE 実機観測 ==='

# orchestrator container の直近 300s の JSON ログを取得。
# kubectl logs 自体の失敗 (接続 / RBAC / Pod 状態) と「JSON 0 行」を分岐させるため
# 2 段で受ける: (1) kubectl logs を fail/success で切る、(2) sed+grep+head は 0 件
# 容認で受ける (= 後段の `[ -z ]` で fail)。ANSI escape 剥がしは必須 (= 剥がさないと
# grep regex が外れる、verify-phase-2-wiring.sh:157 と同パターン)。container 名は
# `-c orchestrator` で明示 (= 同 Pod 内 onecli / cloud-sql-proxy / gh-token-rotator /
# vertex-token-rotator のデフォルト推定を避ける)。
LAST_HARNESS_STDERR="$STDERR_DIR/kubectl-logs-orchestrator.stderr"
raw_orch_logs="$(kubectl logs "$ORCH_POD" -n "$NS" -c orchestrator --since=300s 2>"$LAST_HARNESS_STDERR")" \
  || fail "[log-gke] kubectl logs orchestrator が失敗 (kubectl 接続 / RBAC / Pod 状態を確認)"
recent_logs="$(printf '%s' "$raw_orch_logs" \
  | sed -r 's/\x1b\[[0-9;]*m//g' \
  | grep -E '^\{.*"severity":.*"component":.*\}' \
  | head -20 || true)"
if [ -z "$recent_logs" ]; then
  fail "[log-gke] orchestrator container の直近 300s に JSON ログ 1 行も観測できない (= LOG_FORMAT=json env 未反映 / Pod がログを吐いていない可能性)。kubectl logs $ORCH_POD -c orchestrator -n $NS で生ログ確認"
fi
log_count="$(printf '%s\n' "$recent_logs" | wc -l | tr -d ' ')"
info "[log-gke] orchestrator JSON 行 ${log_count} 件観測"

# 1 行 sample で必須 4 field (severity/message/time/component) + component 値を assert。
# parse 失敗時の sample 出力で原因可視化 (= silent-failure-hunter 観点)。
sample_line="$(printf '%s\n' "$recent_logs" | head -1)"
assert_log_json_fields "$sample_line" 'host-orchestrator' \
  || fail "[log-gke] orchestrator JSON ログに必須 4 field が揃わない (sample: $sample_line)"
ok "[log-gke] orchestrator JSON ログ必須 field (severity/message/time/component=host-orchestrator) OK"

# gh-token-rotator container の直近 600s も同様に確認。
# 50min 周期 rotation のため直近 600s に出ないタイミングがある → FAIL ではなく WARN。
# ただし container 自体は pre-flight で存在を担保済 (= 不在は fail 済)。
LAST_HARNESS_STDERR="$STDERR_DIR/kubectl-logs-rotator.stderr"
raw_rotator_logs="$(kubectl logs "$ORCH_POD" -n "$NS" -c gh-token-rotator --since=600s 2>"$LAST_HARNESS_STDERR")" \
  || fail "[log-gke] kubectl logs gh-token-rotator が失敗 (kubectl 接続 / RBAC / container 状態を確認)"
rotator_logs="$(printf '%s' "$raw_rotator_logs" \
  | sed -r 's/\x1b\[[0-9;]*m//g' \
  | grep -E '^\{.*"severity":.*"component":.*\}' \
  | head -5 || true)"
if [ -z "$rotator_logs" ]; then
  warn "[log-gke] gh-token-rotator の直近 600s に JSON ログなし (= 50min 周期 rotation のタイミング次第、WARN 継続)"
else
  rotator_sample="$(printf '%s\n' "$rotator_logs" | head -1)"
  assert_log_json_fields "$rotator_sample" 'gh-token-rotator' \
    || fail "[log-gke] gh-token-rotator JSON ログに必須 4 field が揃わない or component 不一致 (sample: $rotator_sample)"
  rotator_count="$(printf '%s\n' "$rotator_logs" | wc -l | tr -d ' ')"
  ok "[log-gke] gh-token-rotator JSON 行 ${rotator_count} 件 + 必須 field (component=gh-token-rotator) OK"
fi

# === 全 PASS =========================================================================
echo 'Phase 4 PASS (GKE deploy-verify) — Block 1 (Phase 2 ログ観測) all OK'
