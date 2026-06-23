#!/usr/bin/env bash
# biblio-claw: M3 Phase 1 装備機構物理配置 verify
#
# 装備済み biblio (Phase 1 は mock fixture `hello--world`) が
# `<DATA_DIR>/biblio-equipped/<name>/` に物理配置され、agent-container 内の
# `/workspace/biblios/<name>/marker.txt` から marker 文字列が読めることを
# 確認する。Phase 1 では agent-container spawn は行わず、host 側から marker
# を直接読む経路で「物理経路成立」のみを assert する (agent-runner / claude CLI
# 経由は Phase 2 で実装)。
#
# 引数:
#   --local-only   Docker local 経路のみ実行 (= DATA_DIR 直読み)
#   --gke-only     GKE 経路のみ実行 (= orchestrator Pod 経由 PVC 直読み)
#   (省略)         両方実行
#
# 各 assert 失敗で exit 1。全通過で "M3 P1 PASS" を出して exit 0。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# info/warn/fail は verify-m3-helpers.sh に集約 (PR #21 code-simplifier 推奨)。
# shellcheck source=scripts/verify-m3-helpers.sh
source "$(dirname "${BASH_SOURCE[0]}")/verify-m3-helpers.sh"

# --- 引数 parse ---
RUN_LOCAL=1
RUN_GKE=1
case "${1:-}" in
  --local-only) RUN_GKE=0 ;;
  --gke-only)   RUN_LOCAL=0 ;;
  '')           ;;
  *)            fail "unknown arg: $1 — usage: verify-m3-phase-1.sh [--local-only|--gke-only]" ;;
esac

# --- pre-flight ---
[ -f .env ] || fail ".env が見つかりません — repo root で実行してください (現在地: $PWD)"

set -a
# shellcheck disable=SC1091
. .env
set +a

# 固定 fixture (Phase 1)
BIBLIO_NAME='hello--world'
FIXTURE_DIR="src/biblio/__fixtures__/equipped/${BIBLIO_NAME}"
EXPECTED_MARKER_PREFIX='BIBLIO_EQUIP_M3_P1_MARKER_'

[ -f "${FIXTURE_DIR}/marker.txt" ] || fail "fixture が見つかりません: ${FIXTURE_DIR}/marker.txt"

# 直近 harness の stderr 保持用 (verify-m2.sh パターン)。fail() で表示。
STDERR_DIR="$(mktemp -d -t biblio-m3-stderr-XXXXXX)"
LAST_HARNESS_STDERR=''
trap 'rm -rf "$STDERR_DIR"' EXIT

# --- Phase A: Docker local 経路 ---
run_local() {
  info '=== Phase A: Docker local (DATA_DIR 直読み) ==='
  local data_dir="${DATA_DIR:-${ROOT}/data}"
  local equip_root="${data_dir}/biblio-equipped"

  # 書込可能性確認
  mkdir -p "${equip_root}" || fail "DATA_DIR/biblio-equipped を作れない: ${equip_root}"
  if ! touch "${equip_root}/.write-probe" 2>/dev/null; then
    fail "DATA_DIR/biblio-equipped が書き込めない: ${equip_root}"
  fi
  rm -f "${equip_root}/.write-probe"

  # fixture を投入 (毎回 clean → copy で決定的に)
  info "  - fixture copy → ${equip_root}/${BIBLIO_NAME}/"
  rm -rf "${equip_root}/${BIBLIO_NAME}"
  cp -r "${FIXTURE_DIR}" "${equip_root}/"

  # unit test との整合確認 (stderr を保持して fail 時に表示する)
  info '  - unit test (equip.test.ts + container-runner.test.ts) 実行'
  LAST_HARNESS_STDERR="$STDERR_DIR/unit-test.stderr"
  pnpm test src/biblio/equip.test.ts src/container-runner.test.ts \
    >/dev/null 2>"$LAST_HARNESS_STDERR" \
    || fail 'unit test (equip + container-runner) が通らない — Phase 1 物理経路の前提が崩れている'

  # mount-check ハーネス実行 — stderr は STDERR_DIR に保持
  info "  - mount-check ハーネス: biblio=${BIBLIO_NAME}"
  LAST_HARNESS_STDERR="$STDERR_DIR/mount-check.stderr"
  local result_json
  result_json="$(DATA_DIR="${data_dir}" pnpm exec tsx scripts/biblio-equip-mount-check.ts "${BIBLIO_NAME}" \
    2>"$LAST_HARNESS_STDERR" | sed -n 's/^RESULT=//p')"
  [ -n "${result_json}" ] || fail 'mount-check ハーネスが RESULT を出さなかった'

  # marker_found + marker を 1 度の node 呼び出しで tab 区切り取得。
  # marker 文字列にスペースが入っても破れないよう IFS=$'\t' で受ける。
  # node 側で末尾に '\n' を付けるのは `read` が EOF を non-zero 終了として扱い
  # `set -e` で silent kill されるのを防ぐため (= read は newline で正常終了する)。
  local found marker
  IFS=$'\t' read -r found marker < <(printf '%s' "${result_json}" | node -e "
let d='';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  const j = JSON.parse(d);
  process.stdout.write(String(j.marker_found) + '\t' + (j.marker || '') + '\n');
});")
  [ "${found}" = 'true' ] || fail "marker_found が true にならない: ${result_json}"
  case "${marker}" in
    "${EXPECTED_MARKER_PREFIX}"*) info "  → marker 検出: ${marker}" ;;
    *) fail "marker prefix が想定外: ${marker}" ;;
  esac

  info '[Phase A] PASS (Docker local 経路 = DATA_DIR 直読みで marker 検出)'
}

