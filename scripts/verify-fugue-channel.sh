#!/usr/bin/env bash
# biblio-claw: M4-E Phase 6 統合検証 (Fugue channel MVP 完成判定 5 軸 assertion)
#
# 5 軸 (疎通 / 認証 / HITL 簡略化 / channel 分離 / keyless) × 2 環境 (local / Prod GKE) を
# 1 command で pass/fail 判定する verify script。verify-m4-b.sh の 9 section 骨格 +
# verify-m4-a.sh の BQ retry 戦略 + verify-m3.sh の bash flag mode 判定を写経した合成。
#
# 使い方:
#   bash scripts/verify-fugue-channel.sh --local   Section 1 + 2-4 (local docker compose 経路)
#   bash scripts/verify-fugue-channel.sh --prod    Section 1 + 5-10 (Prod GKE 経路)
#   bash scripts/verify-fugue-channel.sh           Section 1 + 2-10 (両方、両環境揃うとき)
#
# 必須 env (Prod mode = --prod or 省略で必須、未設定で fail-fast):
#   GCP_PROJECT_ID         e.g. hajimari-ai-hackathon-2026
#   BQ_DATASET_ID          e.g. llm_observability
#
# 必須 env (Local mode = --local or 省略で必須、未設定で fail-fast):
#   FUGUE_SHARED_TOKEN    docker compose 経路の Bearer token (.env 経由 or shell env で override)
#
# 任意 env (default 挙動を上書き):
#   VERIFY_FUGUE_TEST_SKILL_ID       equip 発火対象 skill_id (default: skills-tdd-first)
#   VERIFY_FUGUE_ORCHESTRATOR_POD    orchestrator Pod 名 (default: biblio-orchestrator-0)
#   VERIFY_FUGUE_NAMESPACE           K8s namespace (default: biblio-claw)
#   VERIFY_FUGUE_INCLUDE_INTEGRATION 予約 (Phase 6 では未使用、Fugue 合同 verify opt-in 用の
#                                    将来 flag。設定しても現時点では影響なし)
#
# 前提 (--prod or both):
#   - kubectl context = biblio-prod (or ~gke_*_biblio-prod)
#   - gcloud auth application-default login 済
#   - Phase 5 実 apply 完了 (Terraform module + K8s Ingress + Cloud LB + cert Active)
#   - Fugue channel adapter Prod deploy 済 (orchestrator StatefulSet が Phase 5 image tag)
#
# 前提 (--local or both):
#   - docker compose up -d --wait (biblio-onecli / biblio-postgres 起動済)
#   - host 上で pnpm run dev で orchestrator 起動済 (Fugue HTTP server が 127.0.0.1:8080 で listen)
#   - .env に FUGUE_SHARED_TOKEN が設定されている (docker compose と同じ token を host にも渡す)
#
# 全通過で `M4-E PASS (${MODE})` を出して exit 0、いずれかの assert で fail 時 exit 1。
# 2 連続実行で両方 exit 0 (= 冪等、副作用は fugue_equipped_biblios の verify 用 row のみ =
# 毎回 trap cleanup で DELETE)。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# helpers から info/warn/fail/extract_result/json_field を共有 (verify-m4-a/b と同 pattern、
# LAST_HARNESS_STDERR 経由で fail() が stderr 抜粋を自動展開する)。
# shellcheck source=scripts/verify-m3-helpers.sh
source "$(dirname "${BASH_SOURCE[0]}")/verify-m3-helpers.sh"

# =============================================================================
# 引数 parse — bash flag mode 判定 (verify-m3.sh:49-58 pattern 踏襲)
# =============================================================================
MODE='both'
case "${1:-}" in
  --local) MODE='local' ;;
  --prod)  MODE='prod'  ;;
  '')      ;;
  *)       fail "unknown arg: $1 — usage: verify-fugue-channel.sh [--local|--prod]" ;;
esac

# =============================================================================
# Section 1: Preflight (共通 = 全 mode 発火)
# =============================================================================
info "=== [1/10] preflight (mode=$MODE) ==="

# .env optional load (GKE / CI 経路は env 直接投入と想定して .env 不在は warn 継続)
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . .env
  set +a
else
  warn ".env が見つかりません — GKE / CI 経路 (env 直接投入) と想定して継続"
fi

# 必須 CLI (mode によって用途が変わるが、preflight で全部揃っていることを確認)
# - openssl: Section 7 の traceparent 生成 (32hex + 16hex)
# - curl: Section 5 の Prod HTTPS 疎通 + Cloud Trace API
# - node: json_field / json_array_length helpers
# - bq / gcloud / kubectl: Prod mode の全 section で必須
# - jq: Prod mode の Cloud Trace / IAM policy parse
for cmd in node jq openssl curl; do
  command -v "$cmd" >/dev/null 2>&1 || fail "必須 CLI が見つかりません: $cmd"
done
if [ "$MODE" != 'local' ]; then
  for cmd in gcloud bq kubectl; do
    command -v "$cmd" >/dev/null 2>&1 || fail "Prod mode 用の必須 CLI が見つかりません: $cmd"
  done
fi

# stderr 保管用 tmpdir + trap cleanup 初期化
STDERR_DIR="$(mktemp -d -t biblio-m4e-stderr-XXXXXX)"
LAST_HARNESS_STDERR=''
CLEANUP_SKILL_ID=''
# 実際に SQLite 書換えを試みたかどうか (local + Prod どちらでも trap 側で削除経路を切替)
CLEANUP_LOCAL_DIRTY=0
CLEANUP_PROD_DIRTY=0

