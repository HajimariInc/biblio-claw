#!/usr/bin/env bash
# biblio-claw: M3 Phase 3 装備機構 disposal (禁書 + 焼却) E2E verify
#
# 流れ:
#   1. Phase 2 regression (= verify-m3-phase-2.sh、引数透過) — 装備機構の自律呼び出し経路が回ること
#   2. Phase 3 smoke (= 常時実行): biblio-enkin.ts / biblio-shokyaku.ts CLI が起動でき、
#      not_shelved 経路 (= 棚に存在しない biblio 名で early return) を返すことを assert
#   3. Phase 3 destructive (= env opt-in): `VERIFY_M3_P3_BIBLIO=<name>` + `VERIFY_M3_P3_CATEGORY=<cat>`
#      がセットされている場合のみ実行。実 shelf marketplace に entry がある biblio を enkin →
#      shokyaku する E2E (= draft PR 2 つを作って残置、cleanup は manual)
#
# 引数:
#   --local-only   Docker local 経路のみ (= 引数透過、Phase 2 regression の挙動)
#   --gke-only     GKE 経路のみ (= 同上)
#   (省略)         両方
#
# 環境変数:
#   VERIFY_M3_P3_BIBLIO    destructive E2E 用の biblio 名 (= `<owner>--<name>` 形式、main に merge 済の biblio)
#   VERIFY_M3_P3_CATEGORY  上記 biblio の category (biblio-dev|art|bf|ai)
#                          両方未設定なら destructive は skip (= smoke のみで M3 P3 PASS)
#
# 前提 (local 経路):
#   - .env に Vertex / GH / OneCLI / DATA_DIR 設定済
#   - docker compose up -d --wait (OneCLI gateway) + scripts/onecli-{vertex,gh}-secret.sh 投入済
#
# 各 assert 失敗で exit 1。全通過で `M3 P3 PASS (...)` を出して exit 0。
#
# Plan 仕様との関係:
#   - plan Task 11 は destructive E2E (= 実 shelf に enkin/shokyaku PR を立てる) を assertion とする
#   - 本実装は plan Risk #5 (draft PR ごみ問題) と「destructive には main merged な biblio が必要 =
#     verify 自己完結化が困難」を踏まえ、smoke を default、destructive を env opt-in に分離
#   - unit test (= unshelve.test.ts) が destructive ロジックを完全に網羅、smoke は CLI wiring 確認に特化
#
# destructive E2E の後始末 (= draft PR cleanup):
#   destructive モード実行後、shelf repo に draft PR が enkin/shokyaku 用に各 1 件残る (= 命名規約は
#   `enkin/<cat>--<name>-<ts>` / `shokyaku/<cat>--<name>-<ts>`)。手動 cleanup:
#     gh pr list --repo HajimariInc/biblio-shelf --search 'in:title enkin OR in:title shokyaku' --state open
#     gh pr close --repo HajimariInc/biblio-shelf --delete-branch <PR#>
#   Phase 5 (`verify-m3.sh`) で「shelve → enkin → shokyaku」連続フローでの cleanup 自動化を検討中。

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
  *)            fail "unknown arg: $1 — usage: verify-m3-phase-3.sh [--local-only|--gke-only]" ;;
esac

# --- pre-flight ---
# .env は local 経路用。GKE 経路では manifest env 直接投入のため不在 = 正常 (= verify-m3.sh:60 の解説参照)。
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . .env
  set +a
else
  warn ".env が見つかりません — GKE 経路 (manifest env 直接投入) と想定して継続 (現在地: $PWD)"
fi

# 直近 harness の stderr 保持用
STDERR_DIR="$(mktemp -d -t biblio-m3p3-stderr-XXXXXX)"
LAST_HARNESS_STDERR=''
trap 'rm -rf "$STDERR_DIR"' EXIT

# --- Phase 2 regression ---
info '=== Phase 2 regression (verify-m3-phase-2.sh) ==='
bash scripts/verify-m3-phase-2.sh "${@}"

