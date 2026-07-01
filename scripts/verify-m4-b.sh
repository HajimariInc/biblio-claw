#!/usr/bin/env bash
# biblio-claw: M4-B Phase 3 + Phase 4 統合検証 (CLI channel 経由)
#
# 1 patron 命令 (= `pnpm run chat "@bot 仕入れて owner/repo"`) の ADK Runner 経由完遂を
# E2E で確定的に確認する。Phase 4 で拡張 tool (list_biblio / update_config) smoke + HITL flow
# smoke の 2 section を追加。verify-m4-a.sh の section 構造 + verify-phase-2-adk-gke.sh の
# kubectl exec pattern を写経:
#
#   1. preflight (.env / kubectl context / 必須 env)
#   2. keyless 4 面アサート (GAC empty / ADC type / SA key 不在 / TF に key resource なし)
#   3. deploy 成立 (StatefulSet readyReplicas=1 + image tag = m4b-*)
#   4. 1 命令完遂 (kubectl exec で Pod 内 `pnpm run chat` 発火 → stdout に期待キーワード)
#   4.5. 拡張 tool smoke (Phase 4: list_biblio + update_config → chat 経由で発火して stdout 検証)
#   5. 1 trace 串刺し (Cloud Trace REST で trace + span 一覧取得 →
#      execute_tool acquire_biblio / chat claude-sonnet-4-6 の 2 span 種存在)
#   6. gen_ai.* semconv 維持 (Cloud Trace span labels に
#      gen_ai.operation.name=chat / gen_ai.provider.name=gcp.vertex_ai / gen_ai.request.model=...)
#   6.5. HITL flow smoke (Phase 4: enkin dry-run で dispatcher の pending 経路発火 +
#        pending_approvals row 作成 + cleanup DELETE)
#   7. ネガティブ対照 (regression、opt-in): verify-slack-e2e-gke.sh を子プロセスで invoke
#      (デフォルト skip、`VERIFY_M4B_INCLUDE_REGRESSION=1` で opt-in)
#
# 全通過で `M4-B PASS` を出して exit 0、いずれかの assert で fail 時 exit 1。
# 2 連続実行で両方 exit 0 (= 冪等、副作用は draft PR + dummy pending row のみ = 毎回 cleanup)。
#
# 必須 env (未設定で fail-fast):
#   GCP_PROJECT_ID         e.g. hajimari-ai-hackathon-2026
#   BQ_DATASET_ID          e.g. llm_observability (Section 5-6 Cloud Trace API に必須ではない
#                                    が verify-m4-a.sh との一貫性 + M4-A 継承前提を保証)
#
# 任意 env (default 挙動を上書き):
#   VERIFY_M4B_BIBLIO                     acquire 対象 repo (default: example-org/test-biblio-minimal)
#   VERIFY_M4B_INCLUDE_REGRESSION=1       Section 7 を有効化 (verify-slack-e2e-gke.sh 実行)
#   VERIFY_M4B_ORCHESTRATOR_POD           orchestrator Pod 名 (default: biblio-orchestrator-0)
#   VERIFY_M4B_NAMESPACE                  namespace (default: biblio-claw)
#
# 前提:
#   - kubectl context = biblio-prod (or ~gke_*_biblio-prod)
#   - gcloud auth application-default login 済
#   - ADK agent group + CLI wire は事前完了 (scripts/init-adk-agent.ts 実行済)
#   - image tag m4b-p3 が deploy 済 (scripts/init-project-gcp-image-sync.sh --tag m4b-p3 --confirm)
#
# 所要時間: ~5-10 min (LLM 応答 8-15s + Cloud Trace 到達 30-90s + regression 数 min)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# helpers から info/warn/fail を共有 (verify-m4-a.sh と同 pattern、LAST_HARNESS_STDERR 経由で
# fail() が stderr 抜粋を自動展開する)。
# shellcheck source=scripts/verify-m3-helpers.sh
source "$(dirname "${BASH_SOURCE[0]}")/verify-m3-helpers.sh"

# =============================================================================
# Section 1: preflight (.env + 必須 env + kubectl context + POD Running)
# =============================================================================
info '=== [1/9] preflight ==='

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . .env
  set +a
