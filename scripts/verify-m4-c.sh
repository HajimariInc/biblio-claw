#!/usr/bin/env bash
# biblio-claw: M4-C Phase 2 週次 reporting 統合検証
#
# CronJob → BQ query → Slack owner DM の 4 stage pipeline を Prod で E2E 確認する:
#   1. preflight (.env / 必須 env / 必須 CLI)
#   2. keyless 4 面アサート (GAC empty / ADC type / SA key 不在 / TF に key resource なし)
#   3. CronJob 存在 + schedule/concurrencyPolicy 確認 (静的 spec assert)
#   4. manual trigger 経路確認 (kubectl create job --from + wait + logs で completed event 確認)
#   5. BQ event 到達確認 (過去 1h に reporting.cronjob.completed + reporting.bq_query_succeeded)
#   6. regression (verify-m4-a.sh chain) + PASS marker
#
# 全通過で `M4-C PASS` を出して exit 0、いずれかの assert で fail 時 exit 1。
#
# 必須 env (未設定で fail-fast):
#   GCP_PROJECT_ID    e.g. <your-gcp-project>
#   BQ_DATASET_ID     e.g. llm_observability
#
# 任意 env:
#   VERIFY_M4C_NAMESPACE     default 'biblio-claw'
#   VERIFY_M4C_CRONJOB_NAME  default 'reporting-cronjob'
#
# 前提:
#   - GKE Prod cluster に kubectl 到達可能 (kubeconfig 済)
#   - M4-A Phase 3 sink (terraform/m4-a-observability/) apply 済
#   - M4-C Phase 1 reporting-cronjob deploy 済 + Slack tokens Secret 済
#
# 副作用:
#   - Section 4 で verify 用 K8s Job を発火 → Prod 経路の実 BQ query 4 種 + Slack owner DM post
#     が走る (owner DM に 2 連続実行なら 2 通の verify 用 DM が届く = plan で既定路線)。
#   - trap cleanup で verify 用 Job のみを削除 (reporting-cronjob 本体 CronJob には touch しない)。
#
# 所要時間: ~3-8 min (Job 完了待ち + BQ 到達 lag が支配項)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# helpers から: info / warn / fail を利用 (M4-A pattern 踏襲)。
# shellcheck source=scripts/verify-m3-helpers.sh
source "$(dirname "${BASH_SOURCE[0]}")/verify-m3-helpers.sh"

# 引数解析: `--prod` は現状唯一の mode (safe default = prod 想定なので実質 no-op)、
# 明示指定を許容して verify-fugue-channel.sh --prod との呼出流儀を揃える。
MODE='prod'
for arg in "$@"; do
  case "$arg" in
    --prod) MODE='prod' ;;
    -h|--help)
      cat <<'EOF'
Usage: bash scripts/verify-m4-c.sh [--prod]
  --prod   Prod GKE cluster 経路で検証 (default、現状唯一の mode)
EOF
      exit 0
      ;;
    *) fail "unknown arg: $arg" ;;
  esac
done

NAMESPACE="${VERIFY_M4C_NAMESPACE:-biblio-claw}"
CRONJOB_NAME="${VERIFY_M4C_CRONJOB_NAME:-reporting-cronjob}"

# =============================================================================
# Section 1: preflight (.env + 必須 env + 必須 CLI)
# =============================================================================
info '=== [1/6] preflight: .env + 必須 env + 必須 CLI ==='

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . .env
  set +a
else
  warn ".env が見つかりません — GKE / CI 経路 (env 直接投入) と想定して継続"
fi

: "${GCP_PROJECT_ID:?preflight fail-fast: 未設定 (e.g. <your-gcp-project>)。.env.example の §Observability 節を参照}"
: "${BQ_DATASET_ID:?preflight fail-fast: 未設定 (e.g. llm_observability)}"

for cmd in gcloud bq jq node kubectl; do
  command -v "$cmd" >/dev/null 2>&1 || fail "必須 CLI が見つかりません: $cmd"
done

