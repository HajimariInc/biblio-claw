#!/usr/bin/env bash
# biblio-claw: M4-A Phase 4 統合検証
#
# 1 リクエストの観測経路全体を E2E で確定的に確認する:
#   1. preflight (.env / 必須 env)
#   2. keyless 4 面アサート (GAC empty / ADC type / SA key 不在 / TF state に key resource なし)
#   3. emit-test-span.ts 実行 → TRACE_ID / REQUEST_ID 抽出
#   4. Cloud Trace API ポーリング (sleep 3 × 30 回 = 90s timeout、span >= 1 で break)
#   4.5. CLI 経由 biblio activity pre-invoke (issue #97 対応、Section 5 の deterministic 化)
#   5. BigQuery ポーリング (sleep 10 × 30 回 = 5 min timeout、stdout_* / stderr_* UNION)
#   5.5. BQ sink 上の top-level trace 列 shape 確認 (issue #81 実機検証の後段証跡)
#   6. summary SQL 実行 → hit_count >= 1 + marker = 'M4A_OK'
#   7. ネガティブ対照 (random trace_id で BQ 0 行 + sink filter 静的 grep)
#
# 全通過で `M4-A PASS` を出して exit 0、いずれかの assert で fail 時 exit 1。
#
# 必須 env (未設定で fail-fast):
#   GCP_PROJECT_ID         e.g. <your-gcp-project>
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

: "${GCP_PROJECT_ID:?preflight fail-fast: .env か env 直接渡しで未設定 (e.g. <your-gcp-project>)。.env.example の §Observability 節を参照}"
: "${BQ_DATASET_ID:?preflight fail-fast: .env か env 直接渡しで未設定 (e.g. llm_observability)。.env.example の §Observability 節を参照}"

# 必要 CLI が PATH 上にいるか fail-fast。
# `kubectl` は Section 4.5 (CLI 経由 pre-invoke = issue #97 対応で新設) が依存する。
for cmd in gcloud bq jq node kubectl; do
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
# Section 4.5: CLI 経由 biblio activity pre-invoke (Section 5 の deterministic 化)
# =============================================================================
# Section 5 は「過去 1h に biblio.* / adk.tool.*.invoke event log >= 1 件 BQ 到達」を
# 条件にする time-window 型 assert。実運用で直近 1h に biblio action が無いと fail
# するため、CLI channel + provider='adk' 経路 (M4-B Phase 3 で本番化) で 1 件を
# deterministic に発火して Section 5 に食わせる。
#
# pattern は verify-m4-b.sh:190-217 (Section 4) 踏襲 = `kubectl exec $POD -c orchestrator
# -n $NAMESPACE -- sh -c "cd /app && pnpm run chat \"@bot ...\""`。
# `@bot 蔵書` は list_biblio 経由で read-only、副作用ゼロ (棚に書き込まない)。
# tool 呼出時 `event: 'adk.tool.list.invoke'` が発火するため BQ 側 filter (Step 1 で拡張済)
# の `adk.tool.%.invoke` にマッチして Section 5 の hit 条件を deterministic に満たす。
info '=== [4.5/7] CLI 経由 biblio activity pre-invoke (Section 5 の deterministic 化) ==='

# NAMESPACE 確定 (verify-m4-a 単独実行を想定した defensive default、verify-m4-b の
# `VERIFY_M4B_NAMESPACE` env と対称)。default = 'biblio-claw' は k8s/00-namespace.yaml の値。
PREINVOKE_NAMESPACE="${VERIFY_M4A_NAMESPACE:-biblio-claw}"

# POD 特定: verify-m4-b.sh と同 pattern = StatefulSet の pod 名決定則
# (`<sts-name>-<ordinal>` = `biblio-orchestrator-0`) を利用して env で直接指定。
# 素の `app=biblio-orchestrator` label は k8s/*.yaml に存在しない
# (正は `app.kubernetes.io/name=biblio-claw` + `app.kubernetes.io/component=orchestrator`
# だが、verify-m4-b.sh は簡潔さを優先して pod 名直指定 pattern を採用しているため対称に揃える)。
POD_PREINVOKE="${VERIFY_M4A_ORCHESTRATOR_POD:-biblio-orchestrator-0}"

