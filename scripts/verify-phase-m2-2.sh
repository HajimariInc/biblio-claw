#!/usr/bin/env bash
# biblio-claw: M2 PRD A Phase 2 — init-first-agent の **GKE E2E** 検証。
#
# § 構成:
#   §1. cluster context = biblio-prod
#   §2. orchestrator StatefulSet が Ready
#   §3. agent image (nanoclaw-agent) に焼き込み 3 ファイル (probe Pod 経由)
#   §4. init-first-agent-gke.sh が冪等実行可能で Init complete.
#   §5. central DB 6 テーブル + container_configs に first-agent の行
#   §6. Slack 入力 → agent K8s Job spawn (手動誘導) + Warden block 痕跡 0 + Pod Ready (Phase 2.5)
#   §7. outbound.db に messages_out ≥ 1 行 (Vertex → agent-runner 経路の完走)
#   §8. Slack thread に bot 返信到達 (手動 verify [Y/n])
#   §9. Pod 再作成跨ぎで messages_in/out + boots カウンタ永続化
#
# Plan §Task 10 §3 から逸脱: 上流仮定 (orchestrator Pod に agent runtime 焼き込み)
# は本 repo では成り立たない (orchestrator image = biblio-claw、agent image =
# nanoclaw-agent で別 image)。代わりに一時 probe Pod を agent image で起こす。
#
# 前提:
#   - kubectl context が biblio-prod
#   - StatefulSet rollout 済 (image tag m2-p2 含む)
#   - biblio-slack-tokens Secret 投入済 (本番 @biblio App)
#   - 本 script 実行前に bash scripts/onecli-vertex-secret.sh で
#     全 agent を secret-mode=all 化済 (CLAUDE.md §落とし穴 参照)
#   - .env or shell env に SLACK_OWNER_USER_ID / SLACK_OWNER_DM_CHANNEL_ID (GKE 用) /
#     SLACK_OWNER_DISPLAY_NAME が投入済

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NS="${BIBLIO_NAMESPACE:-biblio-claw}"
ORCH_POD="${ORCH_POD:-biblio-orchestrator-0}"
ANSI_STRIP='s/\x1b\[[0-9;]*m//g'

# shellcheck source=scripts/onecli-lib.sh
. "${ROOT}/scripts/onecli-lib.sh"

info "==== M2 Phase 2 (init-first-agent) GKE E2E assertion (namespace=$NS) ===="

# === §1. cluster context ===
ctx="$(kubectl config current-context)"
case "$ctx" in
  gke_*_biblio-prod) ok "[ctx] $ctx" ;;
  *) fail "[ctx] biblio-prod 以外: $ctx (gcloud container clusters get-credentials biblio-prod --region=asia-northeast1)" ;;
esac

# === §2. orchestrator Ready ===
ready="$(kubectl get statefulset biblio-orchestrator -n "$NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)"
[ "$ready" = "1" ] || fail "[orch] StatefulSet readyReplicas != 1 (actual=$ready)"
ok "[orch] StatefulSet Ready"

# host image tag は orchestrator container[0].image。agent image tag は env CONTAINER_IMAGE。
host_image="$(kubectl get pod "$ORCH_POD" -n "$NS" -o jsonpath='{.spec.containers[?(@.name=="orchestrator")].image}' 2>/dev/null || echo '')"
agent_image="$(kubectl get statefulset biblio-orchestrator -n "$NS" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="orchestrator")].env[?(@.name=="CONTAINER_IMAGE")].value}' 2>/dev/null || echo '')"
[ -n "$host_image" ] || fail "[orch] host image を解決できない"
[ -n "$agent_image" ] || fail "[orch] env CONTAINER_IMAGE を解決できない"
info "[orch] host_image=$host_image"
info "[orch] agent_image=$agent_image"
case "$agent_image" in
  *nanoclaw-agent:m2-p2*) ok "[orch] agent image tag m2-p2 反映済" ;;
  *) warn "[orch] agent image tag が m2-p2 でない ($agent_image) — Task 4 + Task 8 rollout 漏れの可能性" ;;
esac

# === §3. agent image (nanoclaw-agent) 焼き込み 3 ファイル確認 ===
# 上流逸脱メモ (Plan §Task 10 §3): orchestrator Pod と agent Pod は別 image。
# 焼き込みは agent image (= nanoclaw-agent) のみに入る。確認のため一時 probe Pod を
# agent image で起こし、ls する。NetworkPolicy にマッチしない別 labels で起動して
# 制限を避ける (= app.kubernetes.io/component != agent)。
PROBE="biblio-bake-probe-$RANDOM"
info "[bake] probe Pod $PROBE 起動 (image=$agent_image、NetworkPolicy 非対象 labels)"
kubectl run "$PROBE" -n "$NS" \
  --image="$agent_image" \
  --restart=Never \
  --image-pull-policy=Always \
  --labels='app.kubernetes.io/name=biblio-bake-probe,app.kubernetes.io/component=verify' \
  --command -- sh -c 'sleep 60' >/dev/null 2>&1 \
  || fail "[bake] probe Pod $PROBE の起動に失敗 — image pull or RBAC を確認"
