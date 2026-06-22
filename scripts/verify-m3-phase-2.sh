#!/usr/bin/env bash
# biblio-claw: M3 Phase 2 装備機構自律呼び出し E2E verify
#
# 物理配置 (Phase 1) の上に lifecycle (= spawn-time install + SKILL 発火 +
# ephemeral 解除) を乗せたサイクル全体を E2E で検証する。
#
# 流れ:
#   1. Phase 1 regression を呼ぶ (= verify-m3-phase-1.sh、引数透過)
#   2. Phase 2 Phase A (Docker local): fixture 投入 → spawn-verify ハーネス →
#      marker 検出 → 装備源残置確認 → 2 回目 spawn-verify で install 冪等確認
#   3. Phase 2 Phase B (GKE): tar 経由 (symlink / 実行権保持のため kubectl cp ではない) で
#      PVC fixture 投入 → orchestrator Pod 内で spawn-verify ハーネス → marker 検出
#      (Phase 5 で統合 verify に組み込まれる予定)
#
# 引数:
#   --local-only   Docker local 経路のみ実行
#   --gke-only     GKE 経路のみ実行
#   (省略)         両方実行
#
# 前提 (local 経路):
#   - .env に Vertex / GH / OneCLI / DATA_DIR 設定済
#   - docker compose up -d --wait (OneCLI gateway) + onecli-{vertex,gh}-secret.sh 投入済
#   - nanoclaw-agent:latest が build 済 (= ./container/build.sh で jq + install-biblios.sh 入り)
#
# 各 assert 失敗で exit 1。全通過で `M3 P2 PASS (...)` を出して exit 0。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# info/warn/fail/extract_result/json_field は verify-m3-helpers.sh に集約 (PR #21 code-simplifier 推奨)。
# shellcheck source=scripts/verify-m3-helpers.sh
source "$(dirname "${BASH_SOURCE[0]}")/verify-m3-helpers.sh"

# --- 引数 parse ---
RUN_LOCAL=1
RUN_GKE=1
case "${1:-}" in
  --local-only) RUN_GKE=0 ;;
  --gke-only)   RUN_LOCAL=0 ;;
  '')           ;;
  *)            fail "unknown arg: $1 — usage: verify-m3-phase-2.sh [--local-only|--gke-only]" ;;
esac

# --- pre-flight ---
[ -f .env ] || fail ".env が見つかりません — repo root で実行してください (現在地: $PWD)"

set -a
# shellcheck disable=SC1091
. .env
set +a

# 固定 fixture (Phase 1 と同名、Phase 2 で marketplace 構造に発展済)
BIBLIO_NAME='hello--world'
FIXTURE_DIR="src/biblio/__fixtures__/equipped/${BIBLIO_NAME}"
EXPECTED_MARKER_PREFIX='BIBLIO_EQUIP_M3_P2_MARKER_'

[ -f "${FIXTURE_DIR}/.claude-plugin/marketplace.json" ] || \
  fail "fixture marketplace.json が見つかりません: ${FIXTURE_DIR}/.claude-plugin/marketplace.json"
[ -f "${FIXTURE_DIR}/marker.env" ] || \
  fail "fixture marker.env が見つかりません: ${FIXTURE_DIR}/marker.env"
[ -x "${FIXTURE_DIR}/plugins/biblio-hello/skills/fire-marker/scripts/emit-marker.sh" ] || \
  fail "emit-marker.sh に実行権がない: ${FIXTURE_DIR}/plugins/biblio-hello/skills/fire-marker/scripts/emit-marker.sh"

# marker.env 内の MARKER 文字列を読み取り (= 期待値の正本)
EXPECTED_MARKER="$(grep '^MARKER=' "${FIXTURE_DIR}/marker.env" | head -n1 | cut -d= -f2-)"
[ -n "${EXPECTED_MARKER}" ] || fail "marker.env から MARKER 値を取り出せない"
case "${EXPECTED_MARKER}" in
  "${EXPECTED_MARKER_PREFIX}"*) info "expected marker: ${EXPECTED_MARKER}" ;;
  *) fail "marker.env の MARKER prefix が想定外: ${EXPECTED_MARKER}" ;;
esac

# 直近 harness の stderr 保持用
STDERR_DIR="$(mktemp -d -t biblio-m3p2-stderr-XXXXXX)"
LAST_HARNESS_STDERR=''
trap 'rm -rf "$STDERR_DIR"' EXIT

# --- Phase 1 regression ---
# 引数を透過転送 (= 冒頭の case で検証済の --local-only / --gke-only / 空 を渡す)。
info '=== Phase 1 regression (verify-m3-phase-1.sh) ==='
bash scripts/verify-m3-phase-1.sh "${@}"