else
  warn ".env が見つかりません — GKE / CI 経路 (env 直接投入) と想定して継続"
fi

: "${GCP_PROJECT_ID:?preflight fail-fast: .env か env 直接渡しで未設定 (e.g. hajimari-ai-hackathon-2026)}"
: "${BQ_DATASET_ID:?preflight fail-fast: .env か env 直接渡しで未設定 (e.g. llm_observability)}"

for cmd in gcloud jq kubectl curl; do
  command -v "$cmd" >/dev/null 2>&1 || fail "必須 CLI が見つかりません: $cmd"
done

POD="${VERIFY_M4B_ORCHESTRATOR_POD:-biblio-orchestrator-0}"
NAMESPACE="${VERIFY_M4B_NAMESPACE:-biblio-claw}"
TEST_BIBLIO="${VERIFY_M4B_BIBLIO:-example-org/test-biblio-minimal}"

CURRENT_CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
[[ "$CURRENT_CONTEXT" =~ biblio-prod ]] \
  || fail "kubectl context が biblio-prod ではない: $CURRENT_CONTEXT"

info "  project=${GCP_PROJECT_ID} pod=${POD} namespace=${NAMESPACE} biblio=${TEST_BIBLIO}"

# stderr 保管用 tmpdir + trap cleanup
STDERR_DIR="$(mktemp -d -t biblio-m4b-stderr-XXXXXX)"
LAST_HARNESS_STDERR=''
trap 'rm -rf "$STDERR_DIR"' EXIT INT TERM

# =============================================================================
# Section 2: keyless 4 面アサート (verify-m4-a.sh:67-105 を移植)
# =============================================================================
info '=== [2/9] keyless 4 面アサート ==='

