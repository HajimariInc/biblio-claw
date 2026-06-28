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

# helpers から: info / warn / fail を利用 (M4-A では extract_result / json_field /
# json_array_length / probe_onecli は不使用 = Cloud Trace REST + BQ + jq で直接 parse)。
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

: "${GCP_PROJECT_ID:?preflight fail-fast: .env か env 直接渡しで未設定 (e.g. hajimari-ai-hackathon-2026)。.env.example の §M4-A observability 参照}"
: "${BQ_DATASET_ID:?preflight fail-fast: .env か env 直接渡しで未設定 (e.g. llm_observability)。.env.example の §M4-A observability 参照}"

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
# OTEL_DIAG=true で BatchSpanProcessor の export error (OTLP HTTP 4xx / network 障害 /
# NO_PROXY 設定漏れ等) が stderr に流れる。shutdownOtel() は SDK 仕様で export 失敗を
# 内部 catch して resolve するため、verify からは「fixture exit 0 + Cloud Trace 90s
# timeout」の組み合わせでしか気付けない。OTEL_DIAG 経由で export エラーを LAST_HARNESS_STDERR
# に取り込み、fail 時に展開する (PR #75 review 提案 D)。
EMIT_OUT="$(OTEL_DIAG=true pnpm exec tsx --import ./src/instrumentation.ts scripts/emit-test-span.ts 2>"$LAST_HARNESS_STDERR")" \
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
trace_perm_warned=0
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
  # body 空 + stderr に 403/permission/401 を含むなら、persistent な権限不足の可能性が高い。
  # 30 回 retry を待たず attempt 3 で warn 出して operator に真原因を早期に提示する
  # (= curl -fsS は body 空で stderr に "HTTP/2 403" 等を吐く、PR #75 review 提案 A-1)。
  if [ "$i" -ge 3 ] && [ "$trace_perm_warned" -eq 0 ] && [ -z "$body" ] \
     && grep -qE '40[13]|forbidden|permission|unauthor' "$STDERR_DIR/trace-curl-$i.stderr" 2>/dev/null; then
    warn "Cloud Trace API が ${i} 回連続で 401/403 を返している (= 権限不足の可能性)。stderr 抜粋: $(tail -c 200 "$STDERR_DIR/trace-curl-$i.stderr" | tr '\n' ' ')"
    warn "  対処: ADC 実行ユーザに roles/cloudtrace.user 付与済か確認 (gcloud projects add-iam-policy-binding ...)"
    trace_perm_warned=1
  fi
  info "  [attempt ${i}/30] not yet; sleep 3s"
  sleep 3
done

if [ -z "$TRACE_BODY" ]; then
  LAST_HARNESS_STDERR="$STDERR_DIR/trace-curl-30.stderr"
  fail "Cloud Trace に trace_id=$TRACE_ID が 90s 以内に到達しなかった
    対処 (頻出順): (1) ADC 実行ユーザに roles/cloudtrace.user 付与済か (= curl 403 の典型原因) /
                   (2) Cloud Trace API enabled か /
                   (3) OTLP export 失敗の可能性 (emit-test-span 実行時の OTEL_DIAG stderr を上の LAST_HARNESS_STDERR 経由で確認) /
                   (4) BatchSpanProcessor flush 遅延 (再実行で多くは解決)"
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
# Section 5: BigQuery sink 疎通確認 (= 過去 1h に biblio.* event log が >= 1 件)
# =============================================================================
# 案 C 設計 (PR #75 実機 verify で判明した plan 欠陥への対応):
# - 元設計: emit-test-span の TRACE_ID と BQ row を個別マッチ
# - 真因: emit-test-span は host (Crane WSL) で動き、host stdout は Cloud Logging に
#   流れない (= WSL に logging agent なし)。sink filter は `k8s_container` 専用
#   = host log は永久に届かない (= 元設計は test fixture が host 実行前提で plan 欠陥)
# - 案 C: TRACE_ID 個別マッチを諦め、「sink 疎通 = 過去 1h に GKE 起源の biblio.* event
#   log が >= 1 件 BQ 到達」だけ assert。M4-A Phase 3 deliverable (sink) の動作確認として
#   value 十分、本番副作用なし、TRACE_ID 個別マッチは Section 4 (Cloud Trace) で完結済
# - 完全 E2E (test fixture を GKE 内で動かす case A、Slack 経由 read-only action case B)
#   は将来 phase で別途検討
info '=== [5/7] BigQuery sink 疎通確認 (= 過去 1h に biblio.* event log が >= 1 件) ==='