# --- Phase A: Docker local 経路 ---
run_local() {
  info '=== Phase A: Docker local (spawn-verify E2E) ==='

  # OneCLI proxy 到達確認 (= verify-m2.sh パターン)
  local onecli_url="${ONECLI_URL:-http://localhost:10254}"
  if ! curl -fsS --max-time 5 "${onecli_url}/v1/agents" >/dev/null 2>&1; then
    fail "OneCLI proxy (${onecli_url}/v1/agents) に到達できません。
    対処: docker compose up -d --wait + scripts/onecli-{vertex,gh}-secret.sh で secret 投入"
  fi

  # container image の存在確認
  if ! docker image inspect nanoclaw-agent:latest >/dev/null 2>&1; then
    fail "container image nanoclaw-agent:latest が存在しません。
    対処: ./container/build.sh で build してから再実行してください
    (Phase 2 では jq + /app/install-biblios.sh が image に焼き込まれている必要があります)"
  fi

  # 必須 env (= spawn-verify ハーネスが OneCLI 経由で Vertex を叩く)
  : "${ANTHROPIC_VERTEX_PROJECT_ID:?ANTHROPIC_VERTEX_PROJECT_ID must be set in .env}"

  local data_dir="${DATA_DIR:-${ROOT}/data}"
  local equip_root="${data_dir}/biblio-equipped"
  local equip_dir="${equip_root}/${BIBLIO_NAME}"

  # 装備源 dir に fixture を投入 (毎回 clean → copy で決定的に)
  info "  - fixture copy → ${equip_dir}/"
  mkdir -p "${equip_root}"
  rm -rf "${equip_dir}"
  cp -r "${FIXTURE_DIR}" "${equip_root}/"

  # 1 回目: spawn-verify → marker 検出
  info "  - spawn-verify (1st run): biblio=${BIBLIO_NAME}"
  LAST_HARNESS_STDERR="$STDERR_DIR/spawn-verify-1.stderr"
  local result_json
  result_json="$(DATA_DIR="${data_dir}" pnpm exec tsx scripts/biblio-equip-spawn-verify.ts "${BIBLIO_NAME}" \
    2>"$LAST_HARNESS_STDERR" | extract_result)"
  [ -n "${result_json}" ] || fail 'spawn-verify ハーネスが RESULT を出さなかった (1st run)'

  local found marker
  found="$(json_field "$result_json" 'marker_found')"
  marker="$(json_field "$result_json" 'marker')"
  [ "${found}" = 'true' ] || fail "marker_found が true にならない (1st run): ${result_json}"
  case "${marker}" in
    "${EXPECTED_MARKER_PREFIX}"*) info "  → marker 検出: ${marker}" ;;
    *) fail "marker prefix が想定外 (1st run): ${marker}" ;;
  esac
  [ "${marker}" = "${EXPECTED_MARKER}" ] || \
    warn "marker 値が marker.env 正本と一致しない (got=${marker}, expected=${EXPECTED_MARKER})"

  # ephemeral 解除確認: container 終了後に host 装備源は残置 (= 次 session 用)
  info '  - ephemeral 解除確認: host 装備源残置 + 中身整合'
  [ -d "${equip_dir}" ] || fail "host 装備源が消えた (= ephemeral の境界違反): ${equip_dir}"
  [ -f "${equip_dir}/.claude-plugin/marketplace.json" ] || \
    fail "host 装備源の marketplace.json が消えた: ${equip_dir}/.claude-plugin/marketplace.json"

  # 2 回目: install 冪等性 (= 同 session で再 spawn しても marker が出る)
  # spawn-verify は agent-shared session で reuse するので、内部で session 再利用 + 再 spawn される
  info "  - spawn-verify (2nd run, install 冪等性確認)"
  LAST_HARNESS_STDERR="$STDERR_DIR/spawn-verify-2.stderr"
  result_json="$(DATA_DIR="${data_dir}" pnpm exec tsx scripts/biblio-equip-spawn-verify.ts "${BIBLIO_NAME}" \
    2>"$LAST_HARNESS_STDERR" | extract_result)"
  [ -n "${result_json}" ] || fail 'spawn-verify ハーネスが RESULT を出さなかった (2nd run)'
  found="$(json_field "$result_json" 'marker_found')"
  [ "${found}" = 'true' ] || fail "2nd run で marker_found が true にならない (install 冪等性違反): ${result_json}"

  info '[Phase A] PASS (Docker local 経路 = spawn → install → SKILL 発火 → marker 検出 → 冪等)'
}