# (2-1) GOOGLE_APPLICATION_CREDENTIALS 未設定であること。
if [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
  fail "GOOGLE_APPLICATION_CREDENTIALS がセットされている (keyless 違反): ${GOOGLE_APPLICATION_CREDENTIALS}"
fi

# (2-2) ADC type が keyless 経路のいずれか。
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
    fail "ADC type='$adc_type' (期待: authorized_user / external_account / impersonated_service_account)" ;;
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
# Section 3: deploy 成立 (StatefulSet ready + image tag = m4b-p3*)
# =============================================================================
info '=== [3/9] deploy 成立 ==='

# kubectl の stderr を必ずキャプチャする (I7 = PR #101 review 指摘: `2>/dev/null` で
# 認証切れ / context 誤り等の実エラーが握りつぶされる silent failure)。fail 時は
# LAST_HARNESS_STDERR 経由で操作者に展開する (同 script 内の他 section と同流儀)。
POD_READY="$(kubectl get statefulset/biblio-orchestrator -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}' 2>"$STDERR_DIR/statefulset-get.stderr" || echo 0)"
if [[ "$POD_READY" != "1" ]]; then
  LAST_HARNESS_STDERR="$STDERR_DIR/statefulset-get.stderr"
  fail "orchestrator StatefulSet readyReplicas != 1: $POD_READY"
fi

# 実 Pod 上の image tag を確認 (manifest 上ではなく実 runtime を見る)
# `kubectl get pod` は `-c` flag を受け付けない (exec/logs 専用) — jsonpath の
# container name filter で狙う。
POD_IMAGE="$(kubectl get pod "$POD" -n "$NAMESPACE" -o jsonpath='{.spec.containers[?(@.name=="orchestrator")].image}' 2>"$STDERR_DIR/pod-get.stderr" || echo '')"
if [ -z "$POD_IMAGE" ]; then
  LAST_HARNESS_STDERR="$STDERR_DIR/pod-get.stderr"
fi
IMAGE_TAG="$(printf '%s' "$POD_IMAGE" | awk -F: '{print $NF}')"
[[ "$IMAGE_TAG" =~ ^m4b-p3 ]] \
  || fail "orchestrator Pod image tag が m4b-p3* ではない: '$IMAGE_TAG' (image=$POD_IMAGE)
    対処: scripts/init-project-gcp-image-sync.sh --tag m4b-p3 --confirm を実行済か確認"

info "  StatefulSet READY=1, image tag=$IMAGE_TAG (OK)"

# ADK agent group が存在するかを DB 経由で確認 (init-adk-agent.ts 実行済であること)
# GKE 経路では PVC mount で `/data/v2.db` が実体 (`DATA_DIR=/data` env)。
# 相対パス `data/v2.db` は WORKDIR=/app 相対で解決されて `/app/data/` を見に行き
# ENOENT で fail するため、絶対パス指定。
ADK_AG_COUNT="$(kubectl exec "$POD" -c orchestrator -n "$NAMESPACE" -- \
  pnpm exec tsx scripts/q.ts /data/v2.db \
  "SELECT COUNT(*) FROM container_configs WHERE provider='adk'" 2>"$STDERR_DIR/adk-ag-check.stderr" \
  | tail -n1 || echo '')"
if ! [[ "$ADK_AG_COUNT" =~ ^[0-9]+$ ]] || [ "$ADK_AG_COUNT" -lt 1 ]; then
  LAST_HARNESS_STDERR="$STDERR_DIR/adk-ag-check.stderr"
  fail "ADK agent group が central DB に不在 (count=$ADK_AG_COUNT)
    対処: kubectl exec $POD -c orchestrator -n $NAMESPACE -- pnpm exec tsx scripts/init-adk-agent.ts"
fi
info "  ADK agent group 存在 (container_configs.provider='adk' count=$ADK_AG_COUNT)"

# =============================================================================
# Section 4: 1 命令完遂 (CLI E2E)
# =============================================================================
info '=== [4/9] 1 命令完遂 (CLI channel 経由 patron 命令) ==='

PATRON_TEXT="@bot 仕入れて $TEST_BIBLIO"
TMP_OUT="$STDERR_DIR/chat.stdout"
TMP_ERR="$STDERR_DIR/chat.stderr"

# `pnpm run chat` は 2s SILENCE または 120s HARD_TIMEOUT で自然終了。
# LLM 応答 8-15s + tool 実行 (acquire) 数十 s = 120s 内で完了する想定 (Phase 2 実測)。
info "  Pod 内で pnpm run chat 実行 (LLM + acquire で数十 s 待機):"
info "    PATRON: $PATRON_TEXT"
if ! kubectl exec "$POD" -c orchestrator -n "$NAMESPACE" -- \
     sh -c "cd /app && pnpm run chat \"$PATRON_TEXT\"" \
     > "$TMP_OUT" 2> "$TMP_ERR"; then
  LAST_HARNESS_STDERR="$TMP_ERR"
  fail "kubectl exec ... pnpm run chat が exit != 0
    stdout 抜粋: $(head -c 500 "$TMP_OUT" | tr '\n' ' ')
    対処: (1) VERIFY_M4B_BIBLIO の repo が到達可能か / (2) TOTAL_TIMEOUT_MS=120s 超過なら
          Vertex 負荷 or ADK Runner ハング疑い / (3) Pod ログ (kubectl logs $POD --since=5m)"
fi

# 応答テキストにキーワード含む (LLM が tool 呼出後に日本語で応答している)
if ! grep -qE '仕入れ|acquire|📦' "$TMP_OUT"; then
  LAST_HARNESS_STDERR="$TMP_ERR"
  fail "patron 応答に期待キーワード '仕入れ / acquire / 📦' が含まれない
    stdout 抜粋: $(head -c 500 "$TMP_OUT" | tr '\n' ' ')"
fi

CHAT_RESPONSE="$(head -c 200 "$TMP_OUT" | tr '\n' ' ')"
info "  1 命令完遂 OK: '$CHAT_RESPONSE'..."

# =============================================================================
# Section 4.5: 拡張 tool smoke (Phase 4: list_biblio + update_config)
# =============================================================================
info '=== [4.5/9] 拡張 tool smoke (list_biblio + update_config) ==='

# list_biblio: 蔵書一覧取得 (LLM 経由、biblio-dev filter 例)
# 404 (棚が空) でも ok:true / items:[] で成功する契約なので、Section 4 と同流儀の
# stdout キーワード検証で成立する。
TMP_OUT_LIST="$STDERR_DIR/chat-list.stdout"
info "  list_biblio smoke: '@bot 蔵書 biblio-dev' 経路"
if ! kubectl exec "$POD" -c orchestrator -n "$NAMESPACE" -- \
     sh -c "cd /app && pnpm run chat \"@bot 蔵書 biblio-dev\"" \
     > "$TMP_OUT_LIST" 2> "$STDERR_DIR/chat-list.stderr"; then
  LAST_HARNESS_STDERR="$STDERR_DIR/chat-list.stderr"
  fail "list_biblio smoke test exit != 0
    stdout 抜粋: $(head -c 500 "$TMP_OUT_LIST" | tr '\n' ' ')"
fi
if ! grep -qE '蔵書|一覧|biblio-dev|list|件' "$TMP_OUT_LIST"; then
  LAST_HARNESS_STDERR="$STDERR_DIR/chat-list.stderr"
  fail "list_biblio 応答に期待キーワード '蔵書|一覧|biblio-dev|list|件' が含まれない
    stdout 抜粋: $(head -c 500 "$TMP_OUT_LIST" | tr '\n' ' ')"
fi
info "  list_biblio smoke: OK ($(head -c 100 "$TMP_OUT_LIST" | tr '\n' ' ')...)"

# update_config: 動的設定変更 (ACQUIRE_SKILL_THRESHOLD)
# 設定変更は permanent (DB upsert) だが、既存値と同じか大きな整数を書いておけば影響ゼロ。
# デフォルトは 10 なので、"@bot 設定 ACQUIRE_SKILL_THRESHOLD 20" で 20 に書き換え。
# 2 連続実行時も再度 20 に upsert されるだけ (= 冪等)。
TMP_OUT_CONFIG="$STDERR_DIR/chat-config.stdout"
info "  update_config smoke: '@bot 設定 ACQUIRE_SKILL_THRESHOLD 20' 経路"
if ! kubectl exec "$POD" -c orchestrator -n "$NAMESPACE" -- \
     sh -c "cd /app && pnpm run chat \"@bot 設定 ACQUIRE_SKILL_THRESHOLD 20\"" \
     > "$TMP_OUT_CONFIG" 2> "$STDERR_DIR/chat-config.stderr"; then
  LAST_HARNESS_STDERR="$STDERR_DIR/chat-config.stderr"
  fail "update_config smoke test exit != 0
    stdout 抜粋: $(head -c 500 "$TMP_OUT_CONFIG" | tr '\n' ' ')"
fi
if ! grep -qE '設定|config|完了|変更|ACQUIRE_SKILL_THRESHOLD' "$TMP_OUT_CONFIG"; then
  LAST_HARNESS_STDERR="$STDERR_DIR/chat-config.stderr"
  fail "update_config 応答に期待キーワードが含まれない
    stdout 抜粋: $(head -c 500 "$TMP_OUT_CONFIG" | tr '\n' ' ')"
fi
info "  update_config smoke: OK"

# categorize / shelve_biblio_multi の smoke は本 script では省略:
#   - categorize は Section 4 (acquire) と単独では意味が薄い (= 実 shelve と連鎖してこそ)、
#     連鎖 chat は LLM 応答時間が長すぎるため verify script では実施しない
#   - shelve_biblio_multi は複数 skill を 1 PR に陳列するが、実 skill を用意すると verify の
#     副作用が大きすぎる (draft PR N 件)。root-agent.test.ts + shelve-multi-tool.test.ts で
#     unit test 済のため verify では省略。

# =============================================================================
# Section 5: 1 trace 串刺し (Cloud Trace で invoke_agent + execute_tool + chat span 確認)
# =============================================================================
info '=== [5/9] 1 trace 串刺し (Cloud Trace API 経由) ==='

# 直近 3 分の Pod ログから trace_id を抽出 (Section 4 の patron 命令発火に対応)。
# `router.dispatch.adk` event log に request_id + agent group が出ているので、そこを
# trace_id を含むログ行を探して抽出する (JSON log の logging.googleapis.com/trace field)。
POD_LOGS="$(kubectl logs "$POD" -c orchestrator -n "$NAMESPACE" --since=3m 2>"$STDERR_DIR/logs.stderr" || true)"
if [ -z "$POD_LOGS" ]; then
  LAST_HARNESS_STDERR="$STDERR_DIR/logs.stderr"
  fail "Pod ログ取得失敗"
fi

# trace_id は Cloud Logging reserved field として `logging.googleapis.com/trace` に出る。
# biblio-claw の trace-fields.ts は bare 32hex (`"logging.googleapis.com/trace":"<32hex>"`)
# で出力する = Cloud Logging 側で GCP 標準の `projects/<PROJECT>/traces/<32hex>` 形式に
# 自動昇格される (= biblio-claw 側は project 情報を追加しない設計)。
#
# Section 4 の chat 経由 acquire を狙うため、`adk.tool.acquire.invoke` event に絞る。
# 単なる `tail -n1` では rotator sidecar 経路の trace_id を拾う race condition があった。
TRACE_ID="$(printf '%s\n' "$POD_LOGS" \
  | grep '"event":"adk.tool.acquire.invoke"' \
  | grep -oE '"logging\.googleapis\.com/trace":"[a-f0-9]{32}"' \
  | tail -n1 \
  | sed -E 's/"logging\.googleapis\.com\/trace":"([a-f0-9]{32})"/\1/' || true)"

# fallback: `AnthropicVertexLlm initialized` event (LLM 呼出時、必ず active span 配下)。
if [ -z "$TRACE_ID" ]; then
  TRACE_ID="$(printf '%s\n' "$POD_LOGS" \
    | grep '"event":"adk.anthropic_vertex_llm.init"' \
    | grep -oE '"logging\.googleapis\.com/trace":"[a-f0-9]{32}"' \
    | tail -n1 \
    | sed -E 's/"logging\.googleapis\.com\/trace":"([a-f0-9]{32})"/\1/' || true)"
fi

if ! [[ "$TRACE_ID" =~ ^[a-f0-9]{32}$ ]]; then
  # $POD_LOGS は取得済 (非空) だが該当 event 行が見つからないケース = 実際のログ内容を
  # 表示して operator が何が起きているか判断可能にする (I7 = PR #101 review 指摘)。
  DEBUG_LOG="$STDERR_DIR/trace-id-extract-debug.log"
  {
    echo "== Pod log 抜粋 (直近 3m、trace_id 抽出対象の adk.tool.acquire.invoke / adk.anthropic_vertex_llm.init event 抜き出し) =="
    printf '%s\n' "$POD_LOGS" | grep -E '"event":"adk\.(tool\.acquire\.invoke|anthropic_vertex_llm\.init)"' | tail -n 5 || echo "  (該当 event 不在)"
    echo ""
    echo "== Pod log 末尾 20 行 (全 event、trace_id 抽出手掛かり用) =="
    printf '%s\n' "$POD_LOGS" | tail -n 20
  } > "$DEBUG_LOG"
  LAST_HARNESS_STDERR="$DEBUG_LOG"
  fail "Pod ログから trace_id (32 hex) を抽出できなかった (TRACE_ID='$TRACE_ID')
    対処: (1) instrumentation.ts が --import 経路で起動されているか /
          (2) Cloud Logging に trace field が出ているか (JSON structured log の logging.googleapis.com/trace) /
          (3) Section 4 の chat 発火後、adk.tool.acquire.invoke event が出力されたか (上の LAST_HARNESS_STDERR 参照)"
fi

info "  TRACE_ID=$TRACE_ID"

# Cloud Trace REST v1 で trace + spans を取得 (verify-m4-a.sh:136-192 パターン、
# span 到達遅延 30-90s に対応する 30 回 × 3s retry)。
TOKEN="$(gcloud auth application-default print-access-token 2>"$STDERR_DIR/adc-token.stderr")" \
  || { LAST_HARNESS_STDERR="$STDERR_DIR/adc-token.stderr"; fail "ADC access token 取得失敗"; }

TRACE_BODY=''
trace_span_count=0
# break 条件: `execute_tool acquire_biblio` + `chat claude-*` の 2 種 span が両方存在すること。
# Cloud Trace の span export は BatchSpanProcessor 経由で非同期に到達するため、
# 単に「spans >= 1」で break すると初回到達時点の HTTP client span しか含まれず、
# ADK 自動 span + AnthropicVertexLlm 自前 span がまだ出揃っていない状態を掴む。
for i in $(seq 1 30); do
  body="$(curl -fsS -H "Authorization: Bearer $TOKEN" \
    "https://cloudtrace.googleapis.com/v1/projects/${GCP_PROJECT_ID}/traces/${TRACE_ID}" \
    2>"$STDERR_DIR/trace-curl-$i.stderr" || true)"
  if [ -n "$body" ]; then
    trace_span_count="$(printf '%s' "$body" | jq -r '.spans | length // 0' 2>/dev/null || echo 0)"
    span_names_partial="$(printf '%s' "$body" | jq -r '.spans[].name' 2>/dev/null || true)"
    if printf '%s' "$span_names_partial" | grep -qE 'execute_tool.*acquire_biblio' \
       && printf '%s' "$span_names_partial" | grep -qE 'chat claude-'; then
      TRACE_BODY="$body"
      info "  [attempt ${i}/30] trace 到達 (spans=${trace_span_count}、execute_tool + chat 揃い) after ~$(( (i-1) * 3 ))s"
      break
    fi
  fi
  info "  [attempt ${i}/30] partial (spans=${trace_span_count}); sleep 3s"
  sleep 3