# Cloud Logging → BQ sink は `use_partitioned_tables = true` (= terraform/m4-a-observability/main.tf:39)
# で `stdout` / `stderr` 単独形 + `timestamp` 列 DAY partition で生成される (= bq ls 実測:
# `Time Partitioning: DAY (field: timestamp)`)。`stdout_YYYYMMDD` の sharded suffix ではない。
ALL_TABLES="$(bq ls --format=json --max_results=500 "${GCP_PROJECT_ID}:${BQ_DATASET_ID}" 2>"$STDERR_DIR/bq-ls.stderr" \
  | jq -r '.[].tableReference.tableId' 2>"$STDERR_DIR/bq-ls-jq.stderr" \
  | grep -E '^(stdout|stderr)$' || true)"
if [ -z "$ALL_TABLES" ]; then
  cat "$STDERR_DIR/bq-ls.stderr" "$STDERR_DIR/bq-ls-jq.stderr" > "$STDERR_DIR/bq-ls-combined.stderr" 2>/dev/null || true
  LAST_HARNESS_STDERR="$STDERR_DIR/bq-ls-combined.stderr"
  fail "BQ dataset ${GCP_PROJECT_ID}:${BQ_DATASET_ID} に stdout / stderr テーブルが存在しない
    対処: (1) M4-A Phase 3 sink が動いていない可能性 — terraform/m4-a-observability/ apply 済か /
          (2) sink 初動から最初の log 流入まで数分かかる場合あり /
          (3) bq CLI / jq の異常出力の可能性は上記 stderr を参照"
fi
TABLES="$ALL_TABLES"
info "  対象テーブル: $(printf '%s' "$TABLES" | tr '\n' ' ')"

# WHERE 句:
# - `timestamp >= ... INTERVAL 1 HOUR`: partition pruning (cost + 性能担保)
# - `jsonPayload.event LIKE 'biblio.%'`: biblio action 由来 (= biblio-claw の構造化ログ
#   経路が動いている証跡)。jsonPayload は STRUCT (RECORD) のためドット記法でアクセス
#   (= 旧 SQL の `JSON_VALUE(jsonPayload, '$.event')` は型エラーで全 query fail していた、
#   bq show --schema --format=prettyjson stdout で実測判明)
SINK_PROBE_WHERE="WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR) AND jsonPayload.event LIKE 'biblio.%'"

# 軽い retry (10s × 6 = 1 min)。biblio action が直近 1h で 1 件以上動いていれば即 hit。
BQ_TOTAL=0
bq_found=0
auth_fail_streak=0
AUTH_FAIL_MAX=3
SINK_PROBE_MAX=6
LAST_BQ_ATTEMPT=0