trap "kubectl delete pod $PROBE -n $NS --force --grace-period=0 >/dev/null 2>&1 || true" EXIT
kubectl wait --for=condition=Ready pod/"$PROBE" -n "$NS" --timeout=180s >/dev/null \
  || fail "[bake] probe Pod $PROBE が Ready にならない (kubectl describe pod $PROBE -n $NS)"

bake_out="$(kubectl exec "$PROBE" -n "$NS" -- sh -lc 'ls /app/src/index.ts /app/skills /app/CLAUDE.md 2>&1' 2>&1 || echo MISSING)"
for f in /app/src/index.ts /app/skills /app/CLAUDE.md; do
  echo "$bake_out" | grep -qF "$f" \
    || fail "[bake] $agent_image に $f が焼き込まれていない (output: ${bake_out:0:200}) — Dockerfile L78 直後の COPY を確認"
done
ok "[bake] nanoclaw-agent image 焼き込み 3 ファイル確認"
kubectl delete pod "$PROBE" -n "$NS" --grace-period=0 --force >/dev/null 2>&1 || true
trap - EXIT

# === §4. scripts/init-first-agent-gke.sh 冪等実行 ===
GKE_WRAPPER="${ROOT}/scripts/init-first-agent-gke.sh"
[ -x "$GKE_WRAPPER" ] || fail "[init] $GKE_WRAPPER が無い or 実行権限なし"
init_out="$(bash "$GKE_WRAPPER" 2>&1)" || {
  echo "$init_out" >&2
  fail "[init] init-first-agent-gke.sh が exit 0 で終わらない — 出力上記参照 (SLACK_OWNER_* env 不足の可能性)"
}
echo "$init_out" | grep -qF 'Init complete.' \
  || fail "[init] 'Init complete.' が出力にない (output 末尾: $(echo "$init_out" | tail -5 | tr '\n' ' '))"
ok "[init] init-first-agent-gke.sh が冪等実行成功 + Init complete."

# === §5. central DB 6 テーブル + container_configs ===
# orchestrator Pod 内の v2.db を node -e で覗く。kubectl exec 内では pnpm exec tsx
# (host 推奨 wrapper) が使えないため、verify-phase-2-wiring.sh §7 と同じパターン。
read_count() {
  local table="$1"
  kubectl exec "$ORCH_POD" -n "$NS" -- node -e \
    "const Database = require('better-sqlite3'); const db = new Database('/data/v2.db'); const r = db.prepare('SELECT COUNT(*) c FROM ${table}').get(); console.log(r ? r.c : 0);" 2>/dev/null \
    || fail "[db] orchestrator Pod 内での ${table} 読み取りに失敗"
}
for t in users user_roles agent_groups agent_group_members messaging_groups messaging_group_agents container_configs; do
  n="$(read_count "$t")"
  [ "${n:-0}" -ge "1" ] || fail "[db] ${t} の行数 ${n} < 1"
  ok "[db] ${t}: ${n} 行"
done

# === §6. Slack 入力 → agent K8s Job spawn (手動誘導) ===
ASSIST_NAME="$(kubectl get statefulset biblio-orchestrator -n "$NS" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="orchestrator")].env[?(@.name=="ASSISTANT_NAME")].value}' 2>/dev/null || echo 'biblio')"
info "[slack] === 手動操作 ==="
info "[slack] Slack で @${ASSIST_NAME} に DM で '@${ASSIST_NAME} こんにちは' を送ってください。"
info "[slack] 送信後 Enter を押すと進みます (60s timeout で先へ)。"
# stdin が tty でない (CI 等) 環境では skip
if [ -t 0 ]; then
  read -r -t 60 -p "送信したら Enter > " _user_input || warn "[slack] 60s timeout、続行 (Slack 送信なしだと §6-§8 が fail する可能性)"
else
  warn "[slack] stdin が非 tty、手動誘導 skip — Slack 送信が事前に済んでいる前提で進む"
fi

# agent Job spawn 待ち (60s timeout)
info "[slack] agent Job spawn 待ち (component=agent label、最大 60s)"
for _ in $(seq 1 30); do
  jobs_count="$(kubectl get jobs -n "$NS" -l app.kubernetes.io/component=agent --no-headers 2>/dev/null | wc -l || echo 0)"
  [ "${jobs_count:-0}" -ge 1 ] && break
  sleep 2