done

if [ -z "$TRACE_BODY" ]; then
  LAST_HARNESS_STDERR="$STDERR_DIR/trace-curl-30.stderr"
  fail "Cloud Trace に trace_id=$TRACE_ID が 90s 以内に到達しなかった
    対処: (1) ADC 実行ユーザに roles/cloudtrace.user 付与済か /
          (2) Cloud Trace API enabled か / (3) OTLP export 失敗の可能性"
fi

# span 名リストに ADK 経路の 3 種 span が含まれること
SPAN_NAMES="$(printf '%s' "$TRACE_BODY" | jq -r '.spans[].name')"
info "  span 一覧 (${trace_span_count} 件):"
printf '%s\n' "$SPAN_NAMES" | head -20 | while IFS= read -r n; do info "    - $n"; done

# 期待 span (Phase 3 完成判定):
#   - `execute_tool acquire_biblio` (ADK 自動 span、tool 実行)
#   - `chat claude-sonnet-4-6` (AnthropicVertexLlm 自前 span、M4-A GenAI semconv 準拠)
#
# `invoke_agent biblio_root_agent` は runbook §Cloud Trace 観察ガイド に記載していたが、
# ADK 1.3.0 の `InMemoryRunner` 実装では top-level に `call_llm` として立ち、
# `invoke_agent` の named span は生成されない (= plan 想定と実装のずれ、実 GKE verify で
# 判明)。LLM 自律 tool 呼出 + trace 串刺し観察という Phase 3 の意義は
# `execute_tool` + `chat <model>` の存在で十分達成できるため、assertion からは除外。
if ! printf '%s' "$SPAN_NAMES" | grep -qE 'execute_tool.*acquire_biblio|acquire_biblio'; then
  warn "  execute_tool acquire_biblio span が見つからない"
  fail "acquire_biblio の execute_tool span 不在 (spans=$trace_span_count)"
