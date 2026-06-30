#!/usr/bin/env bash
# biblio-claw: M2 PRD A Phase 3 完了判定 verify (GKE 実機)
#
# Phase 3 = OneCLI sidecar 統合 + Sidecar Failed の構造的解消。orchestrator Pod を
# 6 container 構成 (initContainers 3 + containers 3) に再構成し、CA Secret 自動 upsert と
# GH/Vertex token rotator loop を sidecar 化したことを assert する。
#
# 前提:
#   - cluster credentials 取得済 (gcloud container clusters get-credentials biblio-prod)
#   - Phase 3 manifest apply 済 (kubectl apply -f k8s/)
#   - 旧 Deployment / CronJob は **既に削除済** (kubectl delete deployment biblio-onecli
#     -n biblio-claw / kubectl delete cronjob biblio-sidecar -n biblio-claw)
#   - K8s Secret biblio-gh-app, biblio-slack-tokens 投入済
#   - orchestrator KSA が新 GSA `biblio-orchestrator` に annotate 済 + WI binding 完了
#
# §1 sidecar Pod 構成 (6 container, status=running/completed)
# §2 CA Secret biblio-onecli-ca が orchestrator 起動後 60s 以内に自動投入されている
# §3 gh-token-rotator container Running + OneCLI に biblio-claw-gh-token 反映
# §4 vertex-token-rotator container Running + OneCLI に biblio-claw-vertex 反映
# §5 旧 Deployment / CronJob / Secret 投入手順が削除済
# §6 NetworkPolicy が新 podSelector (component: orchestrator) に向いている
# §7 Slack adapter 起動 (回帰: A 案踏襲)
# §8 回帰: verify-phase-m2-2.sh PASS (= Phase 2.5 agent Pod 起動 + Slack 往復が引き続き動く)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NS="biblio-claw"
ORCH_POD="biblio-orchestrator-0"
SECRET_NAME="biblio-onecli-ca"
# §1 で orchestrator の readyReplicas=1 を確認した後に §2 で待つため、この時点で
# onecli init container (startupProbe /v1/health、最大 120s) は通過済 = ca.pem は
# emptyDir に存在し、ca-secret-sync の初回 sweep は orchestrator 起動直後に走る。
# よって 90s は「初回 sweep + K8s upsert 反映」のマージンで足り、onecli startupProbe
# の最大待ち時間を内包する必要はない。長引く環境では CA_WAIT_SEC=180 等で上書き可。
CA_WAIT_SEC="${CA_WAIT_SEC:-90}"

# shellcheck source=scripts/onecli-lib.sh
. "${ROOT}/scripts/onecli-lib.sh"

info "==== M2 PRD A Phase 3 完了判定 (namespace=$NS) ===="

# === 0. cluster context ===
ctx="$(kubectl config current-context)"
case "$ctx" in
  gke_*_biblio-prod) ok "[ctx] $ctx" ;;
  *) fail "[ctx] biblio-prod 以外: $ctx (gcloud container clusters get-credentials biblio-prod --region=asia-northeast1)" ;;
esac

# === 1. orchestrator Pod が 6 container 構成 ===
# initContainers: fetch-pem (Completed) + cloud-sql-proxy (Running, Native sidecar)
#                 + onecli (Running, Native sidecar)
# containers:     orchestrator + gh-token-rotator + vertex-token-rotator (全 Running)
ready="$(kubectl get statefulset biblio-orchestrator -n "$NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)"
[ "$ready" = "1" ] || fail "[orchestrator] StatefulSet readyReplicas != 1 (actual=$ready)"
ok "[orchestrator] StatefulSet ready=$ready"

# initContainers (run-to-completion or Native sidecar) の状態取得
EXPECTED_INIT="fetch-pem cloud-sql-proxy onecli"
EXPECTED_CONTAINERS="orchestrator gh-token-rotator vertex-token-rotator"

