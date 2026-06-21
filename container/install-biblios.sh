#!/usr/bin/env bash
# /app/install-biblios.sh — agent-container spawn-time biblio install
# (M3 Phase 2 = ephemeral spawn-time install + M9 遵守)
#
# /workspace/biblios/*/ を loop して各 biblio を `--scope user` で install する。
# install は idempotent (= claude CLI 側が既登録/既 install を検知)、enable は
# 既 enable で non-zero exit になるため `|| true` で握る。
# 装備リストが空 (= /workspace/biblios/ が空ディレクトリ or 不在) の場合は no-op で終了。
#
# 出力 log は >&2 に流し、agent-runner の stdout を汚さない。
# 失敗時は set -euo pipefail で fail-fast。ただし `enable` の既 enable 想定 non-zero
# だけは `|| true` で握る (= 冪等動作)。
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

  # marketplace add は idempotent (既登録なら no-op or warn)
  echo "[install-biblios] marketplace add: ${biblio_dir} (name=${marketplace_name})" >&2
  claude plugin marketplace add "${biblio_dir}" 2>&1 | sed 's/^/[install-biblios] /' >&2 || true

  # marketplace.json の plugins[].name を順に install + enable
  while IFS= read -r plugin_name; do
    [ -z "${plugin_name}" ] && continue
    echo "[install-biblios] install: ${plugin_name}@${marketplace_name}" >&2
    claude plugin install "${plugin_name}@${marketplace_name}" --scope user \
      2>&1 | sed 's/^/[install-biblios] /' >&2
    echo "[install-biblios] enable: ${plugin_name}" >&2
    claude plugin enable "${plugin_name}" \
      2>&1 | sed 's/^/[install-biblios] /' >&2 || true
  done < <(jq -r '.plugins[].name' "${manifest}")
done

echo "[install-biblios] done" >&2
exit 0
