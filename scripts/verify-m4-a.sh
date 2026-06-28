#!/usr/bin/env bash
# biblio-claw: M4-A Phase 4 統合検証
#
# 1 リクエストの観測経路全体を E2E で確定的に確認する:
#   1. preflight (.env / 必須 env)
#   2. keyless 4 面アサート (GAC empty / ADC type / SA key 不在 / TF state に key resource なし)
#   3. emit-test-span.ts 実行 → TRACE_ID / REQUEST_ID 抽出
#   4. Cloud Trace API ポーリング (sleep 3 × 30 回 = 90s timeout、span >= 1 で break)
#   5. BigQuery ポーリング (sleep 10 × 30 回 = 5 min timeout、stdout_* / stderr_* UNION)
#   6. summary SQL 実行 → hit_count >= 1 + marker = 'M4A_OK'
#   7. ネガティブ対照 (random trace_id で BQ 0 行 + sink filter 静的 grep)
#
# 全通過で `M4-A PASS` を出して exit 0、いずれかの assert で fail 時 exit 1。
#
# 必須 env (未設定で fail-fast):
#   GCP_PROJECT_ID         e.g. hajimari-ai-hackathon-2026
#   BQ_DATASET_ID          e.g. llm_observability
#
# 前提:
#   - gcloud auth application-default login 済 (ADC type = authorized_user / external_account /
#     impersonated_service_account のいずれか)
#   - GSA / 実行ユーザに roles/cloudtrace.user + roles/bigquery.dataViewer 付与済
#   - M4-A Phase 3 sink (terraform/m4-a-observability/) が apply 済 (= BQ dataset / sink 稼働中)
#
# 所要時間: ~2-6 min (BQ 到達待ちが支配項)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# info/warn/fail/extract_result/json_field/json_array_length/probe_onecli は helpers に集約。
# shellcheck source=scripts/verify-m3-helpers.sh
source "$(dirname "${BASH_SOURCE[0]}")/verify-m3-helpers.sh"

# =============================================================================
# Section 1: preflight (.env + 必須 env)
# =============================================================================
info '=== [1/7] preflight: .env + 必須 env ==='

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . .env
  set +a
else
  warn ".env が見つかりません — GKE / CI 経路 (env 直接投入) と想定して継続"
fi

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID must be set (e.g. hajimari-ai-hackathon-2026)}"
: "${BQ_DATASET_ID:?BQ_DATASET_ID must be set (e.g. llm_observability)}"

# 必要 CLI が PATH 上にいるか fail-fast。
for cmd in gcloud bq jq node; do
  command -v "$cmd" >/dev/null 2>&1 || fail "必須 CLI が見つかりません: $cmd"
done

info "  project=${GCP_PROJECT_ID} dataset=${BQ_DATASET_ID}"

# 一時ディレクトリ + trap cleanup (M4-A は destructive PR を作らない = draft cleanup 不要)。
STDERR_DIR="$(mktemp -d -t biblio-m4a-stderr-XXXXXX)"
LAST_HARNESS_STDERR=''
trap 'rm -rf "$STDERR_DIR"' EXIT INT TERM

# =============================================================================
# Section 2: keyless 4 面アサート
# =============================================================================
info '=== [2/7] keyless 4 面アサート ==='

# (2-1) GOOGLE_APPLICATION_CREDENTIALS 未設定であること。
if [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
  fail "GOOGLE_APPLICATION_CREDENTIALS がセットされている (keyless 違反): ${GOOGLE_APPLICATION_CREDENTIALS}"
fi

# (2-2) ADC type が authorized_user / external_account / impersonated_service_account のいずれか。
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
    fail "ADC が見つかりません — gcloud auth application-default login を実行してください" ;;
  *)
    fail "ADC type='$adc_type' (期待: authorized_user / external_account / impersonated_service_account = keyless 経路)" ;;
esac

# (2-3) repo 内に SA key 形式 json が tracked されていないこと。
sa_keys="$(git ls-files -- '*.json' 2>/dev/null | while IFS= read -r f; do
  [ -f "$f" ] && grep -lE '"type"[[:space:]]*:[[:space:]]*"service_account"' "$f" 2>/dev/null || true