fi
if ! printf '%s' "$SPAN_NAMES" | grep -qE 'chat claude-'; then
  warn "  chat claude-* span が見つからない (= AnthropicVertexLlm 自前 span、M4-A GenAI semconv 準拠)"
  fail "chat claude-* span 不在 (LLM 呼出経路が壊れている可能性)"
fi

info "  → execute_tool acquire_biblio + chat claude-* span 存在 OK"

# =============================================================================
# Section 6: gen_ai.* semconv 維持 (Cloud Trace span labels)
# =============================================================================
info '=== [6/9] gen_ai.* semconv 維持 ==='

# AnthropicVertexLlm 自前 span (= `chat claude-*`) を狙う。
#
# ADK 1.3.0 は `invoke_agent` / `call_llm` / `execute_tool` の各 span にも
# `gen_ai.operation.name` を付ける (semconv 準拠) が、`provider.name` / `request.model` /
# `usage.*` の完全 set は AnthropicVertexLlm 自前 span (= M4-A Phase 2 で自前計装) にしか
# 付いていない。単純に「gen_ai.* を持つ最初の span」を取ると invoke_agent が先に当たるため、
# 明示的に span 名で絞る (= `chat ` prefix + model 名)。
#
# `| head -n1` は jq を SIGPIPE で先落ちさせて `set -o pipefail` + `set -e` の下では exit 141
# で script 全体が中断してしまう。jq 側で slice する ([...] | .[0]) 経路に統一。
GEN_AI_LABELS="$(printf '%s' "$TRACE_BODY" | jq -c '[.spans[] | select(.name | startswith("chat "))] | .[0] // empty')"