cleanup() {
  local exit_code=$?
  # Prod side cleanup (kubectl 経路)
  if [ "$CLEANUP_PROD_DIRTY" -eq 1 ] && [ -n "$CLEANUP_SKILL_ID" ]; then
    kubectl exec "${POD:-biblio-orchestrator-0}" -c orchestrator -n "${NAMESPACE:-biblio-claw}" -- \
      pnpm exec tsx scripts/q.ts /data/v2.db \
      "DELETE FROM fugue_equipped_biblios WHERE biblio_name='${CLEANUP_SKILL_ID}'" \
      >/dev/null 2>&1 || true
  fi
  # Local side cleanup (host SQLite 経路、data/v2.db 相対)
  if [ "$CLEANUP_LOCAL_DIRTY" -eq 1 ] && [ -n "$CLEANUP_SKILL_ID" ] && [ -f data/v2.db ]; then
    pnpm exec tsx scripts/q.ts data/v2.db \
      "DELETE FROM fugue_equipped_biblios WHERE biblio_name='${CLEANUP_SKILL_ID}'" \
      >/dev/null 2>&1 || true
  fi
  rm -rf "$STDERR_DIR"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

# --- Local mode 必須 env + 必須ファイル fail-fast ---
#
# PR #132 review I5 対応: `data/v2.db` 不在は「host orchestrator 未起動」= 前提条件違反であり、
# 個別 section の warn skip 経路 (Section 3 Point 3 / Section 4 全体) で吸収すると
# 「5 軸中 1 軸 (channel 分離) を未検証で PASS を名乗る」silent 縮退が起きる。preflight で
# fail-fast することで「LOCAL 3 軸 (Section 2-4) を全部走らせる」契約を担保する。
if [ "$MODE" = 'local' ] || [ "$MODE" = 'both' ]; then
  : "${FUGUE_SHARED_TOKEN:?preflight fail-fast: local mode で FUGUE_SHARED_TOKEN 未設定 (.env or env 直接投入)}"
  info "  local: FUGUE_SHARED_TOKEN 設定済 (len=$(printf %s "$FUGUE_SHARED_TOKEN" | wc -c))"
  [ -f data/v2.db ] \
    || fail "preflight fail-fast: local mode で data/v2.db 不在 (host orchestrator 未起動)
    対処: (1) docker compose up -d --wait 実行済か / (2) host で pnpm run dev 起動済か
          (Section 3 Point 3 + Section 4 は data/v2.db 前提で走るため、不在で silent skip すると
           channel 分離軸が未検証で M4-E PASS (local) を出す silent 縮退が起きる)"
  info "  local: data/v2.db 存在確認 OK"
fi

# --- Prod mode 必須 env fail-fast + kubectl context + Secret Manager Token/Domain 取得 ---
POD="${VERIFY_FUGUE_ORCHESTRATOR_POD:-biblio-orchestrator-0}"
NAMESPACE="${VERIFY_FUGUE_NAMESPACE:-biblio-claw}"
SKILL_ID="${VERIFY_FUGUE_TEST_SKILL_ID:-skills-tdd-first}"
DOMAIN=''
PROD_TOKEN=''

if [ "$MODE" = 'prod' ] || [ "$MODE" = 'both' ]; then
  : "${GCP_PROJECT_ID:?preflight fail-fast: Prod mode で GCP_PROJECT_ID 未設定 (.env or env 直接投入)}"
  : "${BQ_DATASET_ID:?preflight fail-fast: Prod mode で BQ_DATASET_ID 未設定 (e.g. llm_observability)}"

  CURRENT_CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
  [[ "$CURRENT_CONTEXT" =~ biblio-prod ]] \
    || fail "kubectl context が biblio-prod ではない: '$CURRENT_CONTEXT'
    対処: kubectl config use-context <gke_biblio-prod cluster context> で切替"

  info "  Prod: project=$GCP_PROJECT_ID dataset=$BQ_DATASET_ID pod=$POD ns=$NAMESPACE skill=$SKILL_ID"

  # 罠 8 対処: `gcloud secrets versions access` の silent 空応答を [[ -n ]] で検知
  DOMAIN="$(gcloud secrets versions access latest --secret=fugue-domain-name \
    --project="$GCP_PROJECT_ID" 2>"$STDERR_DIR/domain-secret.stderr" || true)"
  if [ -z "$DOMAIN" ]; then
    LAST_HARNESS_STDERR="$STDERR_DIR/domain-secret.stderr"
    fail "Secret Manager から fugue-domain-name を取得できなかった (罠 8: gcloud silent 空)
    対処: gcloud secrets versions access latest --secret=fugue-domain-name --project=$GCP_PROJECT_ID を手動実行して確認"
  fi
  PROD_TOKEN="$(gcloud secrets versions access latest --secret=fugue-shared-token \
    --project="$GCP_PROJECT_ID" 2>"$STDERR_DIR/token-secret.stderr" || true)"
  if [ -z "$PROD_TOKEN" ]; then
    LAST_HARNESS_STDERR="$STDERR_DIR/token-secret.stderr"
    fail "Secret Manager から fugue-shared-token を取得できなかった (罠 8: gcloud silent 空)"
  fi
  info "  Prod: DOMAIN=$DOMAIN token_len=$(printf %s "$PROD_TOKEN" | wc -c)"

  # 罠 2 対処: K8s Secret 存在確認 + optional: false 経路の値健全性
  if ! kubectl get secret biblio-fugue-shared-token -n "$NAMESPACE" \
       >/dev/null 2>"$STDERR_DIR/secret-get.stderr"; then
    LAST_HARNESS_STDERR="$STDERR_DIR/secret-get.stderr"
    fail "罠 2: K8s Secret 'biblio-fugue-shared-token' が namespace=$NAMESPACE に不在
    対処: runbook §M4-E Phase 5 Step 3 (Secret 生成 + envFrom secretRef 経路) を確認"
  fi

  # 罠 7 対処: Secret 内の FUGUE_SHARED_TOKEN 値が 32 byte 以上か
  TOKEN_LEN="$(kubectl get secret biblio-fugue-shared-token -n "$NAMESPACE" \
    -o jsonpath='{.data.FUGUE_SHARED_TOKEN}' 2>"$STDERR_DIR/secret-len.stderr" \
    | base64 -d 2>/dev/null | wc -c || echo 0)"
  if ! [[ "$TOKEN_LEN" =~ ^[0-9]+$ ]] || [ "$TOKEN_LEN" -lt 32 ]; then
    LAST_HARNESS_STDERR="$STDERR_DIR/secret-len.stderr"
    fail "罠 7: K8s Secret 'biblio-fugue-shared-token' の FUGUE_SHARED_TOKEN 値が 32 byte 未満 (len=$TOKEN_LEN)
    対処: openssl rand -hex 32 で再生成 → Secret Manager 更新 → K8s Secret 再 apply"
  fi
  info "  罠 2/7 OK: K8s Secret 存在 + FUGUE_SHARED_TOKEN len=$TOKEN_LEN"

  # 罠 4 対処: FUGUE_HTTP_HOST=0.0.0.0 が Pod env に投入されているか
  POD_HTTP_HOST="$(kubectl exec "$POD" -c orchestrator -n "$NAMESPACE" -- \
    printenv FUGUE_HTTP_HOST 2>"$STDERR_DIR/pod-env.stderr" || echo '')"
  if [ "$POD_HTTP_HOST" != '0.0.0.0' ]; then
    LAST_HARNESS_STDERR="$STDERR_DIR/pod-env.stderr"
    fail "罠 4: Pod env FUGUE_HTTP_HOST != '0.0.0.0' (実際: '$POD_HTTP_HOST')
    対処: k8s/10-orchestrator-statefulset.yaml で FUGUE_HTTP_HOST=0.0.0.0 が明示投入されているか確認"
  fi
  info "  罠 4 OK: Pod env FUGUE_HTTP_HOST=0.0.0.0"
fi

# =============================================================================
# Section 2: LOCAL 疎通 + 認証 (--local or both)
# =============================================================================
if [ "$MODE" = 'local' ] || [ "$MODE" = 'both' ]; then
  info '=== [2/10] LOCAL 疎通 + 認証 (docker compose 経路) ==='

  # docker compose + host orchestrator 起動 probe (curl 5s timeout、失敗時は warn + skip
  # ではなく fail — local mode は明示的 opt-in なので docker compose 未起動は operator 誤指定)。
  if ! curl -sS --max-time 5 "http://127.0.0.1:8080/healthz" >/dev/null \
       2>"$STDERR_DIR/local-healthz.stderr"; then
    LAST_HARNESS_STDERR="$STDERR_DIR/local-healthz.stderr"
    fail "local Fugue HTTP server (127.0.0.1:8080/healthz) 到達失敗
    対処: (1) docker compose up -d --wait 実行済か / (2) host で pnpm run dev で orchestrator 起動済か
          (Fugue HTTP server は host process の一部として起動、docker container ではない)"
  fi
  info "  local: /healthz OK"

  # consult 疎通 (fake-fugue-client 経由、FUGUE_URL 未設定 = local 127.0.0.1:8080 経路)
  LAST_HARNESS_STDERR="$STDERR_DIR/local-consult.stderr"
  consult_result="$(pnpm exec tsx scripts/fake-fugue-client.ts consult \
    --query "typescript" --mode "ask-ad" \
    2>"$LAST_HARNESS_STDERR" | extract_result || true)"
  [ -n "$consult_result" ] || fail "local consult が RESULT を出さなかった"

  status="$(json_field "$consult_result" 'status')"
  reply_status="$(json_field "$consult_result" 'response_body.status')"
  used_token_kind="$(json_field "$consult_result" 'used_token_kind')"

  [ "$status" = '200' ] || fail "local consult status != 200 (got '$status'): $consult_result"
  [[ "$reply_status" =~ ^(ok|not_found)$ ]] \
    || fail "local consult reply status not in {ok, not_found} (got '$reply_status'): $consult_result"
  [ "$used_token_kind" = 'valid' ] \
    || fail "local consult used_token_kind != valid (got '$used_token_kind')"
  info "  local consult: status=$status reply=$reply_status token=$used_token_kind (OK)"

  # equip 疎通 (fake-fugue-client 経由、default SKILL_ID 使用)
  LAST_HARNESS_STDERR="$STDERR_DIR/local-equip.stderr"
  CLEANUP_SKILL_ID="$SKILL_ID"
  CLEANUP_LOCAL_DIRTY=1
  equip_result="$(pnpm exec tsx scripts/fake-fugue-client.ts equip \
    --skill-id "$SKILL_ID" \
    2>"$LAST_HARNESS_STDERR" | extract_result || true)"
  [ -n "$equip_result" ] || fail "local equip が RESULT を出さなかった"

  equip_status="$(json_field "$equip_result" 'status')"
  equip_reply="$(json_field "$equip_result" 'response_body.status')"
  [ "$equip_status" = '200' ] || fail "local equip status != 200 (got '$equip_status'): $equip_result"
  # 実 skill 前提 (skills-tdd-first) が棚に存在すれば {equipped, already_equipped}、
  # 棚に無ければ not_found (Section 2 では棚状態を強く前提しないので 3 状態全部 OK)。
  [[ "$equip_reply" =~ ^(equipped|already_equipped|not_found)$ ]] \
    || fail "local equip reply status not in {equipped, already_equipped, not_found} (got '$equip_reply'): $equip_result"
  info "  local equip: status=$equip_status reply=$equip_reply (OK)"

  # 認証 fail (--bad-token 経路、401 期待)
  LAST_HARNESS_STDERR="$STDERR_DIR/local-auth-fail.stderr"
  auth_fail_result="$(pnpm exec tsx scripts/fake-fugue-client.ts consult --bad-token \
    --query "test" \
    2>"$LAST_HARNESS_STDERR" | extract_result || true)"
  [ -n "$auth_fail_result" ] || fail "local auth-fail consult が RESULT を出さなかった"

  auth_fail_status="$(json_field "$auth_fail_result" 'status')"
  auth_fail_token_kind="$(json_field "$auth_fail_result" 'used_token_kind')"
  [ "$auth_fail_status" = '401' ] \
    || fail "local 認証 fail expected status=401 (got '$auth_fail_status'): $auth_fail_result"
  [ "$auth_fail_token_kind" = 'bad' ] \
    || fail "local auth-fail token_kind != bad (got '$auth_fail_token_kind')"
  info "  local auth-fail: status=401 token=bad (OK)"
fi

# =============================================================================
# Section 3: LOCAL HITL 簡略化 (3 point AND) (--local or both)
# =============================================================================
if [ "$MODE" = 'local' ] || [ "$MODE" = 'both' ]; then
  info '=== [3/10] LOCAL HITL 簡略化 (3 point AND) ==='

  # Section 2 の equip 結果を再利用 (fresh 発火は not_found 時に別 skill を指定するコストがあるので、
  # 直前 equip の reply_status = equipped/already_equipped/not_found のうち error/hitl_required が
  # 含まれていない = matrix false 経路が発火した証拠)。
  # Point 1: reply status に hitl_required が入っていない (fugue-http.ts:756-780 は現行 dead path)
  if printf '%s' "${equip_reply:-}" | grep -q 'hitl_required'; then
    fail "HITL 簡略化違反 Point 1: local equip reply に 'hitl_required' が含まれる ('$equip_reply')
    対処: src/biblio/hitl-policy.ts:65-75 の requiresApproval('equip','fugue') が true になった可能性"
  fi
  info "  Point 1 OK: local equip reply='$equip_reply' に hitl_required なし"

  # Point 2: host log ファイル (`logs/nanoclaw.log`) に `fugue.equip.hitl_required` event 不在
  # host は Node で走り stdout → logs/nanoclaw.log にリダイレクトされる想定 (README + CLAUDE.md 参照)。
  # log ファイル不在 = dev モードで stdout 直行 or launchd/systemd の journal に流れているケース =
  # log 経由の検知は skip して warn 継続 (Point 1 + 3 で AND 条件は担保できる、log 依存 point は
  # 保険的位置付け)。
  #
  # PR #132 review C1 対応: grep pattern を text/json 両対応化。
  # `src/log.ts:31,41-48` により LOG_FORMAT 未設定時は text 形式 (`event="fugue.equip.hitl_required"`
  # = `=` 区切り、colon なし) がデフォルトで、`.env.example:187` も text をローカル推奨とする。
  # 元の JSON 前提の grep pattern `'"event":"..."'` (colon 区切り) は text 形式に一切マッチせず
  # false-negative canary になっていた (matrix 逆転が起きても常に PASS)。両形式を包含する
  # extended regex に変更して text/json どちらでも検知可能に。
  if [ -f logs/nanoclaw.log ]; then
    if grep -qE '"event":"fugue\.equip\.hitl_required"|event="fugue\.equip\.hitl_required"' logs/nanoclaw.log 2>/dev/null; then
      fail "HITL 簡略化違反 Point 2: logs/nanoclaw.log に 'fugue.equip.hitl_required' event 発火痕跡あり
      対処: matrix 逆転の canary、requiresApproval matrix を確認"
    fi
    info "  Point 2 OK: logs/nanoclaw.log に fugue.equip.hitl_required event 不在 (text/json 両対応)"
  else
    warn "  Point 2 skip: logs/nanoclaw.log 不在 (dev mode で journal 経路の可能性、Point 1+3 で担保)"
  fi

  # Point 3: local SQLite の pending_approvals に該当 payload の row が 0 件
  # PR #132 review I5 対応: `data/v2.db` は Section 1 preflight で存在保証済 (前提条件)、
  # skip 経路を撤去。DB クエリ失敗は fail() で明示的に検知される。
  LAST_HARNESS_STDERR="$STDERR_DIR/local-pending.stderr"
  pending_count="$(pnpm exec tsx scripts/q.ts data/v2.db \
    "SELECT COUNT(*) FROM pending_approvals WHERE payload LIKE '%${SKILL_ID}%' AND action='adk_confirm'" \
    2>"$LAST_HARNESS_STDERR" | tail -n1 || echo '')"
  if ! [[ "$pending_count" =~ ^[0-9]+$ ]]; then
    fail "local pending_approvals COUNT 取得失敗 ('$pending_count')"
  fi
  if [ "$pending_count" -ne 0 ]; then
    fail "HITL 簡略化違反 Point 3: local pending_approvals に skill_id='$SKILL_ID' + action='adk_confirm' の row が $pending_count 件 (期待 0)"
  fi
  info "  Point 3 OK: local pending_approvals count=0"
fi

# =============================================================================
# Section 4: LOCAL channel 分離 (SQLite で 2 table 独立確認) (--local or both)
# =============================================================================
if [ "$MODE" = 'local' ] || [ "$MODE" = 'both' ]; then
  info '=== [4/10] LOCAL channel 分離 (SQLite 2 table 独立性) ==='

  # PR #132 review I5 対応: `data/v2.db` は Section 1 preflight で存在保証済 (前提条件)、
  # Section 4 全体を skip する経路を撤去 (「5 軸中 1 軸 (channel 分離) を未検証で PASS を名乗る」
  # silent 縮退を撲滅)。

    # (4-1) table 存在確認 (2 table が両方存在すること)
    LAST_HARNESS_STDERR="$STDERR_DIR/local-tables.stderr"
    tables_present="$(pnpm exec tsx scripts/q.ts data/v2.db \
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('fugue_equipped_biblios', 'session_equipped_biblios') ORDER BY name" \
      2>"$LAST_HARNESS_STDERR" || echo '')"
    if ! printf '%s' "$tables_present" | grep -q '^fugue_equipped_biblios$' \
       || ! printf '%s' "$tables_present" | grep -q '^session_equipped_biblios$'; then
      fail "local channel 分離違反: 2 table が両方存在しない (tables=$tables_present)
      対処: migration 017 (session_equipped_biblios) + 019 (fugue_equipped_biblios) 未適用の可能性"
    fi
    info "  (4-1) 2 table 存在 OK: fugue_equipped_biblios + session_equipped_biblios"

    # (4-2) Section 2 の equip 発火で fugue 側 row が >= 1 (equip reply が not_found 以外の場合のみ)
    #
    # PR #132 review C2 対応 (一貫性のため揃える): sentinel を `|| echo 0` → `|| echo ''` に統一。
    # 4-2 は閾値 `-lt 1` (>= 1 必須) のため `|| echo 0` でも偶然フェイルセーフ (0 は fail 判定) だが、
    # 4-3 (下記) との内部一貫性のため空文字 sentinel に揃える (Section 3 Point 3 と同流儀)。
    if [ "${equip_reply:-}" != 'not_found' ]; then
      LAST_HARNESS_STDERR="$STDERR_DIR/local-fugue-row.stderr"
      fugue_row="$(pnpm exec tsx scripts/q.ts data/v2.db \
        "SELECT COUNT(*) FROM fugue_equipped_biblios WHERE biblio_name='${SKILL_ID}'" \
        2>"$LAST_HARNESS_STDERR" | tail -n1 || echo '')"
      if ! [[ "$fugue_row" =~ ^[0-9]+$ ]]; then
        fail "local fugue_equipped_biblios COUNT 取得失敗 ('$fugue_row')"
      fi
      if [ "$fugue_row" -lt 1 ]; then
        fail "local channel 分離違反 (4-2): fugue_equipped_biblios に skill_id='$SKILL_ID' row 不在 (count=$fugue_row)"
      fi
      info "  (4-2) fugue 側 row 追加 OK: fugue_equipped_biblios[$SKILL_ID] count=$fugue_row"
    else
      warn "  (4-2) skip: Section 2 equip reply=not_found (棚に $SKILL_ID 不在、row 追加 assert 対象外)"
    fi

    # (4-3) session 側は無影響 = 同 SKILL_ID の session_equipped_biblios row が 0 件
    #
    # PR #132 review C2 対応: `|| echo 0` sentinel は「クエリ失敗」と「正常な 0 件」を
    # 区別できず、DB ロック / migration 未適用 / tsx crash が silent PASS に化ける経路だった。
    # `|| echo ''` に変更することで正規表現 `^[0-9]+$` が「クエリ失敗」を空文字として捕捉、
    # fail() 経路に誘導する (Section 3 Point 3 pending_count と同流儀)。
    LAST_HARNESS_STDERR="$STDERR_DIR/local-session-row.stderr"
    session_row="$(pnpm exec tsx scripts/q.ts data/v2.db \
      "SELECT COUNT(*) FROM session_equipped_biblios WHERE biblio_name='${SKILL_ID}'" \
      2>"$LAST_HARNESS_STDERR" | tail -n1 || echo '')"
    if ! [[ "$session_row" =~ ^[0-9]+$ ]]; then
      fail "local session_equipped_biblios COUNT 取得失敗 ('$session_row')"
    fi
    if [ "$session_row" -ne 0 ]; then
      # Slack 経由の別テストで既に装備してあるケース = verify session 発火では触らないが痕跡は残る。
      # 「Fugue equip で session 側が『触られた』」証拠を厳密に取るには B/A スナップショット比較が要る
      # が、Fugue equip の実装 (src/channels/fugue-http.ts + src/db/fugue-equipped-biblios.ts) は
      # session_equipped_biblios に一切書かない = 静的コントラクト。実装違反 = row 数変化しない前提で
      # skip とする (warn だけ残す)。
      warn "  (4-3) session_equipped_biblios に skill_id='$SKILL_ID' row が $session_row 件 (Slack 経路の別テスト痕跡、Fugue equip では触らない実装契約)"
    fi
    info "  (4-3) session 側無影響 OK (Fugue equip は session_equipped_biblios に書かない実装契約)"

    # (4-4) schema 独立性: 静的 grep で「Fugue equip は fugue_equipped_biblios のみを touch する」
    # 実装契約を担保。**fugue-http.ts の 1 file grep** で近似確認 (shokyaku.ts は Fugue equip の
    # cleanup で `deleteEquippedBiblioByName` (session 側削除) を正当に呼ぶため grep 対象に含めない
    # = shokyaku.ts に session_equipped_biblios の参照があっても違反ではない)。
    #
    # PR #132 review I1 対応: `grep -q PATTERN FILE 2>/dev/null` を `if ... then fail; fi` で
    # 使うと exit 1 (パターン不一致) と exit 2 (ファイル不在) を同一視 → ファイルがリネームされた
    # 瞬間に silent に無効化される柵。ファイル存在を先行 assert して防御する。
    # PR #132 review I2 対応: コメント文言「2 file grep」→「1 file grep」に訂正
    # (実装は元から 1 file、コメントが実装を超えて誇張していた誤修正リスク源)。
    FUGUE_HTTP_SRC="src/channels/fugue-http.ts"
    [ -f "$FUGUE_HTTP_SRC" ] \
      || fail "channel 分離チェック (4-4) 対象ファイル不在: $FUGUE_HTTP_SRC
      対処: ファイルがリネーム/移動された場合は本 verify script 側のパスも追従修正すること"
    if grep -q "session_equipped_biblios" "$FUGUE_HTTP_SRC"; then
      fail "channel 分離違反 (4-4): $FUGUE_HTTP_SRC が session_equipped_biblios を参照
      対処: Fugue channel は fugue_equipped_biblios のみを touch する実装契約 (M4-E Phase 3)"
    fi
    info "  (4-4) 静的 grep OK: fugue-http.ts は session_equipped_biblios を参照しない"