for c in $EXPECTED_INIT; do
  state="$(kubectl get pod "$ORCH_POD" -n "$NS" -o jsonpath="{.status.initContainerStatuses[?(@.name=='$c')].state}" 2>/dev/null || echo '')"
  # fetch-pem は本物 init = Completed (terminated state) で OK、残り 2 つは Running
  case "$c" in
    fetch-pem)
      case "$state" in
        *terminated*) ok "[init] $c terminated (run-to-completion)" ;;
        *running*) ok "[init] $c still running (許容)" ;;
        *) fail "[init] $c の state が想定外: $state" ;;
      esac
      ;;
    *)
      case "$state" in
        *running*) ok "[init] $c running (Native sidecar)" ;;
        *) fail "[init] Native sidecar $c 未起動 (state=$state) — kubectl describe pod $ORCH_POD -n $NS で確認" ;;
      esac
      ;;
  esac
done

for c in $EXPECTED_CONTAINERS; do
  state="$(kubectl get pod "$ORCH_POD" -n "$NS" -o jsonpath="{.status.containerStatuses[?(@.name=='$c')].state}" 2>/dev/null || echo '')"
  case "$state" in
    *running*) ok "[container] $c running" ;;
    *) fail "[container] $c 未起動 (state=$state) — kubectl logs $ORCH_POD -c $c -n $NS で debug" ;;
  esac
done

# === 2. CA Secret biblio-onecli-ca 自動投入確認 ===
# orchestrator 起動後、ca-secret-sync が emptyDir 経由で OneCLI 生成 CA bundle を
# 読んで Secret に upsert する。初回 sweep は起動 + 60s 周期で動くため最大 90 秒待つ。
# 既存の Secret は managed-by ラベルで自動投入版か確認 (旧 Phase 2.5 手動投入版は
# ラベル無しのため、ラベル付与で「ca-secret-sync が触った」ことを確認)。
info "[ca-secret] biblio-onecli-ca の自動投入を確認 (最大 ${CA_WAIT_SEC}s 待機)"
deadline=$(( $(date +%s) + CA_WAIT_SEC ))
managed_label=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  managed_label="$(kubectl get secret "$SECRET_NAME" -n "$NS" \
    -o jsonpath="{.metadata.labels.app\.kubernetes\.io/managed-by}" 2>/dev/null || echo '')"
  if [ "$managed_label" = "ca-secret-sync" ]; then break; fi
  sleep 5
done

if [ "$managed_label" != "ca-secret-sync" ]; then
  fail "[ca-secret] Secret $SECRET_NAME に managed-by=ca-secret-sync ラベルが付いていない (取得値=$managed_label) — kubectl logs $ORCH_POD -c orchestrator -n $NS で ca-secret-sync の進行確認"
fi
ok "[ca-secret] $SECRET_NAME が ca-secret-sync によって自動投入済"

# Secret data に 2 key (onecli-proxy-ca.pem + onecli-combined-ca.pem) が揃っているか
for key in onecli-proxy-ca.pem onecli-combined-ca.pem; do
  has="$(kubectl get secret "$SECRET_NAME" -n "$NS" -o jsonpath="{.data.${key//./\\.}}" 2>/dev/null || echo '')"
  [ -n "$has" ] || fail "[ca-secret] data key '$key' が空 — k8s.ts:357-371 期待形式に合わない"
done
ok "[ca-secret] data key 2 種 (onecli-proxy-ca.pem + onecli-combined-ca.pem) 揃い"

# === 3. gh-token-rotator + OneCLI に GH token 反映 ===
# (container running 判定は §1 で済んでいる)
# orchestrator container の localhost:10254 = 同 Pod 内 onecli sidecar に直結。
token_state="$(kubectl exec "$ORCH_POD" -n "$NS" -c orchestrator -- node -e \
  "fetch('http://localhost:10254/v1/secrets').then(r => r.json()).then(secrets => { const t = secrets.find(s => s.name === 'biblio-claw-gh-token'); process.stdout.write(t ? 'present:' + t.hostPattern : 'absent'); }).catch(e => { process.stdout.write('error:' + e.message); })" 2>/dev/null || echo 'exec-failed')"
case "$token_state" in
  present:api.github.com)
    ok "[gh-rotator] OneCLI に biblio-claw-gh-token 反映済 (hostPattern=api.github.com)"
    ;;
  absent)
    fail "[gh-rotator] biblio-claw-gh-token が OneCLI に見えない — kubectl logs $ORCH_POD -c gh-token-rotator -n $NS で確認 (rotator 1 周期目の完了待ち)"
    ;;
  present:*)
    warn "[gh-rotator] biblio-claw-gh-token は存在するが hostPattern が想定外 ($token_state)"
    ;;
  *)
    fail "[gh-rotator] OneCLI 接続不能 ($token_state)"
    ;;