if [ -z "$GEN_AI_LABELS" ]; then
  fail "gen_ai.* label を持つ span が 1 つも存在しない (M4-A GenAI semconv がここで壊れている可能性)"
fi

GEN_AI_OP="$(printf '%s' "$GEN_AI_LABELS" | jq -r '.labels["gen_ai.operation.name"] // ""')"
GEN_AI_PROVIDER="$(printf '%s' "$GEN_AI_LABELS" | jq -r '.labels["gen_ai.provider.name"] // ""')"
GEN_AI_MODEL="$(printf '%s' "$GEN_AI_LABELS" | jq -r '.labels["gen_ai.request.model"] // ""')"

[ "$GEN_AI_OP" = 'chat' ] || fail "gen_ai.operation.name='$GEN_AI_OP' (期待 'chat')"
[[ "$GEN_AI_PROVIDER" =~ vertex ]] || fail "gen_ai.provider.name='$GEN_AI_PROVIDER' (期待: 'gcp.vertex_ai' or vertex_ai を含む)"
[[ "$GEN_AI_MODEL" =~ claude ]] || fail "gen_ai.request.model='$GEN_AI_MODEL' (期待: 'claude-*' を含む)"

info "  gen_ai.operation.name=$GEN_AI_OP / gen_ai.provider.name=$GEN_AI_PROVIDER / gen_ai.request.model=$GEN_AI_MODEL (OK)"