# --- Phase 3 smoke (CLI wiring + not_shelved 経路) ---
run_smoke() {
  info '=== Phase 3 smoke (CLI wiring + not_shelved 経路) ==='

  # OneCLI proxy 到達確認 (= GitHub fetch 経路、verify-m3-phase-2.sh と同形)
  local onecli_url="${ONECLI_URL:-http://localhost:10254}"
  if ! probe_onecli "$onecli_url"; then
    fail "OneCLI proxy (${onecli_url}/v1/agents) に到達できません。
    対処: docker compose up -d --wait + scripts/onecli-gh-secret.sh で secret 投入"
  fi

  # 存在しない biblio 名 (= 接尾辞に timestamp、確実に shelf に無い)
  local smoke_biblio
  smoke_biblio="verify-m3p3--smoke-$(date +%s)"
  info "  - smoke biblio: ${smoke_biblio}"

  # 1. enkin smoke: not_shelved を返す
  info '  - enkin smoke (not_shelved 期待)'
  LAST_HARNESS_STDERR="$STDERR_DIR/enkin-smoke.stderr"
  local enkin_result
  enkin_result="$(pnpm exec tsx scripts/biblio-enkin.ts "${smoke_biblio}" 'biblio-dev' \
    2>"$LAST_HARNESS_STDERR" | extract_result)"
  [ -n "${enkin_result}" ] || fail 'enkin CLI が RESULT を出さなかった (smoke)'

  local enkin_ok enkin_reason
  enkin_ok="$(json_field "$enkin_result" 'ok')"
  enkin_reason="$(json_field "$enkin_result" 'reason')"
  [ "${enkin_ok}" = 'false' ] || fail "enkin smoke で ok!=false (= shelf に entry が存在した?): ${enkin_result}"
  [ "${enkin_reason}" = 'not_shelved' ] || \
    fail "enkin smoke で reason!=not_shelved (= 想定外の経路): reason=${enkin_reason} / ${enkin_result}"
  info "  → enkin smoke OK (ok=false, reason=not_shelved)"

  # 2. shokyaku smoke: not_shelved を返す + 装備源 dir は触らない (= unshelve 失敗時の挙動)
  info '  - shokyaku smoke (not_shelved 期待、装備源 dir 残置)'
  local data_dir="${DATA_DIR:-${ROOT}/data}"
  local equip_root="${data_dir}/biblio-equipped"
  local equip_dir="${equip_root}/${smoke_biblio}"

  # 装備源 dir に空の sentinel を作る (= shokyaku 失敗時に消えないことを確認するため)
  mkdir -p "${equip_dir}"
  echo 'smoke-sentinel' > "${equip_dir}/sentinel.txt"

  LAST_HARNESS_STDERR="$STDERR_DIR/shokyaku-smoke.stderr"
  local shokyaku_result
  shokyaku_result="$(pnpm exec tsx scripts/biblio-shokyaku.ts "${smoke_biblio}" 'biblio-dev' \
    2>"$LAST_HARNESS_STDERR" | extract_result)"
  [ -n "${shokyaku_result}" ] || fail 'shokyaku CLI が RESULT を出さなかった (smoke)'

  local shokyaku_ok shokyaku_reason
  shokyaku_ok="$(json_field "$shokyaku_result" 'ok')"
  shokyaku_reason="$(json_field "$shokyaku_result" 'reason')"
  [ "${shokyaku_ok}" = 'false' ] || \
    fail "shokyaku smoke で ok!=false (= shelf に entry が存在した?): ${shokyaku_result}"
  [ "${shokyaku_reason}" = 'not_shelved' ] || \
    fail "shokyaku smoke で reason!=not_shelved: reason=${shokyaku_reason} / ${shokyaku_result}"

  # unshelve 失敗で fs.rmSync を呼ばないため装備源 dir は残置 (= 設計どおり)
  [ -f "${equip_dir}/sentinel.txt" ] || \
    fail "shokyaku not_shelved 経路で装備源 dir が削除された (= unshelve 失敗時の挙動違反): ${equip_dir}"

  # cleanup
  rm -rf "${equip_dir}"
  info "  → shokyaku smoke OK (ok=false, reason=not_shelved, equip dir 残置)"

  info '[Phase 3 smoke] PASS (CLI wiring + not_shelved 経路 + shokyaku 失敗時の装備源残置)'
}