# --- Phase B: GKE 経路 ---
run_gke() {
  info '=== Phase B: GKE (orchestrator Pod 経由 spawn-verify) ==='

  command -v kubectl >/dev/null 2>&1 || fail 'kubectl が見つかりません (PATH を確認してください)'
  if ! kubectl version --client >/dev/null 2>&1; then
    fail 'kubectl の client が動かない'
  fi

  local ns='biblio-claw'
  if ! kubectl get namespace "${ns}" >/dev/null 2>&1; then
    fail "namespace ${ns} が無い (kubectl context を確認: $(kubectl config current-context 2>&1))"
  fi

  local pod='biblio-orchestrator-0'
  local phase
  phase="$(kubectl get pod "${pod}" -n "${ns}" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  [ "${phase}" = 'Running' ] || fail "orchestrator Pod ${pod} が Running でない (現在: ${phase:-不明})"

  # PVC に fixture を投入 (= verify-m3-phase-1.sh と同形、ただし fixture 構造が
  # marketplace に発展済なので tar 経路で一括投入する)
  # 注: 後段の `tar -C /data/biblio-equipped/${BIBLIO_NAME} -xf -` は -C の引数 dir が
  # 既存である前提のため、mkdir で `${BIBLIO_NAME}` まで作る (旧版は親 dir のみ作って
  # 子 dir が無く tar が「No such file or directory」で fail していた、本日 GKE 経路の
  # 初実走で顕在化)。
  info '  - PVC に fixture (marketplace 構造) を投入'
  LAST_HARNESS_STDERR="$STDERR_DIR/kubectl-mkdir.stderr"
  kubectl exec "${pod}" -c orchestrator -n "${ns}" -- \
    bash -c "rm -rf /data/biblio-equipped/${BIBLIO_NAME} && mkdir -p /data/biblio-equipped/${BIBLIO_NAME}" \
    >/dev/null 2>"$LAST_HARNESS_STDERR" \
    || fail "orchestrator Pod 内で mkdir /data/biblio-equipped/${BIBLIO_NAME} に失敗"

  LAST_HARNESS_STDERR="$STDERR_DIR/kubectl-cp-tar.stderr"
  # tar で fixture ツリー全体を Pod に送り込む (kubectl cp は symlink / 実行権を保ちにくいので tar 経路)
  tar -C "${FIXTURE_DIR}" -cf - . 2>"$LAST_HARNESS_STDERR" | \
    kubectl exec -i "${pod}" -c orchestrator -n "${ns}" -- \
    tar -C "/data/biblio-equipped/${BIBLIO_NAME}" -xf - \
    >/dev/null 2>>"$LAST_HARNESS_STDERR" \
    || fail 'kubectl cp (tar 経路) で fixture 投入に失敗'

  # orchestrator Pod 内から spawn-verify を実行
  info "  - spawn-verify を orchestrator Pod 内で実行 (biblio=${BIBLIO_NAME})"
  LAST_HARNESS_STDERR="$STDERR_DIR/kubectl-exec-spawn-verify.stderr"
  local raw
  raw="$(kubectl exec "${pod}" -c orchestrator -n "${ns}" -- \
    pnpm exec tsx scripts/biblio-equip-spawn-verify.ts "${BIBLIO_NAME}" 2>"$LAST_HARNESS_STDERR")" \
    || fail "orchestrator Pod 内で spawn-verify ハーネス実行に失敗 (kubectl exit $?)"
  local result_json
  result_json="$(printf '%s' "${raw}" | extract_result)"
  [ -n "${result_json}" ] || fail 'spawn-verify ハーネス (GKE) が RESULT を出さなかった'

  local found marker
  found="$(json_field "$result_json" 'marker_found')"
  marker="$(json_field "$result_json" 'marker')"
  [ "${found}" = 'true' ] || fail "GKE: marker_found が true にならない: ${result_json}"
  case "${marker}" in
    "${EXPECTED_MARKER_PREFIX}"*) info "  → marker 検出 (GKE): ${marker}" ;;
    *) fail "GKE: marker prefix 想定外: ${marker}" ;;
  esac

  # ephemeral 解除確認 (= PVC 装備源残置)
  # `test -f` exit 1 (ファイル不在) と kubectl exec 接続失敗 (RBAC / Pod 状態) を
  # 分岐できないと「PVC 装備源が消えた」誤誘導になるため、stderr を STDERR_DIR に
  # 保持して fail() でデバッグ表示できるようにする (= 他 kubectl 呼び出しと同形)。
  info '  - GKE: PVC 装備源残置確認'
  LAST_HARNESS_STDERR="$STDERR_DIR/kubectl-exec-test.stderr"
  if ! kubectl exec "${pod}" -c orchestrator -n "${ns}" -- \
    test -f "/data/biblio-equipped/${BIBLIO_NAME}/.claude-plugin/marketplace.json" \
    >/dev/null 2>"$LAST_HARNESS_STDERR"; then
    fail "GKE: PVC 装備源確認に失敗 (= ファイル不在 or kubectl exec 接続失敗): /data/biblio-equipped/${BIBLIO_NAME}/.claude-plugin/marketplace.json"
  fi

  info '[Phase B] PASS (GKE 経路 = spawn-verify が Pod 内で成立 → marker 検出 → PVC 残置)'
}

# --- 実行 ---
[ "${RUN_LOCAL}" -eq 1 ] && run_local
[ "${RUN_GKE}" -eq 1 ]   && run_gke

if [ "${RUN_LOCAL}" -eq 1 ] && [ "${RUN_GKE}" -eq 1 ]; then
  echo 'M3 P2 PASS (both)'
elif [ "${RUN_LOCAL}" -eq 1 ]; then
  echo 'M3 P2 PASS (local)'
else
  echo 'M3 P2 PASS (gke)'
fi
