#!/usr/bin/env bash
# biblio-claw: M2 PRD A Phase 1 — M1 残課題回収 (agent K8s Job spawn / RBAC /
# NetworkPolicy 整合 / SKIP_CONTAINER_RUNTIME_CHECK 撤去) の wiring assertion。
#
# 既存 scripts/verify-phase-2-wiring.sh の §N 形式を踏襲し、本 Phase で
# 追加された配線のみを検証する。Phase 2 verify は本 script 完走後に **別途**
# 実行して回帰チェックする (本 script からは呼ばない — 失敗時の出口を分離して
# debug 性を確保するため)。
#
# 前提:
#   - cluster credentials 取得済 (gcloud container clusters get-credentials biblio-prod)
#   - k8s/ 配下 manifest 全 apply 済 (kubectl apply -f k8s/)
#     特に k8s/02-orchestrator-rbac.yaml (本 Phase 新規) と
#     k8s/10-orchestrator-statefulset.yaml (env 切替済) が反映されていること
#   - orchestrator が新 image (CONTAINER_PROVIDER=k8s が効く build) で rollout 済
#
# 確認内容:
#   §1. cluster context が biblio-prod
#   §2. namespace 存在
#   §3. Role biblio-orchestrator-agent-spawner が存在し最小権限を持つ
#   §4. RoleBinding が biblio-orchestrator-ksa に bind されている
#   §5. orchestrator log に `container runtime = k8s` (Provider 切替の動作確認)
#   §6. SKIP_CONTAINER_RUNTIME_CHECK が StatefulSet env から消えている (codebase grep)
#   §7. NetworkPolicy 効果検証 — agent label を付けた test pod から
#       GCE metadata (169.254.169.254) への egress が **遮断** されることを確認
#   §8. 同 test pod から in-cluster OneCLI ClusterIP への TCP 10254 が
#       **到達可能** であることを確認 (DNS 解決 + egress 許可)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NS="biblio-claw"

# shellcheck source=scripts/onecli-lib.sh
. "${ROOT}/scripts/onecli-lib.sh"

info "==== M2 Phase 1 (M1 residual cleanup) assertion (namespace=$NS) ===="

# === §1. cluster context ===
ctx="$(kubectl config current-context)"
case "$ctx" in
  gke_*_biblio-prod) ok "[ctx] $ctx" ;;
  *) fail "[ctx] biblio-prod 以外: $ctx (gcloud container clusters get-credentials biblio-prod --region=asia-northeast1)" ;;
esac

# === §2. namespace ===
kubectl get ns "$NS" >/dev/null 2>&1 || fail "[ns] namespace $NS が存在しない"
ok "[ns] $NS exists"

# === §3. Role 存在 + verbs assertion ===
ROLE="biblio-orchestrator-agent-spawner"
kubectl get role "$ROLE" -n "$NS" >/dev/null 2>&1 \
  || fail "[rbac] Role $ROLE が存在しない — k8s/02-orchestrator-rbac.yaml が apply されているか確認 (kubectl apply -f k8s/02-orchestrator-rbac.yaml)"

# Job operations が allowed されているか確認 (batch/jobs に create + watch + delete)。
# kubectl jsonpath は配列をそのまま指すと `["a","b"]` の JSON literal を返すことが
# あるため、`range ...[*]` で各要素を空白区切りに展開してから含有チェックする。
required_verbs=("create" "get" "list" "watch" "delete")
jobs_verbs="$(kubectl get role "$ROLE" -n "$NS" \
  -o jsonpath='{range .rules[?(@.resources[0]=="jobs")].verbs[*]}{@} {end}')"
for v in "${required_verbs[@]}"; do
  case " $jobs_verbs " in
    *" $v "*) ;;
    *) fail "[rbac] Role $ROLE の batch/jobs verbs に $v が含まれない (actual=$jobs_verbs)" ;;
  esac
done
ok "[rbac] Role $ROLE: batch/jobs に [${required_verbs[*]}] を許可"

# === §4. RoleBinding が orchestrator KSA を subject に取っている ===
BINDING="biblio-orchestrator-agent-spawner"
kubectl get rolebinding "$BINDING" -n "$NS" >/dev/null 2>&1 \
  || fail "[rbac] RoleBinding $BINDING が存在しない"
subject_name="$(kubectl get rolebinding "$BINDING" -n "$NS" -o jsonpath='{.subjects[?(@.kind=="ServiceAccount")].name}')"
[ "$subject_name" = "biblio-orchestrator-ksa" ] \
  || fail "[rbac] RoleBinding $BINDING の subject KSA が biblio-orchestrator-ksa でない (actual=$subject_name)"
ok "[rbac] RoleBinding $BINDING → ServiceAccount biblio-orchestrator-ksa"

# === §5. orchestrator log に Provider 切替の痕跡 ===
ORCH_POD="biblio-orchestrator-0"
ready="$(kubectl get statefulset biblio-orchestrator -n "$NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)"
[ "$ready" = "1" ] || fail "[orchestrator] StatefulSet readyReplicas != 1 (actual=$ready) — rollout の完了を待つ"