done)"
if [ -n "$sa_keys" ]; then
  fail "SA 鍵 json がコミットされている (keyless 違反): $sa_keys"
fi

# (2-4) Terraform に google_service_account_key resource が存在しないこと。
if grep -q 'google_service_account_key' terraform/m4-a-observability/*.tf 2>/dev/null; then
  fail "terraform に google_service_account_key resource が存在 (keyless 違反)"
fi

info '  → keyless 4 面すべて OK'

# =============================================================================
# Section 3: emit-test-span 実行 → TRACE_ID / REQUEST_ID 抽出
# =============================================================================
info '=== [3/7] emit-test-span 実行 ==='

LAST_HARNESS_STDERR="$STDERR_DIR/emit.stderr"
EMIT_OUT="$(pnpm exec tsx --import ./src/instrumentation.ts scripts/emit-test-span.ts 2>"$LAST_HARNESS_STDERR")" \
  || fail "emit-test-span が exit 0 を返さなかった"

TRACE_ID="$(printf '%s\n' "$EMIT_OUT" | sed -n 's/^TRACE_ID=//p' | head -n1)"
REQUEST_ID="$(printf '%s\n' "$EMIT_OUT" | sed -n 's/^REQUEST_ID=//p' | head -n1)"
SESSION_ID="$(printf '%s\n' "$EMIT_OUT" | sed -n 's/^SESSION_ID=//p' | head -n1)"

[[ "$TRACE_ID" =~ ^[0-9a-f]{32}$ ]] || fail "TRACE_ID 形式不正: '$TRACE_ID'"
[ -n "$REQUEST_ID" ] || fail "REQUEST_ID が抽出できなかった"
[ -n "$SESSION_ID" ] || fail "SESSION_ID が抽出できなかった"

info "  TRACE_ID=$TRACE_ID"
info "  REQUEST_ID=$REQUEST_ID"
info "  SESSION_ID=$SESSION_ID"

# =============================================================================
# Section 4: Cloud Trace API ポーリング (90s timeout)
# =============================================================================
info '=== [4/7] Cloud Trace API ポーリング (sleep 3 × 30 回 = max 90s) ==='

TOKEN="$(gcloud auth application-default print-access-token 2>"$STDERR_DIR/adc-token.stderr")" \
  || { LAST_HARNESS_STDERR="$STDERR_DIR/adc-token.stderr"; fail "ADC access token 取得失敗"; }

TRACE_BODY=''
trace_span_count=0
for i in $(seq 1 30); do
  body="$(curl -fsS -H "Authorization: Bearer $TOKEN" \
    "https://cloudtrace.googleapis.com/v1/projects/${GCP_PROJECT_ID}/traces/${TRACE_ID}" \
    2>"$STDERR_DIR/trace-curl-$i.stderr" || true)"
  if [ -n "$body" ]; then
    trace_span_count="$(printf '%s' "$body" | jq -r '.spans | length // 0' 2>/dev/null || echo 0)"
    if [ "$trace_span_count" -ge 1 ] 2>/dev/null; then
      TRACE_BODY="$body"
      info "  [attempt ${i}/30] trace 到達 (spans=${trace_span_count}) after ~$(( (i-1) * 3 ))s"
      break
    fi
  fi
  info "  [attempt ${i}/30] not yet; sleep 3s"
  sleep 3
done

if [ -z "$TRACE_BODY" ]; then
  LAST_HARNESS_STDERR="$STDERR_DIR/trace-curl-30.stderr"
  fail "Cloud Trace に trace_id=$TRACE_ID が 90s 以内に到達しなかった
    対処: (1) Cloud Trace API enabled か / (2) ADC 実行ユーザに roles/cloudtrace.user 付与済か /
          (3) 実機の OTel SDK が起動しているか (shutdownOtel() で flush 強制中)"
fi

# span 内容アサート: root span 名 + biblio.request_id 属性
root_span_name="$(printf '%s' "$TRACE_BODY" | jq -r '.spans[0].name // ""')"
[ "$root_span_name" = 'biblio.acquire' ] \
  || fail "root span 名 != 'biblio.acquire': '$root_span_name'"

# Cloud Trace REST v1 では属性は spans[].labels に dict 形で入る。
labels_request_id="$(printf '%s' "$TRACE_BODY" | jq -r '.spans[0].labels["biblio.request_id"] // ""')"
[ "$labels_request_id" = "$REQUEST_ID" ] \
  || fail "labels[biblio.request_id]='$labels_request_id' != REQUEST_ID='$REQUEST_ID'"

labels_test_fixture="$(printf '%s' "$TRACE_BODY" | jq -r '.spans[0].labels["biblio.test_fixture"] // ""')"
[ "$labels_test_fixture" = 'true' ] \
  || fail "labels[biblio.test_fixture] != 'true': '$labels_test_fixture'"

info '  → root span = biblio.acquire + 属性一致 OK'

# =============================================================================
# Section 5: BigQuery ポーリング (5 min timeout)
# =============================================================================
info '=== [5/7] BigQuery 到達ポーリング (sleep 10 × 30 回 = max 5 min) ==='

# stdout_* / stderr_* テーブルを動的に列挙 (= sharded suffix を吸収)。
TABLES="$(bq ls --format=json --max_results=500 "${GCP_PROJECT_ID}:${BQ_DATASET_ID}" 2>"$STDERR_DIR/bq-ls.stderr" \
  | jq -r '.[].tableReference.tableId' 2>/dev/null \
  | grep -E '^stdout_|^stderr_' || true)"
if [ -z "$TABLES" ]; then
  LAST_HARNESS_STDERR="$STDERR_DIR/bq-ls.stderr"
  fail "BQ dataset ${GCP_PROJECT_ID}:${BQ_DATASET_ID} に stdout_*/stderr_* テーブルが存在しない
    対処: M4-A Phase 3 sink が動いていない可能性 — terraform/m4-a-observability/ を apply 済か確認、
          sink 初動から最初の log 流入まで数分かかる場合あり"
