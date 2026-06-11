#!/usr/bin/env bash
# biblio-claw: Phase 2 GKE wiring 層 assertion
#
# GKE クラスタ biblio-prod に対して kubectl 経由で実行する。
#
# 前提:
#   - cluster credentials 取得済 (gcloud container clusters get-credentials biblio-prod)
#   - k8s/ 配下 manifest apply 済 (kubectl apply -f k8s/)
#   - K8s Secret biblio-gh-app, biblio-slack-tokens 投入済
#   - Sidecar CronJob が少なくとも 1 回実行済 (kubectl create job --from=cronjob/biblio-sidecar
#     biblio-sidecar-init-1 -n biblio-claw でも可)
#
# A 案 (plan §補足) で skip する項目:
#   - orchestrator GSA は Vault 方針で作成しないため、orchestrator Pod 内の
#     gcloud auth list assertion は skip (OneCLI 経由で keyless ADC 不要)
#   - agent Pod は M2 以降のため、NetworkPolicy 効果検証 (curl 169.254.169.254
#     が timeout) は skip
#   - Slack は orchestrator StatefulSet 統合 (別 Pod なし) のため、Slack 接続は
#     orchestrator ログから痕跡判定

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NS="biblio-claw"

# shellcheck source=scripts/onecli-lib.sh
. "${ROOT}/scripts/onecli-lib.sh"

info "==== Phase 2 GKE wiring assertion (namespace=$NS) ===="

# === 1. cluster context ===
ctx="$(kubectl config current-context)"
case "$ctx" in
  gke_*_biblio-prod) ok "[ctx] $ctx" ;;
  *) fail "[ctx] biblio-prod 以外: $ctx (gcloud container clusters get-credentials biblio-prod --region=asia-northeast1)" ;;
esac

# === 2. namespace ===
kubectl get ns "$NS" >/dev/null 2>&1 || fail "[ns] namespace $NS が存在しない"
ok "[ns] $NS exists"

# === 3. orchestrator StatefulSet Ready ===
ready="$(kubectl get statefulset biblio-orchestrator -n "$NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)"
[ "$ready" = "1" ] || fail "[orchestrator] StatefulSet readyReplicas != 1 (actual=$ready)"
ok "[orchestrator] StatefulSet ready=$ready"

# === 4. PVC Bound ===
phase="$(kubectl get pvc data-biblio-orchestrator-0 -n "$NS" -o jsonpath='{.status.phase}' 2>/dev/null || echo NotFound)"
[ "$phase" = "Bound" ] || fail "[pvc] data-biblio-orchestrator-0 phase != Bound (actual=$phase)"
ok "[pvc] data-biblio-orchestrator-0 Bound"

# === 5. OneCLI Deployment + cloud-sql-proxy sidecar ===
onecli_ready="$(kubectl get deployment biblio-onecli -n "$NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)"
[ "$onecli_ready" = "1" ] || fail "[onecli] Deployment readyReplicas != 1 (actual=$onecli_ready)"
ok "[onecli] Deployment ready=$onecli_ready"

onecli_pod="$(kubectl get pod -n "$NS" -l app.kubernetes.io/component=onecli -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")"
[ -n "$onecli_pod" ] || fail "[onecli] Pod が見つからない"

container_count="$(kubectl get pod "$onecli_pod" -n "$NS" -o jsonpath='{.status.containerStatuses[?(@.ready==true)].name}' | wc -w)"
[ "$container_count" -ge 2 ] || fail "[onecli] Pod $onecli_pod 内の Ready container 数が 2 未満 ($container_count) — onecli + cloud-sql-proxy の両方が必要"
ok "[onecli] Pod $onecli_pod 内 $container_count container Ready"

# === 6. OneCLI REST 疎通 (orchestrator Pod 内から in-cluster ClusterIP 経由) ===
orch_pod="biblio-orchestrator-0"
kubectl exec "$orch_pod" -n "$NS" -- curl -fsS "http://biblio-onecli.${NS}.svc.cluster.local:10254/v1/secrets" >/dev/null \
  || fail "[onecli] orchestrator から OneCLI REST に到達できない (in-cluster ClusterIP 経由)"
ok "[onecli] orchestrator → OneCLI REST 疎通"