fi

# =============================================================================
# Section 5: PROD 疎通 + 認証 (curl 経由 Prod HTTPS) (--prod or both)
# =============================================================================
if [ "$MODE" = 'prod' ] || [ "$MODE" = 'both' ]; then
  info '=== [5/10] PROD 疎通 + 認証 (Prod HTTPS 経由) ==='

  # (5-1) Prod HTTPS /healthz (罠 14 対策: cert Active 直後 + LB frontend rollout 1-5 min の吸収)
  #
  # PR #132 review I6 対応: 元の 2×3s ≈ 26s は runbook §M4-E Phase 5 の実測 (罠 14: cert Active 化
  # 直後 1-5 min propagation) を吸収できない。runbook Step 4.5 の deploy 側 poll ループ
  # (12×30s = 6 min) と同 budget に揃える。定常状態運用では 1 回目で PASS するため wall-clock
  # 影響なし、rollout 直後の flaky false negative を排除。
  HEALTHZ_MAX_ATTEMPTS=12
  HEALTHZ_SLEEP_SEC=30
  healthz_ok=0
  for attempt in $(seq 1 "$HEALTHZ_MAX_ATTEMPTS"); do
    if curl -sS --max-time 10 "https://${DOMAIN}/healthz" \
         2>"$STDERR_DIR/prod-healthz-$attempt.stderr" \
       | grep -q '^ok$'; then
      healthz_ok=1
      [ "$attempt" -gt 1 ] && info "  [healthz attempt $attempt/$HEALTHZ_MAX_ATTEMPTS] OK after ~$(( (attempt-1) * HEALTHZ_SLEEP_SEC ))s"
      break
    fi
    if [ "$attempt" -lt "$HEALTHZ_MAX_ATTEMPTS" ]; then
      info "  [healthz attempt $attempt/$HEALTHZ_MAX_ATTEMPTS] fail, sleep ${HEALTHZ_SLEEP_SEC}s"
      sleep "$HEALTHZ_SLEEP_SEC"
    fi
  done
  if [ "$healthz_ok" -ne 1 ]; then
    LAST_HARNESS_STDERR="$STDERR_DIR/prod-healthz-${HEALTHZ_MAX_ATTEMPTS}.stderr"
    fail "Prod HTTPS /healthz が 6 min ($HEALTHZ_MAX_ATTEMPTS×${HEALTHZ_SLEEP_SEC}s) 以内に 'ok' を返さない (罠 14: cert Active 化直後の 1-5 min propagation を超過、または罠 3: NEG annotation 欠落)
    対処: (1) gcloud compute ssl-certificates describe biblio-fugue-cert --format='value(managed.status)' で ACTIVE 確認 /
          (2) kubectl get svc biblio-fugue-channel -o jsonpath='{.metadata.annotations.cloud\\.google\\.com/neg}' で NEG annotation 確認 /
          (3) curl --resolve $DOMAIN:443:<Ingress IP> で DNS 未反映を切り分け"
  fi
  info "  (5-1) Prod HTTPS /healthz OK"

  # (5-2) Prod HTTPS consult 200 + status ∈ {ok, not_found} + processing_time_ms 正整数
  consult_body_file="$STDERR_DIR/prod-consult.body"
  consult_http_code="$(curl -sS -o "$consult_body_file" -w '%{http_code}' \
    --max-time 15 \
    -X POST "https://${DOMAIN}/v1/channels/fugue/consult" \
    -H "Authorization: Bearer $PROD_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"schema_version\":\"1\",\"request_id\":\"verify-consult-$(date +%s)\",\"query\":\"typescript\",\"mode\":\"ask-ad\"}" \
    2>"$STDERR_DIR/prod-consult.stderr" || echo "000")"

  if [ "$consult_http_code" != '200' ]; then
    LAST_HARNESS_STDERR="$STDERR_DIR/prod-consult.stderr"
    fail "Prod consult HTTP status != 200 (got '$consult_http_code')
    body 抜粋: $(head -c 400 "$consult_body_file" 2>/dev/null | tr '\n' ' ')
    対処: 罠 12 疑い = NetworkPolicy egress :3307 (cloud-sql-proxy) 欠落 →
          k8s/27-networkpolicy-fugue-channel.yaml で :3307 egress 許可を確認"
  fi

  consult_body="$(cat "$consult_body_file")"
  consult_reply_status="$(json_field "$consult_body" 'status')"
  consult_proc_ms="$(json_field "$consult_body" 'processing_time_ms')"

  if ! [[ "$consult_reply_status" =~ ^(ok|not_found)$ ]]; then
    fail "Prod consult reply status not in {ok, not_found} (got '$consult_reply_status'): $consult_body
    対処: 罠 12: NetworkPolicy :3307 欠落 → listBiblio classifyListBiblioError 経路で status:'error' 応答"
  fi
  if ! [[ "$consult_proc_ms" =~ ^[0-9]+$ ]]; then
    fail "Prod consult processing_time_ms が正整数でない (got '$consult_proc_ms'): $consult_body"
  fi
  info "  (5-2) Prod HTTPS consult 200 reply=$consult_reply_status processing_time_ms=$consult_proc_ms (OK)"

  # (5-3) 認証 fail 401 (invalid token)
  auth_fail_http="$(curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 10 \
    -X POST "https://${DOMAIN}/v1/channels/fugue/consult" \
    -H "Authorization: Bearer INVALID-VERIFY-TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"schema_version":"1","request_id":"verify-auth-fail","query":"test","mode":"ask-ad"}' \
    2>"$STDERR_DIR/prod-auth-fail.stderr" || echo "000")"

  if [ "$auth_fail_http" != '401' ]; then
    LAST_HARNESS_STDERR="$STDERR_DIR/prod-auth-fail.stderr"
    fail "Prod 認証 fail expected HTTP 401 (got '$auth_fail_http')
    対処: Bearer auth 経路 (fugue-http.ts:handleRequest) が壊れている可能性"
  fi
  info "  (5-3) Prod 認証 fail (invalid token → 401) OK"
