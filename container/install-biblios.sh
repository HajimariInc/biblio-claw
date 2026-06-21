#!/usr/bin/env bash
# /app/install-biblios.sh — agent-container spawn-time biblio install
# (M3 Phase 2 = ephemeral spawn-time install + M9 遵守)
#
# /workspace/biblios/*/ を loop して各 biblio を `--scope user` で install する。
# 装備リストが空 (= /workspace/biblios/ が空ディレクトリ or 不在) の場合は no-op で終了。
#
# 冪等性ポリシー (= 何度呼んでも安全に動くための失敗ハンドリング):
#   - `marketplace add`: 既登録で warn を出すが exit 0 を返す観測実績がある一方、
#     CLI バージョン差で non-zero exit する可能性も残る → `|| true` で握る。
#     失敗 (manifest invalid 等) は後続 `install` が「marketplace not found」で
#     fail-fast するので、ここで silent failure になっても症状は捕捉される。
#   - `install --scope user`: 既 install 時の exit code 挙動は CLI が「冪等で
#     exit 0」を保証している前提。**意図的に `|| true` を付けない** = install 経路で
#     non-zero exit したら set -e で fail-fast (= 装備失敗でコンテナを起動しない)。
#     コンテナ無音起動失敗を防ぐため、symptom (= install 失敗) を症状として表出させる。
#   - `enable`: 既 enable で確実に non-zero exit する観測実績 → `|| true` で握る (= 冪等)。
#
# 出力 log は >&2 に流し、agent-runner の stdout を汚さない。
set -euo pipefail

EQUIP_ROOT='/workspace/biblios'

if [ ! -d "${EQUIP_ROOT}" ]; then
  echo "[install-biblios] ${EQUIP_ROOT} not present, skipping (no equipped biblios)" >&2
  exit 0
fi

shopt -s nullglob
biblio_dirs=("${EQUIP_ROOT}"/*/)

if [ "${#biblio_dirs[@]}" -eq 0 ]; then
  echo "[install-biblios] ${EQUIP_ROOT} is empty, skipping (no equipped biblios)" >&2
  exit 0
fi

for biblio_dir in "${biblio_dirs[@]}"; do
  biblio_dir="${biblio_dir%/}"
  manifest="${biblio_dir}/.claude-plugin/marketplace.json"

  if [ ! -f "${manifest}" ]; then
    echo "[install-biblios] skip ${biblio_dir}: marketplace.json not found" >&2
    continue
  fi

  marketplace_name="$(jq -r '.name' "${manifest}")"
  if [ -z "${marketplace_name}" ] || [ "${marketplace_name}" = 'null' ]; then
    echo "[install-biblios] skip ${biblio_dir}: marketplace name missing in manifest" >&2
    continue
  fi

  # marketplace add は冪等想定だが CLI バージョン差で non-zero exit する可能性を
  # 握る。失敗時は install が「marketplace not found」で fail-fast するので silent
  # failure にはならない (= 症状を install 段で表出させる設計、冒頭の冪等性ポリシー参照)。
  echo "[install-biblios] marketplace add: ${biblio_dir} (name=${marketplace_name})" >&2
  claude plugin marketplace add "${biblio_dir}" 2>&1 | sed 's/^/[install-biblios] /' >&2 || true

  # marketplace.json の plugins[].name を順に install + enable。
  # `< <(jq ...)` は process substitution: `jq ... | while` だと while body が
  # subshell になり外側スコープに変更が伝わらない (= continue/break が外側 for に
  # 届かない) ため、必ず process substitution を使う。
  while IFS= read -r plugin_name; do
    [ -z "${plugin_name}" ] && continue
    echo "[install-biblios] install: ${plugin_name}@${marketplace_name}" >&2
    # install は意図的に `|| true` なし = 既 install で non-zero ならその時点で
    # fail-fast (= 装備失敗をコンテナ起動失敗として表出、冪等性ポリシー参照)。
    claude plugin install "${plugin_name}@${marketplace_name}" --scope user \
      2>&1 | sed 's/^/[install-biblios] /' >&2
    echo "[install-biblios] enable: ${plugin_name}" >&2
    claude plugin enable "${plugin_name}" \
      2>&1 | sed 's/^/[install-biblios] /' >&2 || true
  done < <(jq -r '.plugins[].name' "${manifest}")
done

echo "[install-biblios] done" >&2
exit 0