# === 7. boots カウンタ (PVC + SQLite 永続化検証、PoC-13 写経の決定的指紋) ===
# NOTE: kubectl exec 内では pnpm exec tsx (host 推奨ラッパー) が使えないため node -e で
# 直接呼ぶ (例外的用途)。stderr は捨てない — require('better-sqlite3') 失敗や kubectl
# 接続エラーが silent に空文字を返して set -e で abort される silent failure を防ぐ。
read_boots() {
  kubectl exec "$orch_pod" -n "$NS" -- node -e \
    "const Database = require('better-sqlite3'); const db = new Database('/data/v2.db'); const r = db.prepare('SELECT count FROM boots WHERE id = 1').get(); console.log(r ? r.count : 0);" \
    || fail "[boots] orchestrator Pod 内での DB 読み取りに失敗 — image 内の better-sqlite3 / DB パスを確認"
}
boots_before="$(read_boots)"
info "[boots] 現在値: $boots_before"

info "[boots] Pod 再作成 → 再 attach + boots increment を確認"
kubectl delete pod "$orch_pod" -n "$NS"
kubectl wait --for=condition=Ready pod/"$orch_pod" -n "$NS" --timeout=180s
sleep 5  # incrementBootCounter の log が回るのを待つ
boots_after="$(read_boots)"
[ "$boots_after" -gt "$boots_before" ] || fail "[boots] 再作成後 ($boots_after) が以前 ($boots_before) より増えていない — PVC 再 attach 失敗 or migration016 未適用"
ok "[boots] $boots_before → $boots_after (= PVC + SQLite 永続化が機能)"

# === 8. Sidecar CronJob (直近 Job 完了 + OneCLI 反映) ===
# Sidecar の動作 = 司書 agent が GitHub に到達できる前提条件で、ここを warn にすると
# Phase 2 verify exit 0 = M1 完成判定が「Sidecar 一度も成功せず GH token 未投入」の
# 状態で通ってしまう (CronJob の backoffLimit=3 使い果たし silent 失敗との相乗)。
# 必須条件として fail に格上げする。
recent_job="$(kubectl get jobs -n "$NS" --selector=app.kubernetes.io/component=sidecar --sort-by='.status.startTime' -o jsonpath='{.items[-1:].metadata.name}' 2>/dev/null || echo "")"
if [ -z "$recent_job" ]; then
  fail "[sidecar] 完了済 Job がまだない — CronJob 次回起動を待つか kubectl create job --from=cronjob/biblio-sidecar biblio-sidecar-init-1 -n $NS で手動初回実行"
fi
job_complete="$(kubectl get job "$recent_job" -n "$NS" -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null || echo "")"
if [ "$job_complete" != "True" ]; then
  fail "[sidecar] 直近 Job $recent_job 未 Complete (status=$job_complete) — kubectl logs job/$recent_job -n $NS で debug"
fi
ok "[sidecar] 直近 Job $recent_job Completed"

# OneCLI 側に token 反映確認
token_len="$(kubectl exec "$orch_pod" -n "$NS" -- curl -sS "http://biblio-onecli.${NS}.svc.cluster.local:10254/v1/secrets" | jq -r '.[] | select(.name=="biblio-claw-gh-token") | .value' 2>/dev/null | wc -c)"
if [ "$token_len" -gt 10 ]; then
  ok "[sidecar] OneCLI に biblio-claw-gh-token 反映済 (value 長=$token_len)"
else
  fail "[sidecar] OneCLI に biblio-claw-gh-token が見えない (value 長=$token_len) — Job の logs を確認: kubectl logs job/$recent_job -n $NS"
fi

# === 9. Slack 接続痕跡 (orchestrator 統合パターン、A 案、本確認は任意) ===
# A 案では Slack token (biblio-slack-tokens secret) が optional のため、未投入の運用も
# 成立する (Slack を使わない検証等)。warn で継続するのは intent — Sidecar (§8) と
# 違い Slack は本 verify の必須条件ではない。Slack を使う構成で痕跡が見えない場合は
# `kubectl get secret biblio-slack-tokens -n $NS` で token 投入を確認する。
# (`grep` は過去ログ対象でリアルタイム状態の判定ではない点も留意。)
if kubectl logs "$orch_pod" -n "$NS" --tail=200 2>/dev/null | grep -E "(slack|Slack)" >/dev/null; then
  ok "[slack] orchestrator ログに Slack 接続痕跡あり (詳細は kubectl logs $orch_pod -n $NS)"
else
  warn "[slack] orchestrator ログに Slack 接続痕跡なし — Slack を使う構成なら biblio-slack-tokens の投入を確認 (kubectl get secret biblio-slack-tokens -n $NS)"
fi

ok "==== Phase 2 GKE wiring assertion 全 pass (A 案) ===="