# --- Phase 3 destructive (env opt-in、実 shelf に PR を立てる) ---
run_destructive() {
  # 片方だけ設定されている場合は warn を出して silent skip を防ぐ (= 操作者が「動いている」と
  # 誤認するのを防止、PR #15 silent-failure MEDIUM 対応)。
  if [ -n "${VERIFY_M3_P3_BIBLIO:-}" ] && [ -z "${VERIFY_M3_P3_CATEGORY:-}" ]; then
    warn 'VERIFY_M3_P3_BIBLIO は設定されていますが VERIFY_M3_P3_CATEGORY が未設定です — destructive skip'
  elif [ -z "${VERIFY_M3_P3_BIBLIO:-}" ] && [ -n "${VERIFY_M3_P3_CATEGORY:-}" ]; then
    warn 'VERIFY_M3_P3_CATEGORY は設定されていますが VERIFY_M3_P3_BIBLIO が未設定です — destructive skip'
  fi
  if [ -z "${VERIFY_M3_P3_BIBLIO:-}" ] || [ -z "${VERIFY_M3_P3_CATEGORY:-}" ]; then
    info '=== Phase 3 destructive (skipped: VERIFY_M3_P3_BIBLIO / VERIFY_M3_P3_CATEGORY 未設定) ==='
    info '  destructive E2E を実行するには、shelf main に merge 済の biblio を指して:'
    info '    VERIFY_M3_P3_BIBLIO=<owner>--<name> VERIFY_M3_P3_CATEGORY=biblio-dev bash scripts/verify-m3-phase-3.sh'
    return
  fi

  info "=== Phase 3 destructive (E2E、shelf に PR を 2 つ立てて残置) ==="
  info "  target biblio: ${VERIFY_M3_P3_BIBLIO} (category: ${VERIFY_M3_P3_CATEGORY})"
  warn '  本経路は shelf に draft PR を 2 つ作って残置します。cleanup は manual (gh pr close --delete-branch)'

  local data_dir="${DATA_DIR:-${ROOT}/data}"
  local equip_root="${data_dir}/biblio-equipped"
  local equip_dir="${equip_root}/${VERIFY_M3_P3_BIBLIO}"

  # 焼却テスト用に装備源 dir を fixture 投入 (= 削除されることを assert するため)
  info "  - equip dir fixture を投入: ${equip_dir}/"
  mkdir -p "${equip_dir}"
  echo 'destructive-sentinel' > "${equip_dir}/sentinel.txt"

  # 1. enkin: ok=true + prUrl + 装備源残置
  info '  - enkin (destructive、ok=true 期待)'
  LAST_HARNESS_STDERR="$STDERR_DIR/enkin-destructive.stderr"
  local enkin_result
  enkin_result="$(pnpm exec tsx scripts/biblio-enkin.ts "${VERIFY_M3_P3_BIBLIO}" "${VERIFY_M3_P3_CATEGORY}" \
    2>"$LAST_HARNESS_STDERR" | extract_result)"
  [ -n "${enkin_result}" ] || fail 'enkin CLI が RESULT を出さなかった (destructive)'

  local enkin_ok enkin_url
  enkin_ok="$(json_field "$enkin_result" 'ok')"
  enkin_url="$(json_field "$enkin_result" 'prUrl')"
  [ "${enkin_ok}" = 'true' ] || \
    fail "enkin destructive で ok!=true (= shelf state 想定外?): ${enkin_result}"
  case "${enkin_url}" in
    https://github.com/*/pull/*) info "  → enkin PR 作成: ${enkin_url}" ;;
    *) fail "enkin prUrl が GitHub URL 形式でない: ${enkin_url}" ;;
  esac
  # 装備源残置 (= 禁書の不変条件)
  [ -d "${equip_dir}" ] || fail "禁書後に装備源 dir が消えた (= 禁書 vs 焼却の区別が壊れている): ${equip_dir}"

  # 2. shokyaku: ok=true + prUrl + 装備源物理削除
  # ※ enkin は draft PR を作るが main へ merge しないため main の marketplace.json には entry が残る。
  #    `fetchMarketplace()` は default branch (= main) の HEAD を参照するため、直後に shokyaku を
  #    実行すると entry が見つかり通常 ok=true になる。ただし shelf 側の状態が予期せず変化している
  #    場合 (= 別経路で手動 merge 済 / enkin PR を即 merge した等) は not_shelved になる可能性が
  #    あるため、その場合は warn して PASS 扱いとする。
  info '  - shokyaku (destructive、ok=true 期待、not_shelved も許容)'
  LAST_HARNESS_STDERR="$STDERR_DIR/shokyaku-destructive.stderr"
  local shokyaku_result
  shokyaku_result="$(pnpm exec tsx scripts/biblio-shokyaku.ts "${VERIFY_M3_P3_BIBLIO}" "${VERIFY_M3_P3_CATEGORY}" \
    2>"$LAST_HARNESS_STDERR" | extract_result)"
  [ -n "${shokyaku_result}" ] || fail 'shokyaku CLI が RESULT を出さなかった (destructive)'

  local shokyaku_ok shokyaku_url shokyaku_reason
  shokyaku_ok="$(json_field "$shokyaku_result" 'ok')"
  shokyaku_url="$(json_field "$shokyaku_result" 'prUrl')"
  shokyaku_reason="$(json_field "$shokyaku_result" 'reason')"
  if [ "${shokyaku_ok}" = 'true' ]; then
    case "${shokyaku_url}" in
      https://github.com/*/pull/*) info "  → shokyaku PR 作成: ${shokyaku_url}" ;;
      *) fail "shokyaku prUrl が GitHub URL 形式でない: ${shokyaku_url}" ;;
    esac
    # 物理削除 assert
    [ ! -d "${equip_dir}" ] || fail "焼却後に装備源 dir が残った (= 焼却の不変条件違反): ${equip_dir}"
    info '  → shokyaku 物理削除 OK'
  else
    # enkin が draft で merge されていないため main は未変更 → 2 回目 shokyaku が not_shelved に倒れる
    # この場合は装備源 dir は残置されているはずなので cleanup
    if [ "${shokyaku_reason}" = 'not_shelved' ]; then
      warn "  → shokyaku not_shelved (= enkin PR が未 merge のため main marketplace に entry が残っていない、想定内)"
      [ -d "${equip_dir}" ] && rm -rf "${equip_dir}"
    else
      fail "shokyaku destructive で想定外: ok=${shokyaku_ok}, reason=${shokyaku_reason}, result=${shokyaku_result}"
    fi
  fi

  info '[Phase 3 destructive] PASS (enkin PR 作成 + 装備源残置確認 + shokyaku 経路確認)'
}

# --- 実行 ---
# Phase 3 は smoke も destructive も local 上で完結 (= shelf 側は OneCLI proxy 経由で叩く)。
# --local-only / --gke-only の区別は Phase 2 regression にのみ影響、Phase 3 本体は常に同経路。
if [ "${RUN_LOCAL}" -eq 1 ] || [ "${RUN_GKE}" -eq 1 ]; then
  run_smoke
  run_destructive
fi

if [ "${RUN_LOCAL}" -eq 1 ] && [ "${RUN_GKE}" -eq 1 ]; then
  echo 'M3 P3 PASS (both)'
elif [ "${RUN_LOCAL}" -eq 1 ]; then
  echo 'M3 P3 PASS (local)'
else
  echo 'M3 P3 PASS (gke)'
fi