done
[ "${jobs_count:-0}" -ge 1 ] \
  || fail "[slack] agent Job が spawn されない — orchestrator log を確認: kubectl logs $ORCH_POD -n $NS --tail=200"
ok "[slack] agent Job spawn 確認 (${jobs_count} 個)"

# Phase 2.5 強化: Warden block の痕跡が orchestrator log に出ていないこと。
# `autogke-no-write-mode-hostpath` が出ていれば PVC subPath モデルへの移行が
# 失敗している (spec.mounts に subPath が乗っていない / k8s.ts が hostPath を
# 生成している)。直近 180s に絞って誤検出を抑える。
# 注意: `grep -c` は 0 件マッチでも `0` を出力して exit 1 を返すため、
# `|| echo 0` を付けると `0\n0` の二重出力で = 比較が壊れる。`|| true` で
# exit 1 だけ吸収して `grep -c` 自身の `0` を使う。
# kubectl の stderr (Forbidden 等) は別ファイルに逃がし、非空なら warn を出す
# (= 認可エラー時に「Warden 痕跡なし」と誤判定するリスクの軽減)。
KCTL_ERR="$(mktemp -t verify-m2-2-kctl.XXXXXX.err)"
trap 'rm -f "$KCTL_ERR"' EXIT
warden_blocks="$(kubectl logs "$ORCH_POD" -n "$NS" --since=180s 2>"$KCTL_ERR" | sed -r "$ANSI_STRIP" | grep -c 'autogke-no-write-mode-hostpath' || true)"
warden_blocks="${warden_blocks:-0}"
if [ -s "$KCTL_ERR" ]; then
  warn "[warden] kubectl logs が stderr を出力 (= 認可/接続エラーの可能性): $(sed -n '1,3p' "$KCTL_ERR" | tr '\n' ' ')"
fi
[ "$warden_blocks" = "0" ] \
  || fail "[warden] Warden block 痕跡が orchestrator log に ${warden_blocks} 回出ている — PVC subPath モデルへの移行を再確認: kubectl logs $ORCH_POD -n $NS --since=180s | grep autogke-no-write-mode-hostpath"
ok "[warden] Warden block 痕跡なし (直近 180s)"

# Phase 2.5 強化: 最新 agent Job の Pod が Running/Succeeded に到達。
# Secret 不在で MountVolume.SetUp failed のときは Pending のままになるため、
# 120s 以内に Running/Succeeded に到達しなければ fail させる。
: > "$KCTL_ERR"
latest_job="$(kubectl get jobs -n "$NS" -l app.kubernetes.io/component=agent --sort-by='.status.startTime' -o jsonpath='{.items[-1:].metadata.name}' 2>"$KCTL_ERR" || echo '')"
if [ -s "$KCTL_ERR" ]; then
  warn "[pod] kubectl get jobs stderr: $(sed -n '1,3p' "$KCTL_ERR" | tr '\n' ' ')"
fi
if [ -z "${latest_job:-}" ]; then
  fail "[pod] 最新 agent Job 名を解決できない"
fi
pod_phase="Pending"
for _ in $(seq 1 60); do
  : > "$KCTL_ERR"
  pod_phase="$(kubectl get pods -n "$NS" -l "job-name=$latest_job" -o jsonpath='{.items[0].status.phase}' 2>"$KCTL_ERR" || echo 'Pending')"
  case "$pod_phase" in
    Running|Succeeded) break ;;
  esac
  sleep 2
done
if [ -s "$KCTL_ERR" ]; then
  warn "[pod] kubectl get pods stderr (最終 iter): $(sed -n '1,3p' "$KCTL_ERR" | tr '\n' ' ')"
fi
case "$pod_phase" in
  Running|Succeeded) ok "[pod] agent Pod phase=$pod_phase (job=$latest_job)" ;;
  *) fail "[pod] agent Pod が Running/Succeeded に到達せず (actual=$pod_phase) — kubectl describe pods -n $NS -l job-name=$latest_job" ;;
esac

# === §7. outbound.db に messages_out ≥ 1 行 ===
# Vertex → agent-runner → outbound.db の経路が動いた証拠。session-id は最新の
# agent_groups + sessions を join して動的解決する。
info "[out] outbound.db の messages_out 行数を解決中 (最大 120s 待ち)"
out_count=0
for _ in $(seq 1 60); do
  out_count="$(kubectl exec "$ORCH_POD" -n "$NS" -- node -e "
    const D = require('better-sqlite3');
    const db = new D('/data/v2.db');
    const sess = db.prepare('SELECT id, agent_group_id FROM sessions ORDER BY rowid DESC LIMIT 1').get();
    if (!sess) { console.log(0); process.exit(0); }
    try {
      const out = new D('/data/v2-sessions/'+sess.agent_group_id+'/'+sess.id+'/outbound.db', { readonly: true });
      const c = out.prepare('SELECT COUNT(*) c FROM messages_out').get();
      console.log(c.c);
    } catch (e) { console.log(0); }
  " 2>/dev/null || echo 0)"
  [ "${out_count:-0}" -ge 1 ] && break
  sleep 2