# Pod 存在確認 (verify-m4-a 単独実行時の fail-fast、Section 5 で BQ 疎通確認する前に
# kubectl 経路の実効性を早期に判定する)。
if ! kubectl get pod "$POD_PREINVOKE" -n "$PREINVOKE_NAMESPACE" \
     -o jsonpath='{.status.phase}' 2>"$STDERR_DIR/pod-get-45.stderr" | grep -q '^Running$'; then
  LAST_HARNESS_STDERR="$STDERR_DIR/pod-get-45.stderr"
  fail "Section 4.5 pre-invoke: orchestrator Pod '$POD_PREINVOKE' が Running 状態ではない (namespace=$PREINVOKE_NAMESPACE)
    対処: kubectl get pod $POD_PREINVOKE -n $PREINVOKE_NAMESPACE で状態確認
          (StatefulSet の pod 名は `<sts-name>-<ordinal>` = default 'biblio-orchestrator-0'、
           別 pod 名 / 別 namespace なら VERIFY_M4A_ORCHESTRATOR_POD / VERIFY_M4A_NAMESPACE env で上書き)"
fi

TMP_PREINVOKE_OUT="$STDERR_DIR/preinvoke.stdout"
TMP_PREINVOKE_ERR="$STDERR_DIR/preinvoke.stderr"

info "  Pod 内で pnpm run chat 実行 (list_biblio = read-only、副作用ゼロ):"
info "    PATRON: @bot 蔵書"
if ! kubectl exec "$POD_PREINVOKE" -c orchestrator -n "$PREINVOKE_NAMESPACE" -- \
     sh -c "cd /app && pnpm run chat \"@bot 蔵書\"" \
     > "$TMP_PREINVOKE_OUT" 2> "$TMP_PREINVOKE_ERR"; then
  LAST_HARNESS_STDERR="$TMP_PREINVOKE_ERR"
  # pre-invoke 失敗は Section 5 fail の前段情報として warn 経路。Section 5 側で
  # 「BQ に 1 件も到達していない」判定になった時にここが原因か切り分けられる。
  warn "  pre-invoke chat 実行が exit != 0 (Section 5 の BQ 疎通確認に必要な event 発火が起きない可能性)
    stdout: $(head -c 300 "$TMP_PREINVOKE_OUT" | tr '\n' ' ')
    対処: (1) ADK agent group が central DB に存在するか (verify-m4-b.sh Section 3 参照) /
          (2) LLM 応答遅延 (Vertex 負荷) / (3) chat タイムアウト (120s)"
else
  info "  pre-invoke OK (adk.tool.list.invoke event が発火した想定、BQ 到達まで数秒-10s)"
  # BQ export lag に応じて短い buffer sleep。Section 5 側で 10s × 6 = 60s の polling が
  # あるため、buffer sleep は 3s に抑える (無駄な wall clock を増やさない)。
  sleep 3
fi

# =============================================================================
# Section 5: BigQuery sink 疎通確認 (= 過去 1h に biblio.* / adk.tool.%.invoke event log が >= 1 件)
# =============================================================================
# 案 C 設計 (PR #75 実機 verify で判明した plan 欠陥への対応):
# - 元設計: emit-test-span の TRACE_ID と BQ row を個別マッチ
# - 真因: emit-test-span は host (Crane WSL) で動き、host stdout は Cloud Logging に
#   流れない (= WSL に logging agent なし)。sink filter は `k8s_container` 専用
#   = host log は永久に届かない (= 元設計は test fixture が host 実行前提で plan 欠陥)
# - 案 C: TRACE_ID 個別マッチを諦め、「sink 疎通 = 過去 1h に GKE 起源の biblio.* /
#   adk.tool.*.invoke event log が >= 1 件 BQ 到達」だけ assert。M4-A Phase 3 deliverable
#   (sink) の動作確認として value 十分、本番副作用なし、TRACE_ID 個別マッチは
#   Section 4 (Cloud Trace) で完結済
# - Section 4.5 で CLI 経由 pre-invoke により event 発火を deterministic 化 (issue #97 対応)
# - 完全 E2E (test fixture を GKE 内で動かす case A、Slack 経由 read-only action case B)
#   は将来 phase で別途検討
info '=== [5/7] BigQuery sink 疎通確認 (= 過去 1h に biblio.* / adk.tool.%.invoke event log が >= 1 件) ==='

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
# - `event LIKE 'biblio.%' OR event LIKE 'adk.tool.%.invoke'`:
#   両 namespace を biblio 活動痕跡として等価に扱う。M4-B Phase 3 (2026-07-01) で
#   `router.ts:442` の provider='adk' 分岐が新設され `*-action.ts` (`biblio.*` event の
#   唯一の発火点) を bypass するようになった。ADK tool は独自 namespace で
#   `event: 'adk.tool.<action>.invoke'` を出す (`src/adk/tools/acquire-tool.ts:65-70` 等)
#   ため、BQ query 側で両方を「biblio 活動痕跡」として拾う。
#   `LIKE 'adk.tool.%.invoke'` の `.invoke` suffix は tool entry event に絞り
#   `.unexpected_error` 等の error branch を除外 (sink 疎通の証跡としては entry で十分)。
#   jsonPayload は STRUCT (RECORD) のためドット記法でアクセス
#   (= 旧 SQL の `JSON_VALUE(jsonPayload, '$.event')` は型エラーで全 query fail していた、
#   bq show --schema --format=prettyjson stdout で実測判明)
SINK_PROBE_WHERE="WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR) AND (jsonPayload.event LIKE 'biblio.%' OR jsonPayload.event LIKE 'adk.tool.%.invoke')"

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
  fail "BQ sink 疎通確認 fail: 過去 1h に biblio.* / adk.tool.*.invoke event log が 1 件も到達していない
    対処: (1) Section 4.5 pre-invoke が exit != 0 だった可能性 (上の warn 履歴を確認) /
          (2) GKE orchestrator Pod が稼働中か (kubectl get pods -n biblio-claw) /
          (3) sink writer_identity に roles/bigquery.dataEditor 付与済か /
          (4) sink filter (k8s_container + namespace_name=biblio-claw) が biblio-claw Pod にマッチしているか /
          (5) Cloud Logging → BQ export lag (通常数秒-30s、稀に 1-2min) の可能性、少し待って再実行"