# ANSI escape を剥がして純文字列で grep する (kleur が tty 判定で色付け、
# kubectl exec 経由でも fd が pipe と判定されなければ ANSI が混入する。
# verify-phase-2-wiring.sh §9 と同じ防御で、grep -F + sed で剥離)。
log_tail="$(kubectl logs "$ORCH_POD" -n "$NS" --tail=400 2>/dev/null | sed -r 's/\x1b\[[0-9;]*m//g' || true)"
echo "$log_tail" | grep -qF "container runtime = k8s" \
  || fail "[runtime] orchestrator log に 'container runtime = k8s' が出ていない — Provider 切替が効いていない or env CONTAINER_PROVIDER=k8s が反映されていない"
ok "[runtime] orchestrator log に Provider 切替痕跡を確認"

# === §6. SKIP_CONTAINER_RUNTIME_CHECK が消えている (codebase + StatefulSet env) ===
# 本 verify script 自身は assertion で文字列を含むため --exclude で除外する
# (除外しないと self-reference 9 件で false fail になる)。
# `grep ... | wc -l` は 0 match で grep exit 1 → pipefail で script abort になる。
# `wc -l` 末尾の `|| true` で pipeline を成功扱いに固定する。
sticks_in_code="$(grep -rE --exclude='verify-phase-m2-1.sh' 'SKIP_CONTAINER_RUNTIME_CHECK' \
  "${ROOT}/src" "${ROOT}/scripts" "${ROOT}/k8s" 2>/dev/null | wc -l || true)"
[ "$sticks_in_code" = "0" ] \
  || fail "[cleanup] SKIP_CONTAINER_RUNTIME_CHECK が src/scripts/k8s 配下に ${sticks_in_code} 件残っている — git grep で確認"
ok "[cleanup] SKIP_CONTAINER_RUNTIME_CHECK は src/scripts/k8s から完全に消えた"

sticks_in_ss="$(kubectl get statefulset biblio-orchestrator -n "$NS" -o json | grep -c 'SKIP_CONTAINER_RUNTIME_CHECK' || true)"
[ "$sticks_in_ss" = "0" ] \
  || fail "[cleanup] StatefulSet env に SKIP_CONTAINER_RUNTIME_CHECK が残っている (apply 反映を確認)"
ok "[cleanup] StatefulSet env から SKIP_CONTAINER_RUNTIME_CHECK が消えた"

# === §7-8. NetworkPolicy 効果検証 ===
# agent と同じ label を付けた一時 Pod を起こし、metadata.google.internal (169.254.169.254)
# への egress が遮断されること + OneCLI ClusterIP への到達は許可されることを assert する。
#
# pod が NetworkPolicy match するかは label + namespace で決まる。agent と同じ
# `app.kubernetes.io/name=biblio-claw` + `app.kubernetes.io/component=agent` を
# 付ければ、本物の agent Pod がまだ立っていない状態でも NetworkPolicy 効果を
# 確認できる。これは K8sJobProvider が同じ labels を Pod template に乗せる
# (src/adapters/container/k8s.ts:commonLabels) ことの遠隔保証にもなる。
TEST_POD="biblio-netpol-probe-$RANDOM"
info "[netpol] 一時 test pod $TEST_POD を起動 (agent と同 labels で NetworkPolicy match)"
kubectl run "$TEST_POD" -n "$NS" \
  --image=curlimages/curl:8.10.1 \
  --restart=Never \
  --labels='app.kubernetes.io/name=biblio-claw,app.kubernetes.io/component=agent' \
  --command -- sleep 120 >/dev/null 2>&1 \
  || fail "[netpol] test pod $TEST_POD の起動に失敗"
trap "kubectl delete pod $TEST_POD -n $NS --force --grace-period=0 >/dev/null 2>&1 || true" EXIT
kubectl wait --for=condition=Ready pod/"$TEST_POD" -n "$NS" --timeout=120s >/dev/null \
  || fail "[netpol] test pod $TEST_POD が Ready にならない"

# §7: GCE metadata は明示的に except で block している → connection timeout or refused
if kubectl exec "$TEST_POD" -n "$NS" -- curl --max-time 5 -sS http://169.254.169.254/ >/dev/null 2>&1; then
  fail "[netpol] GCE metadata (169.254.169.254) に到達できてしまった — NetworkPolicy が機能していない or matchLabels が agent pod と一致しない"
fi
ok "[netpol] GCE metadata egress が遮断されている (= NetworkPolicy effective)"

# §8: OneCLI ClusterIP REST へは到達できる (10254 が許可されている)
if ! kubectl exec "$TEST_POD" -n "$NS" -- curl --max-time 5 -sS \
     "http://biblio-onecli.${NS}.svc.cluster.local:10254/v1/secrets" >/dev/null 2>&1; then
  fail "[netpol] OneCLI ClusterIP (TCP 10254) に到達できない — egress が広すぎる方向に壊れているか、OneCLI deployment が落ちている"
fi
ok "[netpol] OneCLI ClusterIP (10254) への egress 到達可能"

# === Summary ===
ok "==== PASS: M2 Phase 1 (M1 residual cleanup) verified ===="
info "Phase 2 verify を継続したい場合: bash scripts/verify-phase-2-wiring.sh"