fi

# =============================================================================
# Section 6: PROD Ingress backend HEALTHY (assertion 2) (--prod or both)
# =============================================================================
if [ "$MODE" = 'prod' ] || [ "$MODE" = 'both' ]; then
  info '=== [6/10] PROD Ingress backend HEALTHY ==='

  # (6-1) NEG annotation 確認 (罠 3 対策、静的な k8s manifest state check)
  NEG_ANNOT="$(kubectl get svc biblio-fugue-channel -n "$NAMESPACE" \
    -o jsonpath='{.metadata.annotations.cloud\.google\.com/neg}' \
    2>"$STDERR_DIR/prod-neg-annot.stderr" || echo '')"
  if ! printf '%s' "$NEG_ANNOT" | grep -q '"ingress"[[:space:]]*:[[:space:]]*true'; then
    LAST_HARNESS_STDERR="$STDERR_DIR/prod-neg-annot.stderr"
    fail "罠 3: Service 'biblio-fugue-channel' の NEG annotation 欠落 (actual: '$NEG_ANNOT')
    対処: k8s/26-service-fugue-channel.yaml の cloud.google.com/neg annotation を確認"
  fi
  info "  (6-1) NEG annotation OK: $NEG_ANNOT"

  # (6-2) backend service 名の動的解決 (GKE Ingress auto-name pattern)
  BS_NAME="$(gcloud compute backend-services list \
    --filter="name~biblio-fugue-channel" \
    --format="value(name)" --global \
    --project="$GCP_PROJECT_ID" \
    2>"$STDERR_DIR/prod-bs-list.stderr" | head -n1 || echo '')"
  if [ -z "$BS_NAME" ]; then
    LAST_HARNESS_STDERR="$STDERR_DIR/prod-bs-list.stderr"
    fail "backend-services に 'biblio-fugue-channel' に match する auto-name が見つからない
    対処: (1) Ingress 未 apply 状態の可能性 (kubectl get ingress biblio-fugue-channel -n $NAMESPACE で確認) /
          (2) rollout 中 (Ingress rollout に数分-10分要する場合あり)"
  fi
  info "  (6-2) backend-service 名解決 OK: $BS_NAME"

  # (6-3) health 確認: 全 backend HEALTHY
  BS_HEALTH_JSON="$(gcloud compute backend-services get-health "$BS_NAME" \
    --global --format=json \
    --project="$GCP_PROJECT_ID" \
    2>"$STDERR_DIR/prod-bs-health.stderr" || echo '[]')"

  # healthStatus が空 (= backend 未存在) を fail に落とす
  BS_HEALTH_COUNT="$(printf '%s' "$BS_HEALTH_JSON" \
    | jq '[.[] | .healthStatus // []] | add | length' 2>/dev/null || echo 0)"
  if ! [[ "$BS_HEALTH_COUNT" =~ ^[0-9]+$ ]] || [ "$BS_HEALTH_COUNT" -lt 1 ]; then
    LAST_HARNESS_STDERR="$STDERR_DIR/prod-bs-health.stderr"
    fail "backend-service '$BS_NAME' の healthStatus が空 (backend 未存在の可能性)"
  fi

  UNHEALTHY="$(printf '%s' "$BS_HEALTH_JSON" \
    | jq '[.[] | .healthStatus // [] | .[] | select(.healthState != "HEALTHY")] | length' 2>/dev/null || echo -1)"
  if ! [[ "$UNHEALTHY" =~ ^[0-9]+$ ]] || [ "$UNHEALTHY" -ne 0 ]; then
    LAST_HARNESS_STDERR="$STDERR_DIR/prod-bs-health.stderr"
    fail "backend '$BS_NAME' に UNHEALTHY backend が $UNHEALTHY 件存在 (全 HEALTHY 期待)
    対処: (1) StatefulSet readinessProbe が exec test -f /tmp/host-ready で通っているか /
          (2) BackendConfig CRD の healthCheck path=/healthz が Pod で 200 返しているか /
          (3) NetworkPolicy が LB health check IP range (35.191/16, 130.211/22) を許可しているか"
  fi
  info "  (6-3) backend-service $BS_NAME 全 backend HEALTHY (count=$BS_HEALTH_COUNT)"