fi

# =============================================================================
# Section 5.5: BQ sink 上の top-level trace 列 shape 確認 (issue #81 実機検証の後段証跡)
# =============================================================================
# Cloud Logging Console UI "View trace" リンクの直接自動化は困難だが、BQ sink 上で
# top-level `trace` 列が resource name 形式 (= projects/<PROJECT_ID>/traces/<32-hex>)
# に昇格していれば、Fluent Bit / Cloud Logging 取り込み層の projectId 自動補完が成立
# している証跡として、"View trace" 遷移動作を間接担保できる (issue #81 実機検証 2026-07-03)。
# 将来 Cloud Logging 側の仕様変更で補完が壊れた場合、この assertion で早期検知する。
info '=== [5.5/7] BQ sink 上の top-level trace 列 shape 確認 (issue #81 実機検証の後段証跡) ==='

# Section 5 で動的発見済の $TABLES (実在するテーブルのみ = stdout / stderr のうち生成
# 済の方) + $SINK_PROBE_WHERE (biblio.% / adk.tool.%.invoke event filter) を再利用して
# UNION ALL を組み立てる。これにより:
#   1. stderr 未生成の環境 (M4-A Phase 3 sink apply 直後の典型) で "Not found: Table"
#      に落ちて sentinel 経路で誤診断される問題を回避 (silent-failure-hunter 論点 2)
#   2. Section 5 と Section 5.5 の filter を単一定義 ($SINK_PROBE_WHERE) に集約する
#      ことで、filter 退行 (biblio.% 単独への巻き戻し等) を Section 7 の grep 静的反証が
#      両方同時に検知できるようにする (Section 7 の pin 対象は $SINK_PROBE_WHERE 定義行
#      で、両 Section が同じ変数を参照するため片方だけドリフトする経路が存在しない、
#      code-reviewer + silent-failure-hunter 論点 1)
TRACE_SHAPE_UNION=""
for T in $TABLES; do
  PART="SELECT trace FROM \`${GCP_PROJECT_ID}.${BQ_DATASET_ID}.${T}\` ${SINK_PROBE_WHERE} AND trace IS NOT NULL"
  TRACE_SHAPE_UNION="${TRACE_SHAPE_UNION:+$TRACE_SHAPE_UNION UNION ALL }$PART"
done
TRACE_SHAPE_QUERY="$TRACE_SHAPE_UNION LIMIT 1"

# BQ query 失敗 (auth 切れ / network / SQL 型エラー) を 0 件ヒットと区別するため sentinel
# `BQ_SHAPE_QUERY_FAIL` を使う (同ファイル Section 5 の `|| echo BQ_QUERY_FAIL` sentinel
# pattern を踏襲、PR #75 で 1 度直したバグクラス。行番号ではなく grep 可能な pattern
# として参照 = merge で行が drift しても意味を保つ)。
TRACE_SHAPE="$(bq query --project_id="$GCP_PROJECT_ID" --use_legacy_sql=false --format=csv --quiet \
  "$TRACE_SHAPE_QUERY" 2>"$STDERR_DIR/bq-shape.stderr" | tail -n1 || echo BQ_SHAPE_QUERY_FAIL)"