fi

FORMATTED_TRACE="projects/${GCP_PROJECT_ID}/traces/${TRACE_ID}"
BQ_TOTAL=0
bq_found=0
for i in $(seq 1 30); do
  BQ_TOTAL=0
  for T in $TABLES; do
    COUNT="$(bq query --project_id="$GCP_PROJECT_ID" --use_legacy_sql=false --format=csv --quiet \
      "SELECT COUNT(*) FROM \`${GCP_PROJECT_ID}.${BQ_DATASET_ID}.${T}\` \
       WHERE JSON_VALUE(jsonPayload, '\$[\"logging.googleapis.com/trace\"]') = '${FORMATTED_TRACE}'" \
      2>"$STDERR_DIR/bq-poll-${i}-${T}.stderr" | tail -n1 || echo 0)"
    if [[ "$COUNT" =~ ^[0-9]+$ ]]; then
      BQ_TOTAL=$(( BQ_TOTAL + COUNT ))
    fi
  done
  if [ "$BQ_TOTAL" -ge 1 ]; then
    bq_found=1
    info "  [attempt ${i}/30] BQ row materialized (count=${BQ_TOTAL}) after ~$(( (i-1) * 10 ))s"
    break
  fi
  info "  [attempt ${i}/30] not yet (count=0); sleep 10s"
  sleep 10
done

if [ "$bq_found" -ne 1 ]; then
  LAST_HARNESS_STDERR="$STDERR_DIR/bq-poll-30-$(printf '%s' "$TABLES" | head -n1).stderr"
  fail "BQ に trace_id=$TRACE_ID が 5 min 以内に到達しなかった
    対処: (1) sink writer_identity に roles/bigquery.dataEditor 付与済か /
          (2) terraform/m4-a-observability/main.tf の filter が k8s_container かつ namespace=biblio-claw か /
          (3) host が biblio-claw namespace の Pod として動いているか (= sink filter にマッチするか)"
fi

# =============================================================================
# Section 6: summary SQL 実行 → hit_count >= 1 + marker = 'M4A_OK'
# =============================================================================
info '=== [6/7] summary SQL 実行 ==='

SUMMARY_SQL_FILE='terraform/m4-a-observability/sql/summary.sql'
[ -f "$SUMMARY_SQL_FILE" ] || fail "summary SQL ファイル不在: $SUMMARY_SQL_FILE"

SUMMARY="$(sed -e "s/<PROJECT_ID>/${GCP_PROJECT_ID}/g" -e "s/<DATASET_ID>/${BQ_DATASET_ID}/g" \
  "$SUMMARY_SQL_FILE" | \
  bq query --project_id="$GCP_PROJECT_ID" --use_legacy_sql=false --format=json --quiet \
  2>"$STDERR_DIR/bq-summary.stderr")" \
  || { LAST_HARNESS_STDERR="$STDERR_DIR/bq-summary.stderr"; fail "summary SQL 実行失敗"; }

HIT_COUNT="$(printf '%s' "$SUMMARY" | jq -r '.[0].hit_count // "0"')"
MARKER="$(printf '%s' "$SUMMARY" | jq -r '.[0].marker // ""')"
BIBLIO_EVENT_COUNT="$(printf '%s' "$SUMMARY" | jq -r '.[0].biblio_event_count // "0"')"

if ! [[ "$HIT_COUNT" =~ ^[0-9]+$ ]] || [ "$HIT_COUNT" -lt 1 ]; then
  fail "summary hit_count >= 1 期待、実際 '$HIT_COUNT' (SUMMARY=$SUMMARY)"
fi
[ "$MARKER" = 'M4A_OK' ] || fail "summary marker = 'M4A_OK' 期待、実際 '$MARKER'"

info "  → hit_count=$HIT_COUNT biblio_event_count=$BIBLIO_EVENT_COUNT marker=$MARKER"

# =============================================================================
# Section 7: ネガティブ対照 (random trace_id で BQ 0 行 + sink filter 静的反証)
# =============================================================================
info '=== [7/7] ネガティブ対照 ==='

GHOST_TRACE_ID="$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")"
GHOST_FORMATTED="projects/${GCP_PROJECT_ID}/traces/${GHOST_TRACE_ID}"
GHOST_TOTAL=0
for T in $TABLES; do
  GC="$(bq query --project_id="$GCP_PROJECT_ID" --use_legacy_sql=false --format=csv --quiet \
    "SELECT COUNT(*) FROM \`${GCP_PROJECT_ID}.${BQ_DATASET_ID}.${T}\` \
     WHERE JSON_VALUE(jsonPayload, '\$[\"logging.googleapis.com/trace\"]') = '${GHOST_FORMATTED}'" \
    2>/dev/null | tail -n1 || echo 0)"
  if [[ "$GC" =~ ^[0-9]+$ ]]; then
    GHOST_TOTAL=$(( GHOST_TOTAL + GC ))
  fi
done
[ "$GHOST_TOTAL" -eq 0 ] \
  || fail "ネガティブ対照: 存在しない trace_id=$GHOST_TRACE_ID で BQ に $GHOST_TOTAL 行 hit (期待: 0、衝突確率 ~2^-128)"

info "  → GHOST_TRACE_ID で BQ 0 行 OK (random trace_id=$GHOST_TRACE_ID)"

# 静的反証: sink filter に k8s_container / namespace 縛りが残っていること。
grep -q 'resource.type=.*k8s_container' terraform/m4-a-observability/main.tf \
  || fail "sink filter から k8s_container 縛りが消失 (terraform/m4-a-observability/main.tf)"
grep -q 'namespace_name=' terraform/m4-a-observability/main.tf \
  || fail "sink filter から namespace 縛りが消失 (terraform/m4-a-observability/main.tf)"

info '  → sink filter 静的反証 OK (k8s_container + namespace 縛り保持)'

# =============================================================================
# PASS marker
# =============================================================================
info '  all assertions passed (preflight + keyless + trace + bq + summary + negative)'
echo 'M4-A PASS'