info "  project=${GCP_PROJECT_ID} dataset=${BQ_DATASET_ID} mode=${MODE}"
info "  namespace=${NAMESPACE} cronjob=${CRONJOB_NAME}"

STDERR_DIR="$(mktemp -d -t biblio-m4c-stderr-XXXXXX)"
LAST_HARNESS_STDERR=''
VERIFY_JOB_NAME=''
cleanup() {
  # verify 用 Job のみを削除。Job 名は Section 4 で決まる (`verify-m4c-<epoch>`)、
  # cronjob 本体 (`reporting-cronjob`) には触らない。
  if [ -n "${VERIFY_JOB_NAME:-}" ]; then
    kubectl delete job "$VERIFY_JOB_NAME" -n "$NAMESPACE" --ignore-not-found=true --wait=false >/dev/null 2>&1 || true
  fi
  rm -rf "$STDERR_DIR"
}
trap cleanup EXIT INT TERM

# =============================================================================
# Section 2: keyless 4 面アサート (verify-m4-a.sh:72-108 と同一)
# =============================================================================
info '=== [2/6] keyless 4 面アサート ==='

# (2-1) GOOGLE_APPLICATION_CREDENTIALS 未設定であること
if [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
  fail "GOOGLE_APPLICATION_CREDENTIALS がセットされている (keyless 違反): ${GOOGLE_APPLICATION_CREDENTIALS}"
fi

# (2-2) ADC type が keyless 経路のいずれか
adc_type="$(node -e "
const fs=require('fs'), os=require('os'), path=require('path');
const p = path.join(os.homedir(), '.config/gcloud/application_default_credentials.json');
try { console.log(JSON.parse(fs.readFileSync(p,'utf8')).type ?? 'unknown'); }
catch { console.log('missing'); }
")"
case "$adc_type" in
  authorized_user|external_account|impersonated_service_account)
    info "  ADC type=$adc_type (OK)" ;;
  missing)
    fail "ADC 不在 — gcloud auth application-default login を実行してください" ;;
  *)
    fail "ADC type='$adc_type' (期待: authorized_user / external_account / impersonated_service_account)" ;;
esac

# (2-3) repo 内に SA key 形式 json が tracked されていないこと
sa_keys="$(git ls-files -- '*.json' 2>/dev/null | while IFS= read -r f; do
  [ -f "$f" ] && grep -lE '"type"[[:space:]]*:[[:space:]]*"service_account"' "$f" 2>/dev/null || true
done)"
if [ -n "$sa_keys" ]; then
  fail "SA 鍵 json がコミットされている (keyless 違反): $sa_keys"
fi

# (2-4) Terraform に google_service_account_key resource が存在しないこと
if grep -rq 'google_service_account_key' terraform/ 2>/dev/null; then
  fail "terraform 配下に google_service_account_key resource が存在 (keyless 違反)"
fi

info '  → keyless 4 面すべて OK'

# =============================================================================
# Section 3: CronJob 存在 + schedule/concurrencyPolicy 確認
# =============================================================================
info '=== [3/6] CronJob 存在 + schedule/concurrencyPolicy 確認 ==='

# CronJob が Prod に deploy されているか
if ! kubectl get cronjob "$CRONJOB_NAME" -n "$NAMESPACE" >/dev/null 2>"$STDERR_DIR/kubectl-get-cronjob.stderr"; then
  LAST_HARNESS_STDERR="$STDERR_DIR/kubectl-get-cronjob.stderr"
  fail "CronJob '$CRONJOB_NAME' が namespace '$NAMESPACE' に存在しない
    対処: k8s/30-reporting-cronjob.yaml を apply 済か確認 (kubectl apply -f k8s/)"
fi

# schedule を静的に assert (実 manifest では "0 9 * * 1" = JST 月曜 09:00)。
# 変更する場合は本 assert と manifest を同時に更新すること。
SCHEDULE="$(kubectl get cronjob "$CRONJOB_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.schedule}')"
if [ "$SCHEDULE" != '0 9 * * 1' ]; then
  fail "CronJob schedule 期待 '0 9 * * 1' (JST 月曜 09:00)、実際 '$SCHEDULE'"