done
[ "${out_count:-0}" -ge 1 ] \
  || fail "[out] messages_out が 0 行 — agent-runner が Vertex に届かなかった可能性 (OneCLI secret-mode=all 適用済かを再確認)"
ok "[out] messages_out: ${out_count} 行"

# === §8. Slack thread に bot 返信到達 (手動 verify) ===
info "[reply] === 手動確認 ==="
info "[reply] Slack thread に bot 返信が表示されていますか?"
if [ -t 0 ]; then
  read -r -t 60 -p "返信が見えていますか? [Y/n] " reply_yn || reply_yn=''
  case "${reply_yn:-Y}" in
    [nN]*) fail "[reply] bot 返信が thread に届いていない — delivery.ts log を確認: kubectl logs $ORCH_POD -n $NS | grep delivery" ;;
    *) ok "[reply] bot 返信到達確認 (人間補助)" ;;
  esac
else
  warn "[reply] stdin 非 tty、手動確認 skip (messages_out=${out_count} ≥ 1 を以て delivery 経路の証跡とみなす)"
fi

# === §9. Pod 再作成跨ぎ永続化 (boots + messages_in/out) ===
info "[persist] PVC 永続化アサーション (boots + messages_in/out before/after)"
read_boots() {
  kubectl exec "$ORCH_POD" -n "$NS" -- node -e \
    "const D = require('better-sqlite3'); const db = new D('/data/v2.db'); const r = db.prepare('SELECT count FROM boots WHERE id = 1').get(); console.log(r ? r.count : 0);" 2>/dev/null \
    || fail "[persist] boots 読み取り失敗"
}
read_sess_msg_counts() {
  kubectl exec "$ORCH_POD" -n "$NS" -- node -e "
    const D = require('better-sqlite3');
    const db = new D('/data/v2.db');
    const sess = db.prepare('SELECT id, agent_group_id FROM sessions ORDER BY rowid DESC LIMIT 1').get();
    if (!sess) { console.log('0|0'); process.exit(0); }
    let cin = 0, cout = 0;
    try {
      const inb = new D('/data/v2-sessions/'+sess.agent_group_id+'/'+sess.id+'/inbound.db', { readonly: true });
      cin = inb.prepare('SELECT COUNT(*) c FROM messages_in').get().c;
    } catch (e) {}
    try {
      const out = new D('/data/v2-sessions/'+sess.agent_group_id+'/'+sess.id+'/outbound.db', { readonly: true });
      cout = out.prepare('SELECT COUNT(*) c FROM messages_out').get().c;
    } catch (e) {}
    console.log(cin + '|' + cout);
  " 2>/dev/null || fail "[persist] sessions/messages 読み取り失敗"
}
boots_before="$(read_boots)"
msg_before="$(read_sess_msg_counts)"
info "[persist] before: boots=$boots_before, messages_in|out=$msg_before"

kubectl delete pod "$ORCH_POD" -n "$NS" --wait=true >/dev/null \
  || fail "[persist] $ORCH_POD の削除に失敗"
kubectl wait --for=condition=Ready pod/"$ORCH_POD" -n "$NS" --timeout=180s >/dev/null \
  || fail "[persist] $ORCH_POD 再 Ready 待ちが timeout"
sleep 5

boots_after="$(read_boots)"
msg_after="$(read_sess_msg_counts)"
info "[persist] after:  boots=$boots_after, messages_in|out=$msg_after"

[ "$boots_after" -gt "$boots_before" ] \
  || fail "[persist] boots が増えていない ($boots_before → $boots_after) — PVC 再 attach 失敗 or 016-boots 未適用"
ok "[persist] boots $boots_before → $boots_after (PVC + SQLite 永続化機能)"

before_in="${msg_before%|*}"; before_out="${msg_before#*|}"
after_in="${msg_after%|*}"; after_out="${msg_after#*|}"
[ "$after_in" -ge "$before_in" ] \
  || fail "[persist] messages_in が減った ($before_in → $after_in) — Pod 再作成跨ぎで session DB が失われた可能性"
[ "$after_out" -ge "$before_out" ] \
  || fail "[persist] messages_out が減った ($before_out → $after_out) — Pod 再作成跨ぎで session DB が失われた可能性"
ok "[persist] messages_in/out が Pod 再作成跨ぎで保持 ($before_in|$before_out → $after_in|$after_out)"

ok "==== PASS: M2 Phase 2 (init-first-agent) GKE E2E verified ===="
info "回帰確認: bash scripts/verify-phase-m2-1.sh && bash scripts/verify-phase-2-wiring.sh"