fi

# =============================================================================
# Section 7: PROD Cloud Trace 親子関係 (assertion 3) (--prod or both)
# =============================================================================
if [ "$MODE" = 'prod' ] || [ "$MODE" = 'both' ]; then
  info '=== [7/10] PROD Cloud Trace 親子関係 (fugue.consult → biblio.list) ==='

  # (7-1) 決定的な trace_id 生成 (W3C traceparent 仕様: 32 hex + 16 hex + flags)
  TRACE_ID="$(openssl rand -hex 16)"
  SPAN_ID_ROOT="$(openssl rand -hex 8)"
  TRACEPARENT="00-${TRACE_ID}-${SPAN_ID_ROOT}-01"
  info "  (7-1) traceparent 生成: $TRACEPARENT"

  # (7-2) consult 発火 (traceparent 経由、Prod URL + Prod token)
  LAST_HARNESS_STDERR="$STDERR_DIR/prod-consult-trace.stderr"
  trace_result="$(FUGUE_URL="https://${DOMAIN}" FUGUE_SHARED_TOKEN="$PROD_TOKEN" \
    pnpm exec tsx scripts/fake-fugue-client.ts consult \
    --query "verify-trace" --mode "ask-ad" \
    --traceparent "$TRACEPARENT" \
    2>"$LAST_HARNESS_STDERR" | extract_result || true)"
  [ -n "$trace_result" ] || fail "Prod consult (traceparent) が RESULT を出さなかった"

  # PR #132 review S2 対応: used_traceparent は fake-fugue-client.ts:180 で `traceparent ?? null`
  # = CLI 入力エコー。この assert は「client 側で例外なく traceparent header を送出したこと」の
  # sanity check であり、biblio-claw サーバ側の traceparent 継承 (extractTraceContextFromHttpHeaders)
  # は Section 7-4 の親子関係 assert で完結する二段構造。削除せずコメントで明示することで
  # trace の client → server 経路の各段が「どこで検証されているか」を後段で追跡可能に。
  used_traceparent="$(json_field "$trace_result" 'used_traceparent')"
  [ "$used_traceparent" = "$TRACEPARENT" ] \
    || fail "used_traceparent != TRACEPARENT: got='$used_traceparent' expected='$TRACEPARENT'
    (これは client 側 sanity check、fetch() が traceparent header を送出したことの確認)"
  trace_reply="$(json_field "$trace_result" 'response_body.status')"
  [[ "$trace_reply" =~ ^(ok|not_found)$ ]] \
    || fail "Prod consult (traceparent) reply != ok/not_found (got '$trace_reply')"
  info "  (7-2) consult 発火 OK (reply=$trace_reply、trace_id=$TRACE_ID を Cloud Trace で待機)"

  # ADC access token 取得
  TOKEN_ADC="$(gcloud auth application-default print-access-token 2>"$STDERR_DIR/adc-token.stderr")" \
    || { LAST_HARNESS_STDERR="$STDERR_DIR/adc-token.stderr"; fail "ADC access token 取得失敗"; }

  # (7-3) Cloud Trace REST API v1 retry (30×3s = 90s max)、fugue.consult + biblio.list の両 span 揃い待ち
  #
  # PR #132 review I7 対応: jq の stderr を破棄せず個別ファイルに保存し、fail() 時に $TRACE_BODY
  # 先頭抜粋を dump する。Cloud Trace API のスキーマ変更 / v1 破壊的変更 / .spans 構造想定外を
  # 「90s timeout」の対処法 (ADC 権限 / instrumentation.ts) に誤誘導される silent 経路を撲滅。
  TRACE_BODY=''
  for i in $(seq 1 30); do
    body="$(curl -fsS -H "Authorization: Bearer $TOKEN_ADC" \
      "https://cloudtrace.googleapis.com/v1/projects/${GCP_PROJECT_ID}/traces/${TRACE_ID}" \
      2>"$STDERR_DIR/prod-trace-curl-$i.stderr" || true)"
    if [ -n "$body" ]; then
      span_names_partial="$(printf '%s' "$body" \
        | jq -r '.spans[].name' 2>"$STDERR_DIR/prod-trace-jq-names-$i.stderr" || true)"
      if printf '%s' "$span_names_partial" | grep -qE '^fugue\.consult$' \
         && printf '%s' "$span_names_partial" | grep -qE '^biblio\.list$'; then
        TRACE_BODY="$body"
        info "  [attempt ${i}/30] trace 到達 (fugue.consult + biblio.list 揃い) after ~$(( (i-1) * 3 ))s"
        break
      fi
    fi
    info "  [attempt ${i}/30] partial; sleep 3s"
    sleep 3
  done

  if [ -z "$TRACE_BODY" ]; then
    LAST_HARNESS_STDERR="$STDERR_DIR/prod-trace-curl-30.stderr"
    fail "Cloud Trace に trace_id=$TRACE_ID が 90s 以内に到達しなかった (fugue.consult + biblio.list 揃い待ち)
    対処: (1) ADC 実行ユーザに roles/cloudtrace.user 付与済か /
          (2) instrumentation.ts が --import 経路で起動されているか (Pod env) /
          (3) OTLP export 失敗の可能性 (kubectl logs $POD -c orchestrator で確認) /
          (4) traceparent 継承 (http-propagation.ts の extractTraceContextFromHttpHeaders) が動いているか"
  fi

  # (7-4) 親子関係 assert: fugue.consult.spanId == biblio.list.parentSpanId
  FUGUE_SPAN_ID="$(printf '%s' "$TRACE_BODY" \
    | jq -r '.spans[] | select(.name=="fugue.consult") | .spanId' 2>"$STDERR_DIR/prod-trace-jq-fugue.stderr" || echo '')"
  BIBLIO_PARENT_ID="$(printf '%s' "$TRACE_BODY" \
    | jq -r '.spans[] | select(.name=="biblio.list") | .parentSpanId' 2>"$STDERR_DIR/prod-trace-jq-biblio.stderr" || echo '')"

  if [ -z "$FUGUE_SPAN_ID" ] || [ -z "$BIBLIO_PARENT_ID" ]; then
    # jq stderr + TRACE_BODY 抜粋を診断情報として展開 (I7: Cloud Trace API v1 スキーマ変更検知経路)。
    {
      echo "== jq stderr (fugue.consult 抽出) =="
      cat "$STDERR_DIR/prod-trace-jq-fugue.stderr" 2>/dev/null || echo "  (empty)"
      echo "== jq stderr (biblio.list 抽出) =="
      cat "$STDERR_DIR/prod-trace-jq-biblio.stderr" 2>/dev/null || echo "  (empty)"
      echo "== TRACE_BODY 抜粋 (先頭 500 char) =="
      printf '%s' "$TRACE_BODY" | head -c 500
    } > "$STDERR_DIR/prod-trace-extract-debug.log"
    LAST_HARNESS_STDERR="$STDERR_DIR/prod-trace-extract-debug.log"
    fail "trace span 抽出失敗: fugue.consult.spanId='$FUGUE_SPAN_ID' biblio.list.parentSpanId='$BIBLIO_PARENT_ID'
    対処: (1) Cloud Trace REST API v1 のスキーマが変わっていないか (jq stderr で確認) /
          (2) TRACE_BODY 抜粋で実際に返された JSON 構造を確認 /
          (3) 予期しない .spans 配下の形の場合、jq クエリの見直し要"
  fi
  [ "$FUGUE_SPAN_ID" = "$BIBLIO_PARENT_ID" ] \
    || fail "親子関係不一致: fugue.consult.spanId='$FUGUE_SPAN_ID' vs biblio.list.parentSpanId='$BIBLIO_PARENT_ID'
    対処: withFugueEntrySpan 経路が biblio.list を子として nest していない可能性 (fugue-entry-span.ts:74-104)"
  info "  (7-4) 親子関係 OK: fugue.consult ($FUGUE_SPAN_ID) → biblio.list (parent=$BIBLIO_PARENT_ID)"

  # (7-5) channel 属性: fugue.consult.labels.channel == 'fugue'
  CHANNEL_ATTR="$(printf '%s' "$TRACE_BODY" \
    | jq -r '.spans[] | select(.name=="fugue.consult") | .labels["channel"] // ""' \
      2>"$STDERR_DIR/prod-trace-jq-channel.stderr" || echo '')"
  if [ "$CHANNEL_ATTR" != 'fugue' ]; then
    LAST_HARNESS_STDERR="$STDERR_DIR/prod-trace-jq-channel.stderr"
    fail "fugue.consult.labels.channel != 'fugue' (got '$CHANNEL_ATTR')
    対処: withFugueEntrySpan で channel:'fugue' 属性が set されているか確認 (fugue-entry-span.ts)"
  fi
  info "  (7-5) channel='fugue' label OK"
