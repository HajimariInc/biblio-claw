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

# === 5. OneCLI sidecar 統合 (M2 PRD A Phase 3: 旧 OneCLI Deployment を廃止) ===
# Phase 3 で OneCLI は orchestrator Pod の Native sidecar (initContainers の
# `onecli` + `restartPolicy: Always`) に統合された。判定は:
#   1. 旧 Deployment `biblio-onecli` が存在しないこと
#   2. orchestrator Pod 内の `cloud-sql-proxy` + `onecli` initContainer の state.running が立っていること
orch_pod="biblio-orchestrator-0"

if kubectl get deployment biblio-onecli -n "$NS" >/dev/null 2>&1; then
  fail "[onecli] 旧 Deployment biblio-onecli が残置 — Phase 3 で廃止のはず (kubectl delete deployment biblio-onecli -n $NS)"
fi
ok "[onecli] 旧 Deployment biblio-onecli は削除済"

for c in cloud-sql-proxy onecli; do
  state="$(kubectl get pod "$orch_pod" -n "$NS" -o jsonpath="{.status.initContainerStatuses[?(@.name=='$c')].state}" 2>/dev/null || echo '')"
  case "$state" in
    *running*) ok "[onecli] $c sidecar running (Native sidecar)" ;;
    *) fail "[onecli] $c sidecar 未起動 (state=$state) — kubectl describe pod $orch_pod -n $NS で確認" ;;
  esac
done

# === 6. OneCLI REST 疎通 (orchestrator Pod 内から in-cluster ClusterIP 経由) ===
# image に curl / jq は焼かない方針 (Dockerfile 軽量化、Step 2.7 検証で判明)。
# Node 22 の global fetch を使う = host プロセスと同じ runtime を再利用、追加依存なし。
# 注: Phase 3 で OneCLI は orchestrator 同 Pod 内 localhost に居るが、Service
# `biblio-onecli` の selector が orchestrator に向くため、cluster-internal DNS
# 経由でも同じ経路に到達する (agent Pod 互換性のため Service は残す)。
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

# orchestrator container に readinessProbe が無いため `condition=Ready` は
# container Started (= node プロセス spawn) 直後に成立する。一方
# incrementBootCounter は instrumentation.js (OTel init) + enforceStartupBackoff
# + initDb + runMigrations の後 (src/index.ts:110) で呼ばれるため、Ready 成立から
# +1 完了まで秒オーダーの lag がある。固定 sleep では cold-start tail latency に
# 取りこぼされる (issue #72) ため、boots 値が boots_before を超えるまで polling する。
# 60s 上限は OTel init + migration 18 件適用 + log I/O の最悪値を観察上の余裕含めて。
boots_after=""
deadline=$(( $(date +%s) + 60 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  boots_after="$(read_boots)"
  if [ "$boots_after" -gt "$boots_before" ]; then
    break
  fi
  sleep 2
done
[ "$boots_after" -gt "$boots_before" ] || fail "[boots] 60s 以内に増分されない (before=$boots_before / after=$boots_after) — orchestrator 起動失敗の可能性、kubectl logs $orch_pod -n $NS -c orchestrator で確認 (本体正常時は 'Boot counter incremented' ログが見える)"
ok "[boots] $boots_before → $boots_after (= PVC + SQLite 永続化が機能)"

# === 8. gh-token-rotator sidecar (M2 PRD A Phase 3: 旧 CronJob を廃止) ===
# Phase 3 で旧 CronJob `biblio-sidecar` は廃止され、orchestrator Pod の
# `gh-token-rotator` container (Native sidecar、image biblio-sidecar-gh:m2-p3) の
# 50min sleep loop に統合された。判定は:
#   1. 旧 CronJob `biblio-sidecar` が存在しないこと
#   2. orchestrator Pod 内の `gh-token-rotator` container の state.running が立っていること
#   3. OneCLI に `biblio-claw-gh-token` (hostPattern=api.github.com) が反映済であること
if kubectl get cronjob biblio-sidecar -n "$NS" >/dev/null 2>&1; then
  fail "[sidecar] 旧 CronJob biblio-sidecar が残置 — Phase 3 で廃止のはず (kubectl delete cronjob biblio-sidecar -n $NS)"
fi
ok "[sidecar] 旧 CronJob biblio-sidecar は削除済"

rotator_state="$(kubectl get pod "$orch_pod" -n "$NS" -o jsonpath="{.status.containerStatuses[?(@.name=='gh-token-rotator')].state}" 2>/dev/null || echo '')"
case "$rotator_state" in
  *running*) ok "[sidecar] gh-token-rotator container running" ;;
  *) fail "[sidecar] gh-token-rotator container 未起動 (state=$rotator_state) — kubectl logs $orch_pod -c gh-token-rotator -n $NS で debug" ;;