# --- Phase B: GKE 経路 ---
run_gke() {
  info '=== Phase B: GKE (orchestrator Pod 経由 PVC 直読み) ==='

  command -v kubectl >/dev/null 2>&1 || fail 'kubectl が見つかりません (PATH を確認してください)'
  if ! kubectl version --client >/dev/null 2>&1; then
    fail 'kubectl の client が動かない'
  fi

  local ns='biblio-claw'
  if ! kubectl get namespace "${ns}" >/dev/null 2>&1; then
    fail "namespace ${ns} が無い (kubectl context を確認: $(kubectl config current-context 2>&1))"
  fi

  # orchestrator Pod の起動確認
  local pod='biblio-orchestrator-0'
  local phase
  phase="$(kubectl get pod "${pod}" -n "${ns}" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  [ "${phase}" = 'Running' ] || fail "orchestrator Pod ${pod} が Running でない (現在: ${phase:-不明})"

  # PVC に fixture 投入: orchestrator container 側で mkdir → kubectl cp
  # 各 kubectl コマンドの stderr は STDERR_DIR に保持して fail 時に表示する。
  # 注: 旧版は `.claude-plugin/marker.json` も kubectl cp していたが、M3 Phase 2 で
  # fixture が marker.env + marker.txt + plugins/ (marketplace 構造) に発展した際に
  # marker.json は廃止された (実在ファイル: marker.env + marker.txt のみ)。後段の
  # `kubectl exec cat marker.txt` で marker prefix を検証するため、Phase 1 GKE 経路
  # としては marker.txt の投入 + 読み取りで十分 (= verify-m3-phase-2.sh は tar 経路で
  # marketplace 構造一式を投入する別経路で扱う)。
  info '  - PVC に fixture を投入'
  LAST_HARNESS_STDERR="$STDERR_DIR/kubectl-mkdir.stderr"
  kubectl exec "${pod}" -c orchestrator -n "${ns}" -- \
    mkdir -p "/data/biblio-equipped/${BIBLIO_NAME}" \
    >/dev/null 2>"$LAST_HARNESS_STDERR" \
    || fail "orchestrator Pod 内で mkdir /data/biblio-equipped/${BIBLIO_NAME} に失敗"

  LAST_HARNESS_STDERR="$STDERR_DIR/kubectl-cp-marker.stderr"
  kubectl cp \
    "${FIXTURE_DIR}/marker.txt" \
    "${pod}:/data/biblio-equipped/${BIBLIO_NAME}/marker.txt" \
    -c orchestrator -n "${ns}" \
    >/dev/null 2>"$LAST_HARNESS_STDERR" \
    || fail 'kubectl cp marker.txt が失敗'

  # orchestrator Pod 内から marker を直接読む (PVC subPath 経路の verify)
  # kubectl exec 自体の失敗と marker 内容の不一致を区別するため、`|| true` ではなく
  # `|| fail` で握り (kubectl cp と対称な非無視ハンドリング)、stderr は STDERR_DIR に保持する。
  info '  - orchestrator Pod 経由 marker 読み'
  LAST_HARNESS_STDERR="$STDERR_DIR/kubectl-exec-cat.stderr"
  local raw_marker
  raw_marker="$(kubectl exec "${pod}" -c orchestrator -n "${ns}" -- \
    cat "/data/biblio-equipped/${BIBLIO_NAME}/marker.txt" 2>"$LAST_HARNESS_STDERR")" \
    || fail 'kubectl exec cat marker.txt が失敗 (kubectl 接続 / 権限 / Pod 状態を確認)'
  local marker
  marker="$(printf '%s' "${raw_marker}" | tr -d '\r\n')"
  case "${marker}" in
    "${EXPECTED_MARKER_PREFIX}"*) info "  → marker 検出: ${marker}" ;;
    *) fail "GKE 経路で marker prefix 不一致: '${marker}'" ;;
  esac

  # NetworkPolicy 適用確認 (拡張不要 = agent label に既存 policy が当たる)
  info '  - NetworkPolicy biblio-agent-egress 確認'
  if ! kubectl get networkpolicy -n "${ns}" biblio-agent-egress >/dev/null 2>&1; then
    fail 'NetworkPolicy biblio-agent-egress が見つからない'
  fi
  local selector
  selector="$(kubectl get networkpolicy biblio-agent-egress -n "${ns}" \
    -o jsonpath='{.spec.podSelector.matchLabels.app\.kubernetes\.io/component}' 2>/dev/null || true)"
  [ "${selector}" = 'agent' ] \
    || warn "NetworkPolicy podSelector が component=agent でない (実値: ${selector:-空}) — agent label への適用を要確認"

  info '[Phase B] PASS (GKE 経路 = PVC 直読みで marker 検出)'
}

# --- 実行 ---
[ "${RUN_LOCAL}" -eq 1 ] && run_local
[ "${RUN_GKE}" -eq 1 ]   && run_gke

if [ "${RUN_LOCAL}" -eq 1 ] && [ "${RUN_GKE}" -eq 1 ]; then
  echo 'M3 P1 PASS (both)'
elif [ "${RUN_LOCAL}" -eq 1 ]; then
  echo 'M3 P1 PASS (local)'
else
  echo 'M3 P1 PASS (gke)'
fi