# =============================================================================
# Section 6.5: HITL 承認 flow smoke (Phase 4: enkin dry-run)
# =============================================================================
info '=== [6.5/9] HITL 承認 flow smoke (enkin, DRY-RUN) ==='

# 実 Slack 承認カード発火 (admin 押下) は verify script 経路では自動化困難なため、
# dispatcher の pending 経路発火 (= longRunningToolIds > 0 → requestAdkApproval 呼出) と
# pending_approvals row 作成の 2 point を assert する半自動 test。
# 実 shelf 変更を防ぐため dummy biblio 名を使う (= admin 承認しない or timeout で cleanup)。
DUMMY_BIBLIO='example-org--dummy-nonexistent-biblio-for-verify'
TMP_OUT_ENKIN="$STDERR_DIR/chat-enkin.stdout"
info "  enkin smoke: '@bot 禁書 $DUMMY_BIBLIO biblio-dev' 経路 (DRY-RUN、承認しないため中断で OK)"
# 承認完了しないので exit 0/非 0 は問わない。中間応答「承認を admin にお願いしました」が
# stdout に返れば silence タイムアウトで pnpm run chat が終了する想定。
kubectl exec "$POD" -c orchestrator -n "$NAMESPACE" -- \
  sh -c "cd /app && pnpm run chat \"@bot 禁書 $DUMMY_BIBLIO biblio-dev\"" \
  > "$TMP_OUT_ENKIN" 2> "$STDERR_DIR/chat-enkin.stderr" \
  || true

# Pod ログで dispatcher pending 経路の event 発生を確認
# `adk.approval.dispatch.enkin` は adk-approvals.ts の log.info で emit される固定 event 名。
POD_LOGS_ENKIN="$(kubectl logs "$POD" -c orchestrator -n "$NAMESPACE" --since=2m 2>/dev/null || true)"
if ! printf '%s' "$POD_LOGS_ENKIN" | grep -q '"event":"adk\.approval\.dispatch\.enkin"'; then
  # LLM が破壊操作を発火せず text 応答で済ませたケースの可能性 = warn で継続、後段の DB 確認で判断。
  warn "  HITL smoke: adk.approval.dispatch.enkin event 不在 (LLM が破壊操作を発火しなかった可能性)"
