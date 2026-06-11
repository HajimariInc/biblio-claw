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
# image に curl / jq は焼かない方針 (Dockerfile 軽量化、Step 2.7 検証で判明)。
# Node 22 の global fetch を使う = host プロセスと同じ runtime を再利用、追加依存なし。
orch_pod="biblio-orchestrator-0"
kubectl exec "$orch_pod" -n "$NS" -- node -e \
  "fetch('http://biblio-onecli.${NS}.svc.cluster.local:10254/v1/secrets').then(r => { if (!r.ok) { console.error('HTTP', r.status); process.exit(1); } }).catch(e => { console.error(e.message); process.exit(1); })" \
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

# OneCLI 側に token 反映確認 (curl/jq 非依存、node fetch を使う)。
# 注: OneCLI は GET /v1/secrets で value を mask した形 (length=0) で返す設計のため、
# value 長ではなく "secret の存在 + 想定 hostPattern との一致" で判定する。
token_state="$(kubectl exec "$orch_pod" -n "$NS" -- node -e \
  "fetch('http://biblio-onecli.${NS}.svc.cluster.local:10254/v1/secrets').then(r => r.json()).then(secrets => { const t = secrets.find(s => s.name === 'biblio-claw-gh-token'); process.stdout.write(t ? 'present:' + t.hostPattern : 'absent'); }).catch(e => { process.stdout.write('error:' + e.message); })" 2>/dev/null)"
case "$token_state" in
  present:api.github.com)
    ok "[sidecar] OneCLI に biblio-claw-gh-token 反映済 (hostPattern=api.github.com、value は OneCLI が mask)"
    ;;
  present:*)
    warn "[sidecar] biblio-claw-gh-token は存在するが hostPattern が想定外 ($token_state) — Sidecar の env を確認"
    ;;
  absent)
    fail "[sidecar] OneCLI に biblio-claw-gh-token が見えない — Job logs を確認: kubectl logs job/$recent_job -n $NS"
    ;;
  *)
    fail "[sidecar] OneCLI への secrets list 取得に失敗 ($token_state)"
    ;;
esac

# === 9. Slack adapter 起動 (orchestrator 統合パターン、A 案) ===
# M1 Acceptance に「Slack 接続成立」が明記されているため、本 verify では Slack adapter
# 起動を必須条件として fail 判定する。判定ロジックは "Channel adapter started" + 'channel="slack"'
# の 2 条件共起 — 単純な /slack/ では `Channel credentials missing, skipping channel="slack"`
# (= adapter skip = 偽陽性) と区別できない。
# 起動成功ログ形式: src/channels/channel-registry.ts:89 の `log.info('Channel adapter started', { channel, type })`
# src/log.ts:26 の formatter が `KEY_COLOR + key + RESET + '='` を出すため
# (`\x1b[35mchannel\x1b[39m="slack"`)、ANSI escape を剥がさないと regex の
# `started.*channel=` 連続にマッチしない silent failure を起こす。
#
# 判定対象は直近 120s のログのみに絞る = "起動 → credentials missing で再起動"
# のような複合履歴が tail に残っているとき、古い起動成功ログに先にマッチして
# 最新の credentials missing 状態を見落とす偽陽性を防ぐ (--since=120s)。
# kubectl logs が空 (Pod 異常 / ログ未生成) と取得失敗を fail メッセージで
# 区別できるよう、Pod phase も読む。
orch_logs="$(kubectl logs "$orch_pod" -n "$NS" --since=120s 2>/dev/null | sed -r 's/\x1b\[[0-9;]*m//g' || true)"
if echo "$orch_logs" | grep -E 'Channel adapter started.*channel="slack"' >/dev/null; then
  ok "[slack] Slack adapter 起動済 (Channel adapter started + channel=\"slack\" 両一致)"
elif echo "$orch_logs" | grep -E 'Channel credentials missing.*channel="slack"' >/dev/null; then
  fail "[slack] Slack credentials が adapter から見えていない — env.ts の process.env fallback 動作 + biblio-slack-tokens Secret 投入 (kubectl get secret biblio-slack-tokens -n $NS) を確認"
else
  pod_phase="$(kubectl get pod "$orch_pod" -n "$NS" -o jsonpath='{.status.phase}' 2>/dev/null || echo 'unknown')"
  fail "[slack] Slack adapter 起動痕跡も credentials missing 痕跡も見えない (Pod phase=$pod_phase) — Pod が Running 以外なら kubectl describe pod/$orch_pod -n $NS で原因確認、Running ならログ未生成の可能性 (--since=120s 範囲外) のため kubectl logs $orch_pod -n $NS で生ログ確認"
fi

ok "==== Phase 2 GKE wiring assertion 全 pass (A 案) ===="