esac

# === 4. vertex-token-rotator + OneCLI に Vertex Bearer 反映 ===
vertex_state="$(kubectl exec "$ORCH_POD" -n "$NS" -c orchestrator -- node -e \
  "fetch('http://localhost:10254/v1/secrets').then(r => r.json()).then(secrets => { const t = secrets.find(s => s.name === 'biblio-claw-vertex'); process.stdout.write(t ? 'present:' + t.hostPattern : 'absent'); }).catch(e => { process.stdout.write('error:' + e.message); })" 2>/dev/null || echo 'exec-failed')"
case "$vertex_state" in
  present:aiplatform.googleapis.com|present:*-aiplatform.googleapis.com)
    ok "[vertex-rotator] OneCLI に biblio-claw-vertex 反映済 ($vertex_state)"
    ;;
  absent)
    fail "[vertex-rotator] biblio-claw-vertex が OneCLI に見えない — kubectl logs $ORCH_POD -c vertex-token-rotator -n $NS で確認 (WI 経由 gcloud auth が落ちている可能性)"
    ;;
  present:*)
    warn "[vertex-rotator] biblio-claw-vertex は存在するが hostPattern が想定外 ($vertex_state)"
    ;;
  *)
    fail "[vertex-rotator] OneCLI 接続不能 ($vertex_state)"
    ;;
esac

# === 5. 旧 Deployment / CronJob / 手動投入手順が削除済 ===
if kubectl get deployment biblio-onecli -n "$NS" >/dev/null 2>&1; then
  fail "[cleanup] 旧 Deployment biblio-onecli が残置 (Phase 3 で廃止のはず)"
fi
ok "[cleanup] Deployment biblio-onecli 削除済"

if kubectl get cronjob biblio-sidecar -n "$NS" >/dev/null 2>&1; then
  fail "[cleanup] 旧 CronJob biblio-sidecar が残置 (Phase 3 で廃止のはず)"
fi
ok "[cleanup] CronJob biblio-sidecar 削除済"

if [ -e "${ROOT}/k8s/onecli-ca-secret.md" ]; then
  fail "[cleanup] 手動投入手順 k8s/onecli-ca-secret.md が残置 — repo から削除する"
fi
ok "[cleanup] k8s/onecli-ca-secret.md 削除済"

# === 6. NetworkPolicy 更新確認 ===
# agent egress NetworkPolicy の podSelector が orchestrator に向いていることを確認
np_target="$(kubectl get networkpolicy biblio-agent-egress -n "$NS" \
  -o jsonpath='{.spec.egress[?(@.ports[0].port==10254)].to[?(@.podSelector)].podSelector.matchLabels.app\.kubernetes\.io/component}' 2>/dev/null || echo '')"
case "$np_target" in
  orchestrator) ok "[netpol] agent egress podSelector → component: orchestrator" ;;
  '') fail "[netpol] biblio-agent-egress の podSelector が空 — yaml apply 漏れ" ;;
  *) fail "[netpol] biblio-agent-egress の podSelector が orchestrator 以外: $np_target" ;;