esac

# OneCLI 側に token 反映確認 (curl/jq 非依存、node fetch を使う)。
# 注: OneCLI は GET /v1/secrets で value を mask した形 (length=0) で返す設計のため、
# value 長ではなく "secret の存在 + 想定 hostPattern との一致" で判定する。
# orchestrator container の localhost:10254 = 同 Pod 内 onecli sidecar に直結。
token_state="$(kubectl exec "$orch_pod" -n "$NS" -c orchestrator -- node -e \
  "fetch('http://localhost:10254/v1/secrets').then(r => r.json()).then(secrets => { const t = secrets.find(s => s.name === 'biblio-claw-gh-token'); process.stdout.write(t ? 'present:' + t.hostPattern : 'absent'); }).catch(e => { process.stdout.write('error:' + e.message); })" 2>/dev/null)"
case "$token_state" in
  present:api.github.com)
    ok "[sidecar] OneCLI に biblio-claw-gh-token 反映済 (hostPattern=api.github.com、value は OneCLI が mask)"
    ;;
  present:*)
    warn "[sidecar] biblio-claw-gh-token は存在するが hostPattern が想定外 ($token_state) — gh-token-rotator の env を確認"
    ;;
  absent)
    fail "[sidecar] OneCLI に biblio-claw-gh-token が見えない — kubectl logs $orch_pod -c gh-token-rotator -n $NS で debug (rotator は起動直後の 1 周期目で投入)"
    ;;
  *)
    fail "[sidecar] OneCLI への secrets list 取得に失敗 ($token_state)"
    ;;
esac

# === 9. Slack adapter 起動 (orchestrator 統合パターン、A 案) ===
# M1 Acceptance に「Slack 接続成立」が明記されているため、本 verify では Slack adapter
# 起動を必須条件として fail 判定する。判定ロジックは "Channel adapter started" + '"channel":"slack"'
# の 2 条件共起 — 単純な /slack/ では `Channel credentials missing, skipping` (= adapter
# skip = 偽陽性) と区別できない。
#
# GKE 経路のログ形式: orchestrator は `LOG_FORMAT=json` (k8s/10-orchestrator-statefulset.yaml:200)
# で動くため、src/log.ts:75-91 の `emitJson` が JSON 1 行を吐く。例:
#   {"severity":"INFO","message":"Channel adapter started","time":"...","component":"host-orchestrator","channel":"slack","type":"slack"}
# キーは colon 区切りの `"channel":"slack"` 形式 (= 旧 text logger の key=value `channel="slack"`
# 形式から init-project-gcp Phase 2 で切替済 = commit 9c113f0)。ANSI escape は JSON
# 経路では一切出力されないため剥離は不要。
#
# 判定対象は直近 120s のログのみに絞る = "起動 → credentials missing で再起動"
# のような複合履歴が tail に残っているとき、古い起動成功ログに先にマッチして
# 最新の credentials missing 状態を見落とす偽陽性を防ぐ (--since=120s)。
# kubectl logs が空 (Pod 異常 / ログ未生成) と取得失敗を fail メッセージで
# 区別できるよう、Pod phase も読む。
orch_logs="$(kubectl logs "$orch_pod" -n "$NS" --since=120s 2>/dev/null || true)"
if echo "$orch_logs" | grep -E '"message":"Channel adapter started"[^}]*"channel":"slack"' >/dev/null; then
  ok "[slack] Slack adapter 起動済 (Channel adapter started + \"channel\":\"slack\" 両一致)"
elif echo "$orch_logs" | grep -E '"message":"Channel credentials missing[^"]*"[^}]*"channel":"slack"' >/dev/null; then
  fail "[slack] Slack credentials が adapter から見えていない — env.ts の process.env fallback 動作 + biblio-slack-tokens Secret 投入 (kubectl get secret biblio-slack-tokens -n $NS) を確認"
else
  pod_phase="$(kubectl get pod "$orch_pod" -n "$NS" -o jsonpath='{.status.phase}' 2>/dev/null || echo 'unknown')"
  fail "[slack] Slack adapter 起動痕跡も credentials missing 痕跡も見えない (Pod phase=$pod_phase) — Pod が Running 以外なら kubectl describe pod/$orch_pod -n $NS で原因確認、Running ならログ未生成の可能性 (--since=120s 範囲外) のため kubectl logs $orch_pod -n $NS で生ログ確認"
fi

ok "==== Phase 2 GKE wiring assertion 全 pass (A 案) ===="