fi
info "  ✓ schedule='$SCHEDULE'"

# concurrencyPolicy が Forbid であること (実行漏れ検知 + double-fire 防止)
CONCURRENCY="$(kubectl get cronjob "$CRONJOB_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.concurrencyPolicy}')"
if [ "$CONCURRENCY" != 'Forbid' ]; then
  fail "CronJob concurrencyPolicy 期待 'Forbid'、実際 '$CONCURRENCY'"
fi
info "  ✓ concurrencyPolicy='$CONCURRENCY'"

# =============================================================================
# Section 4: manual trigger 経路確認 (Job 発火 + wait + logs で completed event 確認)
# =============================================================================
info '=== [4/6] manual trigger 経路確認 ==='

# Job 名: verify-m4c-<epoch>-<pid> で 2 連続実行の名前衝突を避ける。
# epoch は Linux date +%s、pid は $$。
VERIFY_JOB_NAME="verify-m4c-$(date +%s)-$$"
info "  create job: $VERIFY_JOB_NAME"

if ! kubectl create job "$VERIFY_JOB_NAME" --from="cronjob/$CRONJOB_NAME" -n "$NAMESPACE" \
    >/dev/null 2>"$STDERR_DIR/kubectl-create-job.stderr"; then
  LAST_HARNESS_STDERR="$STDERR_DIR/kubectl-create-job.stderr"
  fail "kubectl create job 失敗 (concurrencyPolicy=Forbid で本体 CronJob 実行中の可能性、または RBAC 不足)"
fi

# Job 完了待ち (timeout 5min)。BQ query 4 種 + Slack post を通常 30-60s で完了する想定。
info "  wait for complete (timeout 5min)..."
if ! kubectl wait --for=condition=complete "job/$VERIFY_JOB_NAME" -n "$NAMESPACE" --timeout=5m \
    >/dev/null 2>"$STDERR_DIR/kubectl-wait.stderr"; then
  # 失敗経路: Job が failed condition に落ちた可能性もあるため logs を tail
  LAST_HARNESS_STDERR="$STDERR_DIR/kubectl-wait.stderr"
  warn "Job 完了 wait 失敗 — logs を tail:"
  kubectl logs "job/$VERIFY_JOB_NAME" -n "$NAMESPACE" 2>/dev/null | tail -30 || true
  fail "Job '$VERIFY_JOB_NAME' が 5min 以内に complete しなかった
    対処: (1) BQ query timeout の可能性 (SQL syntax / 権限) — 上の logs で確認 /
          (2) Slack post 失敗の可能性 — biblio-slack-tokens Secret 有効か"
fi

# logs で reporting.cronjob.completed event 確認
JOB_LOGS="$(kubectl logs "job/$VERIFY_JOB_NAME" -n "$NAMESPACE" 2>"$STDERR_DIR/kubectl-logs.stderr")"
if ! echo "$JOB_LOGS" | grep -q 'reporting.cronjob.completed'; then
  LAST_HARNESS_STDERR="$STDERR_DIR/kubectl-logs.stderr"
  warn "Job logs (tail 30):"
  echo "$JOB_LOGS" | tail -30
  fail "Job logs に 'reporting.cronjob.completed' event が含まれない"
fi
info '  ✓ reporting.cronjob.completed event を Job logs で確認'

# =============================================================================
# Section 5: BQ event 到達確認 (Cloud Logging → sink → BQ export)
# =============================================================================
info '=== [5/6] BQ event 到達確認 ==='

# BQ export lag を吸収するため sleep 10 × 30 回 = 5 min timeout の poll ループ。
# 過去 1h に reporting.cronjob.completed >= 1 件 + reporting.bq_query_succeeded >= 4 件
# (biblio-usage / inspect-distribution / error-trend / llm-cost の 4 種)。
BQ_TABLE="stdout"