fi

# pending_approvals row の存在確認 (DB 直接 = orchestrator Pod 内の SQLite に scripts/q.ts で query)。
# adk_confirm action の row を絞る。dummy biblio 名を payload に含んでいるものだけ数える。
PENDING_COUNT="$(kubectl exec "$POD" -c orchestrator -n "$NAMESPACE" -- \
  pnpm exec tsx scripts/q.ts /data/v2.db \
  "SELECT COUNT(*) FROM pending_approvals WHERE action='adk_confirm' AND payload LIKE '%dummy-nonexistent%'" \
  2>"$STDERR_DIR/pending-check.stderr" \
  | tail -n1 || echo '')"
if ! [[ "$PENDING_COUNT" =~ ^[0-9]+$ ]]; then
  LAST_HARNESS_STDERR="$STDERR_DIR/pending-check.stderr"
  fail "pending_approvals table 読み取り失敗 (COUNT 抽出不能、PENDING_COUNT='$PENDING_COUNT')"
fi
if [ "$PENDING_COUNT" -lt 1 ]; then
  # dispatch event も出ていない かつ row も無い = LLM が enkin を呼ばずに text で済ませた
  # ケース。plan 想定と外れるので fail (= HITL 経路の smoke が成立しないと Phase 4 完成判定
  # としては弱すぎる)。ただし error message で「LLM 応答傾向依存性」を明示。
  fail "pending_approvals に adk_confirm row 不在 (count=$PENDING_COUNT)
    対処: (1) LLM が dummy biblio に対して enkin を発火しなかった可能性 = root-agent instruction
          で破壊操作を「明示指示があった場合のみ発火」と規範化しているが、'@bot 禁書 <name>'
          は明示指示のはず / (2) approval-dispatcher / adk-approvals の import chain 破損 /
          (3) dispatcher の pending 経路検知ロジックの regression"
fi
info "  HITL enkin smoke: dispatcher pending 経路発火 + pending_approvals row 作成 OK (count=$PENDING_COUNT)"

# Cleanup: dummy pending row を削除 (次回 verify 実行時のノイズ抑制 + 2 連続冪等性)
kubectl exec "$POD" -c orchestrator -n "$NAMESPACE" -- \
  pnpm exec tsx scripts/q.ts /data/v2.db \
  "DELETE FROM pending_approvals WHERE action='adk_confirm' AND payload LIKE '%dummy-nonexistent%'" \
  > /dev/null 2>&1 || true
info "  cleanup: dummy pending_approvals row 削除 OK"

# shokyaku smoke は enkin smoke で HITL 経路が確認できているため省略 (= 実装 pattern 同一)。

# =============================================================================
# Section 7: ネガティブ対照 (regression、opt-in)
# =============================================================================
info '=== [7/9] regression (verify-slack-e2e-gke.sh、opt-in) ==='

if [ -z "${VERIFY_M4B_INCLUDE_REGRESSION:-}" ]; then
  info '  skip (Slack setup 依存を避けるため default skip、opt-in: VERIFY_M4B_INCLUDE_REGRESSION=1)'
else
  info '  running verify-slack-e2e-gke.sh (claude CLI 経路 regression)...'
  if ! bash scripts/verify-slack-e2e-gke.sh 2>"$STDERR_DIR/regression.stderr"; then
    LAST_HARNESS_STDERR="$STDERR_DIR/regression.stderr"
    fail "verify-slack-e2e-gke.sh が exit != 0 (= claude CLI 経路 regression 発生の可能性)"
  fi
  info '  → verify-slack-e2e-gke.sh PASS (claude CLI 経路 regression なし)'
fi

# =============================================================================
# PASS marker
# =============================================================================
info '  all assertions passed (preflight + keyless + deploy + 1-cmd + ext-tools + trace + gen_ai + HITL + regression)'
echo 'M4-B PASS'