fi

# =============================================================================
# Section 8: PROD BigQuery sink (assertion 4) (--prod or both)
# =============================================================================
if [ "$MODE" = 'prod' ] || [ "$MODE" = 'both' ]; then
  info '=== [8/10] PROD BigQuery sink (channel='"'fugue'"' の row >= 1) ==='

  # stdout + stderr 両テーブル存在確認 + `jsonPayload.channel = 'fugue'` の row count
  # M4-A Phase 3 sink は use_partitioned_tables = true で stdout / stderr 単独名で partition。
  # M4-A Phase 4 verify-m4-a.sh:270-365 pattern 踏襲、fugue filter に差替。
  BQ_TABLES="$(bq ls --format=json --max_results=500 "${GCP_PROJECT_ID}:${BQ_DATASET_ID}" 2>"$STDERR_DIR/bq-ls.stderr" \
    | jq -r '.[].tableReference.tableId' 2>/dev/null \
    | grep -E '^(stdout|stderr)$' || true)"
  if [ -z "$BQ_TABLES" ]; then
    LAST_HARNESS_STDERR="$STDERR_DIR/bq-ls.stderr"
    fail "BQ dataset ${GCP_PROJECT_ID}:${BQ_DATASET_ID} に stdout/stderr テーブル不在 (M4-A sink 未 apply 疑い)"
  fi
  info "  対象 BQ テーブル: $(printf '%s' "$BQ_TABLES" | tr '\n' ' ')"

  BQ_WHERE="WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR) AND jsonPayload.channel = 'fugue'"

  BQ_TOTAL=0
  bq_found=0
  auth_fail_streak=0
  AUTH_FAIL_MAX=3
  SINK_PROBE_MAX=6
  LAST_BQ_ATTEMPT=0

  # PR #132 review I8 対応: 個別テーブルごとの失敗回数を保持し、部分失敗 (stdout 成功 / stderr 恒常失敗)
  # 経路でも fail() 時に「どのテーブルが何回失敗したか」の集計 + 個別 stderr を診断情報として展開する。
  declare -A BQ_TABLE_FAIL_COUNT
  for T in $BQ_TABLES; do
    BQ_TABLE_FAIL_COUNT["$T"]=0
  done

  for i in $(seq 1 "$SINK_PROBE_MAX"); do
    LAST_BQ_ATTEMPT="$i"
    BQ_TOTAL=0
    outer_auth_fails=0
    outer_table_count=0
    for T in $BQ_TABLES; do
      outer_table_count=$((outer_table_count + 1))
      COUNT="$(bq query --project_id="$GCP_PROJECT_ID" --use_legacy_sql=false \
        --format=csv --quiet \
        "SELECT COUNT(*) FROM \`${GCP_PROJECT_ID}.${BQ_DATASET_ID}.${T}\` ${BQ_WHERE}" \
        2>"$STDERR_DIR/bq-poll-${i}-${T}.stderr" | tail -n1 || echo BQ_QUERY_FAIL)"
      if [[ "$COUNT" =~ ^[0-9]+$ ]]; then
        BQ_TOTAL=$(( BQ_TOTAL + COUNT ))
        [ "$BQ_TOTAL" -ge 1 ] && break
      else
        outer_auth_fails=$((outer_auth_fails + 1))
        BQ_TABLE_FAIL_COUNT["$T"]=$(( BQ_TABLE_FAIL_COUNT["$T"] + 1 ))
      fi
    done

    if [ "$BQ_TOTAL" -ge 1 ]; then
      bq_found=1
      info "  [attempt ${i}/${SINK_PROBE_MAX}] BQ sink OK (channel='fugue' row=${BQ_TOTAL}) after ~$(( (i-1) * 10 ))s"
      break
    fi

    outer_success=$(( outer_table_count - outer_auth_fails ))
    info "  [attempt ${i}/${SINK_PROBE_MAX}] not yet (success=${outer_success}/${outer_table_count}, fail=${outer_auth_fails}); sleep 10s"

    if [ "$outer_table_count" -gt 0 ] && [ "$outer_auth_fails" -eq "$outer_table_count" ]; then
      auth_fail_streak=$((auth_fail_streak + 1))
      if [ "$auth_fail_streak" -ge "$AUTH_FAIL_MAX" ]; then
        LAST_HARNESS_STDERR="$STDERR_DIR/bq-poll-${i}-$(printf '%s' "$BQ_TABLES" | head -n1).stderr"
        fail "BQ poll early abort: ${AUTH_FAIL_MAX} 連続全 query fail
        対処: (1) roles/bigquery.dataViewer 付与済か / (2) jsonPayload スキーマ仮定ミス / (3) network"
      fi
    else
      auth_fail_streak=0
    fi
    sleep 10
  done

  if [ "$bq_found" -ne 1 ]; then
    # 部分失敗診断: どのテーブルが何回失敗したかを集計 + 直近 stderr を dump (I8 対応)。
    {
      echo "== BQ table 別失敗回数 ($SINK_PROBE_MAX attempts 中) =="
      for T in $BQ_TABLES; do
        echo "  table=$T fail_count=${BQ_TABLE_FAIL_COUNT[$T]}/$SINK_PROBE_MAX"
      done
      echo "== 直近 attempt ($LAST_BQ_ATTEMPT) の stderr 抜粋 =="
      for T in $BQ_TABLES; do
        if [ -s "$STDERR_DIR/bq-poll-${LAST_BQ_ATTEMPT}-${T}.stderr" ]; then
          echo "--- table=$T ---"
          tail -c 400 "$STDERR_DIR/bq-poll-${LAST_BQ_ATTEMPT}-${T}.stderr"
        fi
      done
    } > "$STDERR_DIR/bq-poll-summary.log"
    LAST_HARNESS_STDERR="$STDERR_DIR/bq-poll-summary.log"
    fail "BQ sink 疎通確認 fail: channel='fugue' の row が 60s 以内に到達しない
    対処: (1) Section 5/7 の consult が実際に Prod Pod で処理されたか /
          (2) Cloud Logging → BQ sink filter (k8s_container + namespace=biblio-claw) が biblio-claw に mapping /
          (3) sink export lag (通常 数s-30s、稀に 1-2min) /
          (4) 上の LAST_HARNESS_STDERR 内の「BQ table 別失敗回数」を確認 = 部分失敗 (stdout 成功 / stderr のみ恒常失敗)なら別要因"
  fi
fi

# =============================================================================
# Section 9: PROD HITL 簡略化 + channel 分離 (--prod or both)
# =============================================================================
if [ "$MODE" = 'prod' ] || [ "$MODE" = 'both' ]; then
  info '=== [9/10] PROD HITL 簡略化 + channel 分離 ==='

  # (9-1) Prod GKE 上で equip 発火 (Section 5 で既に一度 consult は発火済、equip は Section 9 で発火)
  LAST_HARNESS_STDERR="$STDERR_DIR/prod-equip.stderr"
  CLEANUP_SKILL_ID="$SKILL_ID"
  CLEANUP_PROD_DIRTY=1
  prod_equip_result="$(FUGUE_URL="https://${DOMAIN}" FUGUE_SHARED_TOKEN="$PROD_TOKEN" \
    pnpm exec tsx scripts/fake-fugue-client.ts equip \
    --skill-id "$SKILL_ID" \
    2>"$LAST_HARNESS_STDERR" | extract_result || true)"
  [ -n "$prod_equip_result" ] || fail "Prod equip が RESULT を出さなかった"

  prod_equip_http="$(json_field "$prod_equip_result" 'status')"
  prod_equip_reply="$(json_field "$prod_equip_result" 'response_body.status')"
  [ "$prod_equip_http" = '200' ] \
    || fail "Prod equip HTTP status != 200 (got '$prod_equip_http'): $prod_equip_result"
  [[ "$prod_equip_reply" =~ ^(equipped|already_equipped|not_found)$ ]] \
    || fail "Prod equip reply not in {equipped, already_equipped, not_found} (got '$prod_equip_reply')
    (skills-tdd-first が棚に存在しない場合は VERIFY_FUGUE_TEST_SKILL_ID env で override)"
  info "  (9-1) Prod equip OK: http=200 reply=$prod_equip_reply"

  # (9-2) HITL Point 1: reply status に hitl_required 不在
  if printf '%s' "$prod_equip_reply" | grep -q 'hitl_required'; then
    fail "Prod HITL 簡略化違反 Point 1: Prod equip reply='$prod_equip_reply' に hitl_required 含む"
  fi
  info "  (9-2) Point 1 OK: Prod equip reply に hitl_required なし"

  # (9-3) HITL Point 2: Pod ログに fugue.equip.hitl_required event 不在 (直近 2min)
  #
  # PR #132 review C3 対応: `kubectl logs ... || true` は RBAC 拒否 / Pod 再起動 / GKE API 5xx で
  # `POD_LOGS=''` 化 → `grep -q` は必ず miss → 常に「Point 2 OK」の silent PASS 経路。
  # `if ! cmd > out 2> err; then fail; fi` idiom (verify-m4-b.sh:205-213 pattern) に置き換えて
  # ログ取得自体の失敗を明示的に fail() に導く。Local 側 (Section 3 Point 2) との対称性も回復。
  if ! kubectl logs "$POD" -c orchestrator -n "$NAMESPACE" --since=2m \
       > "$STDERR_DIR/prod-pod-logs.out" 2> "$STDERR_DIR/prod-pod-logs.stderr"; then
    LAST_HARNESS_STDERR="$STDERR_DIR/prod-pod-logs.stderr"
    fail "Prod Pod ログ取得失敗 (kubectl logs が非 0 終了) — HITL Point 2 を検証できない
    対処: (1) RBAC 拒否 (kubectl auth can-i get pods/log -n $NAMESPACE) /
          (2) Pod 再起動直後で --since=2m のウィンドウが空振り /
          (3) GKE API 一時 5xx (再試行)"
  fi
  # LOG_FORMAT はここでも念のため text/json 両対応 (Section 3 Point 2 と同流儀、grep pattern を統一)。
  if grep -qE '"event":"fugue\.equip\.hitl_required"|event="fugue\.equip\.hitl_required"' "$STDERR_DIR/prod-pod-logs.out"; then
    LAST_HARNESS_STDERR="$STDERR_DIR/prod-pod-logs.out"
    fail "Prod HITL 簡略化違反 Point 2: Pod ログに 'fugue.equip.hitl_required' event 発火痕跡あり
    対処: requiresApproval matrix が変更された可能性 (src/biblio/hitl-policy.ts:65-75)"
  fi
  info "  (9-3) Point 2 OK: Pod ログに fugue.equip.hitl_required event 不在 (text/json 両対応)"

  # (9-4) HITL Point 3: Prod SQLite の pending_approvals に該当 payload の row が 0 件
  LAST_HARNESS_STDERR="$STDERR_DIR/prod-pending.stderr"
  prod_pending_count="$(kubectl exec "$POD" -c orchestrator -n "$NAMESPACE" -- \
    pnpm exec tsx scripts/q.ts /data/v2.db \
    "SELECT COUNT(*) FROM pending_approvals WHERE payload LIKE '%${SKILL_ID}%' AND action='adk_confirm'" \
    2>"$LAST_HARNESS_STDERR" | tail -n1 || echo '')"
  if ! [[ "$prod_pending_count" =~ ^[0-9]+$ ]]; then
    fail "Prod pending_approvals COUNT 取得失敗 ('$prod_pending_count')"
  fi
  if [ "$prod_pending_count" -ne 0 ]; then
    fail "Prod HITL 簡略化違反 Point 3: pending_approvals に skill_id='$SKILL_ID' + action='adk_confirm' row が $prod_pending_count 件 (期待 0)"
  fi
  info "  (9-4) Point 3 OK: Prod pending_approvals count=0"

  # (9-5) channel 分離: fugue 側 row が >= 1 (equip reply が not_found 以外の場合)
  #
  # PR #132 review C2 対応 (一貫性のため揃える): sentinel を `|| echo 0` → `|| echo ''` に統一
  # (Section 4-2 / 4-3 と同流儀、query 失敗と正当な 0 件を区別可能に)。
  if [ "$prod_equip_reply" != 'not_found' ]; then
    LAST_HARNESS_STDERR="$STDERR_DIR/prod-fugue-row.stderr"
    prod_fugue_row="$(kubectl exec "$POD" -c orchestrator -n "$NAMESPACE" -- \
      pnpm exec tsx scripts/q.ts /data/v2.db \
      "SELECT COUNT(*) FROM fugue_equipped_biblios WHERE biblio_name='${SKILL_ID}'" \
      2>"$LAST_HARNESS_STDERR" | tail -n1 || echo '')"
    if ! [[ "$prod_fugue_row" =~ ^[0-9]+$ ]]; then
      fail "Prod fugue_equipped_biblios COUNT 取得失敗 ('$prod_fugue_row')"
    fi
    if [ "$prod_fugue_row" -lt 1 ]; then
      fail "Prod channel 分離違反: fugue_equipped_biblios[$SKILL_ID] row 不在 (count=$prod_fugue_row)"
    fi
    info "  (9-5) channel 分離 OK: Prod fugue_equipped_biblios[$SKILL_ID] count=$prod_fugue_row"
  else
    warn "  (9-5) skip: Prod equip reply=not_found (棚に $SKILL_ID 不在、row assert 対象外)"
  fi

  # (9-6) 静的 grep: fugue-http.ts が session_equipped_biblios を触らない実装契約 (Section 4-4 と対称)
  #
  # PR #132 review I1 対応: Section 4-4 と同流儀でファイル存在を先行 assert (exit 1 と exit 2 の同一視回避)。
  FUGUE_HTTP_SRC="src/channels/fugue-http.ts"
  [ -f "$FUGUE_HTTP_SRC" ] \
    || fail "channel 分離チェック (9-6) 対象ファイル不在: $FUGUE_HTTP_SRC
    対処: ファイルがリネーム/移動された場合は本 verify script 側のパスも追従修正すること"
  if grep -q "session_equipped_biblios" "$FUGUE_HTTP_SRC"; then
    fail "Prod channel 分離違反 (9-6): $FUGUE_HTTP_SRC が session_equipped_biblios を参照
    対処: 実装契約違反 (M4-E Phase 3、fugue channel は fugue_equipped_biblios のみを touch)"
  fi
  info "  (9-6) 静的 grep OK: fugue-http.ts は session_equipped_biblios を参照しない"
fi

# =============================================================================
# Section 10: PROD keyless 3 段 assert (--prod or both)
# =============================================================================
if [ "$MODE" = 'prod' ] || [ "$MODE" = 'both' ]; then
  info '=== [10/10] PROD keyless 3 段 assert (KSA + GSA IAM + no USER_MANAGED key) ==='

  # PR #132 review I3 対応: project ID / namespace を hardcode せず、preflight で解決した
  # $GCP_PROJECT_ID / $NAMESPACE を展開する。VERIFY_FUGUE_NAMESPACE env override が silent に
  # 無視される DRY 違反を解消 + 将来の project 切替に自動追従。
  GSA_EMAIL="biblio-orchestrator@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
  KSA_NAME='biblio-orchestrator-ksa'
  WI_MEMBER="serviceAccount:${GCP_PROJECT_ID}.svc.id.goog[${NAMESPACE}/${KSA_NAME}]"

  # (10-a) KSA annotation: iam.gke.io/gcp-service-account が GSA email と一致
  KSA_ANNOT="$(kubectl get sa "$KSA_NAME" -n "$NAMESPACE" \
    -o jsonpath='{.metadata.annotations.iam\.gke\.io/gcp-service-account}' \
    2>"$STDERR_DIR/ksa-annot.stderr" || echo '')"
  if [ "$KSA_ANNOT" != "$GSA_EMAIL" ]; then
    LAST_HARNESS_STDERR="$STDERR_DIR/ksa-annot.stderr"
    fail "keyless (a) 違反: KSA '$KSA_NAME' の iam.gke.io/gcp-service-account annotation != '$GSA_EMAIL'
    実際: '$KSA_ANNOT'
    対処: k8s/03-serviceaccount-orchestrator.yaml (or 相当) の annotation を確認"
  fi
  info "  (10-a) KSA annotation OK: $KSA_NAME → $GSA_EMAIL"

  # (10-b) GSA IAM policy に workloadIdentityUser binding が含まれている
  GSA_POLICY="$(gcloud iam service-accounts get-iam-policy "$GSA_EMAIL" \
    --format=json \
    --project="$GCP_PROJECT_ID" \
    2>"$STDERR_DIR/gsa-policy.stderr" || echo '{}')"

  WI_HAS_MEMBER="$(printf '%s' "$GSA_POLICY" \
    | jq -r --arg m "$WI_MEMBER" \
      '[.bindings[]? | select(.role == "roles/iam.workloadIdentityUser") | .members[]? | select(. == $m)] | length' \
    2>/dev/null || echo 0)"
  if ! [[ "$WI_HAS_MEMBER" =~ ^[0-9]+$ ]] || [ "$WI_HAS_MEMBER" -lt 1 ]; then
    LAST_HARNESS_STDERR="$STDERR_DIR/gsa-policy.stderr"
    # PR #132 review S1 対応: workloadIdentityUser binding は M1/M2 phase で `init-project-gcp` skill
    # or 手動 gcloud で管理されており、terraform/fugue-channel/ 配下には該当 resource なし
    # (grep -rn "workloadIdentityUser" terraform/ で 0 hit)。主従を入れ替えて基盤 IAM を先に提示、
    # terraform/ を fallback に落として operator 誤誘導を防ぐ。
    fail "keyless (b) 違反: GSA '$GSA_EMAIL' の roles/iam.workloadIdentityUser bindings に '$WI_MEMBER' 不在
    対処: (1) M1/M2 phase で設定された基盤 IAM を確認 (gcloud iam service-accounts add-iam-policy-binding、
              init-project-gcp skill で管理、terraform/ 配下には該当 binding なし = 一次情報) /
          (2) fallback: terraform/fugue-channel/main.tf を念のため grep (通常はここにはない)"
  fi
  info "  (10-b) GSA IAM workloadIdentityUser binding OK: $WI_MEMBER"

  # (10-c) USER_MANAGED key 空 (SYSTEM_MANAGED は Google 側管理、問題なし)
  USER_KEY_COUNT="$(gcloud iam service-accounts keys list \
    --iam-account="$GSA_EMAIL" \
    --managed-by=user \
    --format=json \
    --project="$GCP_PROJECT_ID" \
    2>"$STDERR_DIR/gsa-user-keys.stderr" \
    | jq 'length' 2>/dev/null || echo -1)"
  if ! [[ "$USER_KEY_COUNT" =~ ^[0-9]+$ ]]; then
    LAST_HARNESS_STDERR="$STDERR_DIR/gsa-user-keys.stderr"
    fail "keyless (c) 読み取り失敗: USER_MANAGED key list 取得できず (USER_KEY_COUNT='$USER_KEY_COUNT')"
  fi
  if [ "$USER_KEY_COUNT" -ne 0 ]; then
    fail "keyless (c) 違反: GSA '$GSA_EMAIL' に USER_MANAGED key が $USER_KEY_COUNT 件存在
    対処: gcloud iam service-accounts keys list --iam-account=$GSA_EMAIL --managed-by=user で列挙、
          対象 key を削除するか監査 (SA key JSON 漏洩リスク経路 = keyless 原則違反)"
  fi
  info "  (10-c) USER_MANAGED key 空 OK (keyless 成立、SYSTEM_MANAGED のみ)"
fi

# =============================================================================
# PASS marker
# =============================================================================
info '  all assertions passed'
case "$MODE" in
  local) echo 'M4-E PASS (local)' ;;
  prod)  echo 'M4-E PASS (prod)' ;;
  both)  echo 'M4-E PASS (both)' ;;
esac