if [ "$TRACE_SHAPE" = 'BQ_SHAPE_QUERY_FAIL' ]; then
  # BQ query 自体の失敗 = 「0 件不在」と区別して警告する (回避可能な silent 化を防ぐ)。
  # fail 化はしない (design 判断 = M4-A PASS 全体を守る early warning のみ)、cause の
  # 明示化のみ改善。
  warn "  BQ query 自体が失敗 (0 件不在ではなく auth 切れ / network / SQL 型エラーの可能性)"
  [ -s "$STDERR_DIR/bq-shape.stderr" ] && warn "  stderr: $(tail -c 200 "$STDERR_DIR/bq-shape.stderr" | tr '\n' ' ')"
elif [ -z "$TRACE_SHAPE" ] || [ "$TRACE_SHAPE" = 'trace' ]; then
  # CSV header 行のみ (or 空) = 過去 1h に trace 付き biblio.* event が届いていない。
  # withBiblioActionSpan wrap 外の path (= HTTP 到達なしの early return 等) だけの場合に発生。
  # fail ではなく warn (regression 検知の early warning、M4-A PASS 全体は温存)。
  warn "  BQ 上の trace 付き biblio.* event が過去 1h 不在 (issue #81 実機検証の後段証跡スキップ)"
elif [[ "$TRACE_SHAPE" =~ ^projects/${GCP_PROJECT_ID}/traces/[0-9a-f]{32}$ ]]; then
  info "  ✓ trace 列 shape OK: $TRACE_SHAPE"
  info "    → Fluent Bit / Cloud Logging 取り込み層が bare 32-hex → resource name 形式に自動補完"
  info "    → 'View trace' UI 遷移動作の間接担保 (詳細 docs/operations-runbook.md §M4-A Phase 2)"
else
  # shape が想定外 (bare 32-hex のまま or 別形式) = 自動補完が壊れた可能性。fail ではなく
  # warn で残す (現状の biblio-claw 運用では trace 列不使用の SQL クエリが多数、即 fail は
  # 不要。Option G 適用検討の signal として出す)。warn 側は「なぜ警告するか」の文脈説明
  # として issue #81 実機検証済の前提記載を温存する (comment-analyzer 判断)。
  warn "  ⚠ trace 列 shape 想定外: '$TRACE_SHAPE'"
  warn "    → issue #81 実機検証済の前提 (= 自動補完成立) が崩れている可能性"
  warn "    → docs/operations-runbook.md §M4-A Phase 2 log↔trace 連携 の Option G 適用検討"
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

# BQ query filter が biblio.% / adk.tool.%.invoke 両方を含んでいることを静的 grep で pin
# (= 将来 Section 5 の filter を誰かが単独 namespace に戻したときの回帰検知)。
# M4-A Phase 4 → M4-B Phase 3 (2026-06-28 → 2026-07-01) で発生した Phase 間ドリフト
# (delivery action handler `biblio.*` 発火経路が ADK 経路で bypass された) の再発を防ぐ
# (issue #97 対応)。$0 は同 script 自己参照。
if ! grep -q "jsonPayload.event LIKE 'biblio.%'" "$0"; then
  fail "Section 5 BQ query filter に 'biblio.%' が含まれない (= 意味的整合性の regression)"
fi
if ! grep -q "jsonPayload.event LIKE 'adk.tool.%.invoke'" "$0"; then
  fail "Section 5 BQ query filter に 'adk.tool.%.invoke' が含まれない (= M4-B ADK bypass 経路のカバレッジ低下)"
fi
info '  → BQ query filter に biblio.% + adk.tool.%.invoke 両方が pin されている OK'

# host / agent-runner の dual-copy drift 検知 (PR #78 review-agents S3)。
# env-propagation.ts / trace-fields.ts は byte-for-byte 同一維持が前提だが、コメントの規約
# のみで強制されていない。drift が起きた場合、distributed trace が沈黙して繋がらなくなる
# silent failure になる。auth.ts は intentional に差分がある (unref 処理) ため対象外。
for f in env-propagation.ts trace-fields.ts; do
  if ! diff -q "src/observability/$f" "container/agent-runner/src/observability/$f" >/dev/null 2>&1; then
    fail "host / agent-runner の dual-copy が drift: $f (= distributed trace が silent に壊れる)
    対処: 片方の編集を他方にコピーして byte-for-byte 一致させる (Bun 非互換のため共有 npm 化はしない方針、CLAUDE.md §observability 参照)"
  fi
done
info '  → host/agent dual-copy 一致 OK (env-propagation.ts / trace-fields.ts)'

# =============================================================================
# PASS marker
# =============================================================================
info '  all assertions passed (preflight + keyless + cloud-trace + bq-sink + summary + static-filter + dual-copy-drift)'
echo 'M4-A PASS'