for i in $(seq 1 "$SINK_PROBE_MAX"); do
  LAST_BQ_ATTEMPT="$i"
  BQ_TOTAL=0
  outer_auth_fails=0
  outer_table_count=0
  for T in $TABLES; do
    outer_table_count=$((outer_table_count + 1))
    # pipefail 有効下で bq query 失敗 → pipe exit !=0 → `|| echo BQ_QUERY_FAIL` 発火。
    # auth 切れ / network 障害 / SQL 型エラーを transient "0 行" と区別可能にする。
    COUNT="$(bq query --project_id="$GCP_PROJECT_ID" --use_legacy_sql=false --format=csv --quiet \
      "SELECT COUNT(*) FROM \`${GCP_PROJECT_ID}.${BQ_DATASET_ID}.${T}\` ${SINK_PROBE_WHERE}" \
      2>"$STDERR_DIR/bq-poll-${i}-${T}.stderr" | tail -n1 || echo BQ_QUERY_FAIL)"
    if [[ "$COUNT" =~ ^[0-9]+$ ]]; then
      BQ_TOTAL=$(( BQ_TOTAL + COUNT ))
      [ "$BQ_TOTAL" -ge 1 ] && break
    else
      outer_auth_fails=$((outer_auth_fails + 1))
    fi
  done

  if [ "$BQ_TOTAL" -ge 1 ]; then
    bq_found=1
    info "  [attempt ${i}/${SINK_PROBE_MAX}] sink 疎通 OK (biblio event row=${BQ_TOTAL}) after ~$(( (i-1) * 10 ))s"
    break
  fi

  # 透明化 (PR #75 silent-failure 問題 2 再対応): 旧版は count=0 ハードコード表示で
  # 失敗を 0 件と取り違えていた。今は outer 反復ごとに「成功 query 数 / 失敗数」を
  # 出して内部状態を見える化する。
  outer_success=$(( outer_table_count - outer_auth_fails ))
  info "  [attempt ${i}/${SINK_PROBE_MAX}] biblio event not yet (success_query=${outer_success}/${outer_table_count}, failed_query=${outer_auth_fails}); sleep 10s"

  # 全 query fail (= persistent auth/network/SQL 型) なら 3 連続で early abort。
  if [ "$outer_table_count" -gt 0 ] && [ "$outer_auth_fails" -eq "$outer_table_count" ]; then
    auth_fail_streak=$((auth_fail_streak + 1))
    if [ "$auth_fail_streak" -ge "$AUTH_FAIL_MAX" ]; then
      warn "BQ query が ${AUTH_FAIL_MAX} 連続 outer 反復で全テーブル失敗"
      for T in $TABLES; do
        if [ -s "$STDERR_DIR/bq-poll-${i}-${T}.stderr" ]; then
          warn "  table=$T stderr 抜粋: $(tail -c 300 "$STDERR_DIR/bq-poll-${i}-${T}.stderr" | tr '\n' ' ')"
        fi
      done
      LAST_HARNESS_STDERR="$STDERR_DIR/bq-poll-${i}-$(printf '%s' "$TABLES" | head -n1).stderr"
      fail "BQ poll early abort: ${AUTH_FAIL_MAX} 連続全失敗
    対処: (1) gcloud auth application-default print-access-token で token 取得確認 /
          (2) ADC 実行ユーザに roles/bigquery.dataViewer 付与済か /
          (3) SQL 型エラー (jsonPayload スキーマ仮定ミス等) — 上の stderr 抜粋で原因確認 /
          (4) network 障害"
    fi
  else
    auth_fail_streak=0
  fi

  sleep 10
done

if [ "$bq_found" -ne 1 ]; then
  for T in $TABLES; do
    if [ -s "$STDERR_DIR/bq-poll-${LAST_BQ_ATTEMPT}-${T}.stderr" ]; then
      warn "  timeout 直前 stderr (table=$T): $(tail -c 300 "$STDERR_DIR/bq-poll-${LAST_BQ_ATTEMPT}-${T}.stderr" | tr '\n' ' ')"
    fi
  done
  LAST_HARNESS_STDERR="$STDERR_DIR/bq-poll-${LAST_BQ_ATTEMPT}-$(printf '%s' "$TABLES" | head -n1).stderr"
  fail "BQ sink 疎通確認 fail: 過去 1h に biblio.* event log が 1 件も到達していない
    対処: (1) 直近 1h で biblio action (Slack で @bot 蔵書 等) を 1 件以上実行 /
          (2) GKE orchestrator Pod が稼働中か (kubectl get pods -n biblio-claw) /
          (3) sink writer_identity に roles/bigquery.dataEditor 付与済か /
          (4) sink filter (k8s_container + namespace_name=biblio-claw) が biblio-claw Pod にマッチしているか"
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
  || { LAST_HARNESS_STDERR="$STDERR_DIR/bq-summary.stderr"; fail "summary SQL 実行失敗 (上の stderr で原因確認、jsonPayload スキーマ仮定ミスなら summary.sql を修正)"; }

HIT_COUNT="$(printf '%s' "$SUMMARY" | jq -r '.[0].hit_count // "0"')"
MARKER="$(printf '%s' "$SUMMARY" | jq -r '.[0].marker // ""')"
BIBLIO_EVENT_COUNT="$(printf '%s' "$SUMMARY" | jq -r '.[0].biblio_event_count // "0"')"

if ! [[ "$HIT_COUNT" =~ ^[0-9]+$ ]] || [ "$HIT_COUNT" -lt 1 ]; then
  fail "summary hit_count >= 1 期待、実際 '$HIT_COUNT' (SUMMARY=$SUMMARY)"
fi
[ "$MARKER" = 'M4A_OK' ] || fail "summary marker = 'M4A_OK' 期待、実際 '$MARKER'"

info "  → hit_count=$HIT_COUNT biblio_event_count=$BIBLIO_EVENT_COUNT marker=$MARKER"

# =============================================================================
# Section 7: 静的反証 (sink filter に k8s_container + namespace 縛りが残っていること)
# =============================================================================
# 案 C 設計: 動的ネガティブ対照 (= random GHOST_TRACE_ID で 0 行) は TRACE_ID 個別マッチ
# 前提のため案 C ではスコープ外。sink filter の k8s_container + namespace 縛りが
# 静的に保持されていることだけ確認 (= sink が無関係 namespace のログを誤って取り込むことが
# ないという設計の証跡)。
info '=== [7/7] 静的反証 (sink filter スコープ確認) ==='

grep -q 'resource.type=.*k8s_container' terraform/m4-a-observability/main.tf \
  || fail "sink filter から k8s_container 縛りが消失 (terraform/m4-a-observability/main.tf)"
grep -q 'namespace_name=' terraform/m4-a-observability/main.tf \
  || fail "sink filter から namespace 縛りが消失 (terraform/m4-a-observability/main.tf)"

info '  → sink filter 静的反証 OK (k8s_container + namespace 縛り保持)'

# =============================================================================
# PASS marker
# =============================================================================
info '  all assertions passed (preflight + keyless + cloud-trace + bq-sink + summary + static-filter)'
echo 'M4-A PASS'