# stdout / stderr のどちらに reporting.* event が入っているか動的判定 (M4-A pattern 踏襲)。
# reporting.cronjob.* は log.info / log.error 両経路がある = stdout / stderr 両方 candidate。
ALL_TABLES="$(bq ls --project_id="$GCP_PROJECT_ID" --format=json "$BQ_DATASET_ID" 2>"$STDERR_DIR/bq-ls.stderr" \
  | jq -r '.[].tableReference.tableId' 2>"$STDERR_DIR/bq-ls-jq.stderr" \
  | grep -E '^(stdout|stderr)$' | tr '\n' ' ')"
[ -n "$ALL_TABLES" ] || fail "BQ dataset '${GCP_PROJECT_ID}:${BQ_DATASET_ID}' に stdout/stderr が存在しない"
info "  対象テーブル: $ALL_TABLES"

BQ_POLL_MAX=30
completed_found=0
bq_query_count=0

for i in $(seq 1 "$BQ_POLL_MAX"); do
  completed_sum=0
  bq_query_sum=0
  for T in $ALL_TABLES; do
    C1="$(bq query --project_id="$GCP_PROJECT_ID" --use_legacy_sql=false --format=csv --quiet \
      "SELECT COUNT(*) FROM \`${GCP_PROJECT_ID}.${BQ_DATASET_ID}.${T}\` \
       WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR) \
       AND jsonPayload.event = 'reporting.cronjob.completed'" \
      2>"$STDERR_DIR/bq-completed-${i}-${T}.stderr" | tail -n1 || echo NA)"
    C2="$(bq query --project_id="$GCP_PROJECT_ID" --use_legacy_sql=false --format=csv --quiet \
      "SELECT COUNT(*) FROM \`${GCP_PROJECT_ID}.${BQ_DATASET_ID}.${T}\` \
       WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR) \
       AND jsonPayload.event = 'reporting.bq_query_succeeded'" \
      2>"$STDERR_DIR/bq-sqlexec-${i}-${T}.stderr" | tail -n1 || echo NA)"
    [[ "$C1" =~ ^[0-9]+$ ]] && completed_sum=$((completed_sum + C1))
    [[ "$C2" =~ ^[0-9]+$ ]] && bq_query_sum=$((bq_query_sum + C2))
  done
  if [ "$completed_sum" -ge 1 ] && [ "$bq_query_sum" -ge 4 ]; then
    completed_found=1
    bq_query_count=$bq_query_sum
    info "  [attempt ${i}/${BQ_POLL_MAX}] BQ 到達 OK (completed=${completed_sum}, bq_query_succeeded=${bq_query_sum}) after ~$(( (i-1) * 10 ))s"
    break
  fi
  info "  [attempt ${i}/${BQ_POLL_MAX}] BQ 未到達 (completed=${completed_sum}, bq_query_succeeded=${bq_query_sum}); sleep 10s"
  sleep 10
done

if [ "$completed_found" -ne 1 ]; then
  fail "BQ event 到達確認 fail: reporting.cronjob.completed >= 1 + reporting.bq_query_succeeded >= 4 が 5min 以内に届かず
    対処: (1) sink writer_identity に roles/bigquery.dataEditor 付与済か /
          (2) Cloud Logging → BQ export lag (通常数秒-30s、稀に 1-2min) の可能性、少し待って再実行 /
          (3) Job 内で SQL query が事前 fail した可能性 (Section 4 logs を再確認)"
fi
info "  ✓ reporting.bq_query_succeeded 到達数=${bq_query_count} (>= 4)"

# =============================================================================
# Section 6: regression (verify-m4-a.sh chain) + PASS marker
# =============================================================================
info '=== [6/6] regression: verify-m4-a.sh chain 実行 ==='

# verify-m4-a.sh は非破壊 (draft PR 作らない = safe to chain)。M4-A regression 確認。
if ! bash scripts/verify-m4-a.sh; then
  fail "verify-m4-a.sh regression fail (M4-A の観測経路が壊れている、上の出力を確認)"
fi
info '  ✓ verify-m4-a.sh chain PASS'

# =============================================================================
# PASS marker
# =============================================================================
info '  all assertions passed (preflight + keyless + cronjob-spec + manual-trigger + bq-event-arrival + regression)'
echo 'M4-C PASS'