esac

# === 7. Slack adapter 起動 (回帰、A 案踏襲) ===
# verify-phase-2-wiring.sh §9 と同じロジック。orchestrator logger の JSON 化
# (commit 9c113f0) に追従して本 script の regex を更新済 (PR #69 / issue #55 で
# verify-phase-2-wiring.sh 側を先行修正、本箇所はその mirror = issue #68)。
# GKE 経路の orchestrator は LOG_FORMAT=json (k8s/10-orchestrator-statefulset.yaml:200)
# で動き emitJson が JSON 1 行を吐く (キーは "channel":"slack")。ANSI escape は JSON
# 経路では出力されないため sed 剥離は不要。
#
# 窓分離 (issue #83): "Channel adapter started" は Pod 起動時 1 回限りのため
# Pod 起動以降の全期間 (--since-time=$pod_start_time) で grep する。"Channel
# credentials missing" は最新状態の鮮度確保のため --since=120s を維持する
# (= "missing → credentials 投入 → 手動 Pod restart" の複合履歴で旧 missing に
# 誤マッチする偽陽性回避、設計意図コメント @verify-phase-2-wiring.sh:170-172
# 参照)。判定順は missing 先 → started 後 (missing が最新で見えていれば即 fail)。
pod_start_time="$(kubectl get pod "$ORCH_POD" -n "$NS" -o jsonpath='{.status.startTime}' 2>/dev/null || echo '')"
if [ -n "$pod_start_time" ]; then
  startup_logs="$(kubectl logs "$ORCH_POD" -c orchestrator -n "$NS" --since-time="$pod_start_time" 2>/dev/null || true)"
else
  # startTime 取得失敗 (= Pod 異常 / metadata 未生成) は全期間 fallback
  startup_logs="$(kubectl logs "$ORCH_POD" -c orchestrator -n "$NS" 2>/dev/null || true)"
fi
recent_logs="$(kubectl logs "$ORCH_POD" -c orchestrator -n "$NS" --since=120s 2>/dev/null || true)"

if echo "$recent_logs" | grep -E '"message":"Channel credentials missing[^"]*"[^}]*"channel":"slack"' >/dev/null; then
  fail "[slack] Slack credentials が見えていない (直近 120s 内に missing 検出) — biblio-slack-tokens Secret を確認"
elif echo "$startup_logs" | grep -E '"message":"Channel adapter started"[^}]*"channel":"slack"' >/dev/null; then
  ok "[slack] Slack adapter 起動済 (Channel adapter started + \"channel\":\"slack\" 両一致, Pod 起動時刻起点で確認)"
else
  pod_phase="$(kubectl get pod "$ORCH_POD" -n "$NS" -o jsonpath='{.status.phase}' 2>/dev/null || echo 'unknown')"
  fail "[slack] Slack adapter 痕跡なし (Pod phase=$pod_phase, startTime=$pod_start_time) — kubectl logs $ORCH_POD -c orchestrator -n $NS で確認"
fi

# === 8. 回帰: verify-phase-m2-2.sh で Phase 2.5 までの assert を再確認 ===
# agent Pod 1 体 spawn + Slack 1 往復 + Pod 再作成跨ぎ永続化 (boots increment) は
# verify-phase-m2-2.sh の責務。Phase 3 で破壊していないことを確認するため呼び出す。
info "[regression] verify-phase-m2-2.sh で Phase 2.5 assert を回帰確認"
if bash "${ROOT}/scripts/verify-phase-m2-2.sh"; then
  ok "[regression] verify-phase-m2-2.sh PASS"
else
  fail "[regression] verify-phase-m2-2.sh FAIL — Phase 3 改造が Phase 2.5 を破壊した可能性"
fi

ok "==== M2 PRD A Phase 3 完了判定 全 pass ===="
