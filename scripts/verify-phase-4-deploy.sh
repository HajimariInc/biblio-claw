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
#   - orchestrator StatefulSet readyReplicas=1
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

info "==== Phase 4 GKE deploy-verify (namespace=$NS) ===="

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

# === 全 PASS =========================================================================
echo 'Phase 4 PASS (GKE deploy-verify) — Block 1 (Phase 2 ログ観測) all OK'
