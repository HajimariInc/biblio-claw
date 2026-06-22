#!/usr/bin/env bash
# biblio-claw: M3 verify スクリプト共通ヘルパ
#
# verify-m3-phase-{1,2,3}.sh + verify-m3.sh の 4 スクリプトで完全に同形だった
# info/warn/fail/extract_result/json_field/json_array_length を 1 ファイルに集約
# (PR #21 code-simplifier 推奨の Phase 横断重複解消)。
#
# 使い方:
#   各 verify script の冒頭 (set -euo pipefail と ROOT 設定の直後) で:
#     # shellcheck source=scripts/verify-m3-helpers.sh
#     source "$(dirname "${BASH_SOURCE[0]}")/verify-m3-helpers.sh"
#
# fail() は `$LAST_HARNESS_STDERR` グローバル変数を参照する (= caller scripts で
# LAST_HARNESS_STDERR='...stderr file path...' を代入してから harness を呼び、失敗時に
# その内容を sed でインデント付き展開する)。LAST_HARNESS_STDERR の初期化と STDERR_DIR
# の mktemp / trap cleanup は各 caller の責務 (= grep 不要、helpers では参照のみ)。

info() { printf '[INFO] %s\n' "$*" >&2; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
fail() {
  printf '[FAIL] %s\n' "$*" >&2
  # 直近 harness の stderr があれば表示 (= verify-m2.sh と同パターン)。
  # tsx コンパイルエラー / kubectl 通信エラー等の根本原因を assert メッセージと
  # 一緒に出せるよう、消費した stderr を 1 つだけ保持して fail 時に sed で展開。
  if [ -n "${LAST_HARNESS_STDERR:-}" ] && [ -s "$LAST_HARNESS_STDERR" ]; then
    printf '[FAIL] 直近 harness の stderr (デバッグ用):\n' >&2
    sed 's/^/    /' "$LAST_HARNESS_STDERR" >&2
  fi
  exit 1
}

# RESULT=<json> 行を stdout から取り出すヘルパ。
extract_result() { sed -n 's/^RESULT=//p'; }

# JSON フィールド取り出し (jq 非依存、node 経由)。
# `<missing>` / `<parse-error>` の literal で戻す (= 上位の文字列比較で扱える)。
# parse 失敗時は **raw 文字列の先頭 200 文字を stderr に出して可視化** する
# (= PR #21 silent-failure-hunter Important の <parse-error> 隠蔽解消、旧実装は catch
# で e を捨てて何が壊れているか追跡コスト高)。
json_field() {
  local json="$1" key="$2"
  printf '%s' "$json" | node -e "
let d='';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(d);
    const k = process.argv[1];
    const v = k.split('.').reduce((acc, p) => acc?.[p], j);
    if (v === undefined || v === null) process.stdout.write('<missing>');
    else process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
  } catch (e) {
    process.stderr.write('[json_field] parse error key=' + process.argv[1] + ' err=' + String(e) + ' raw=' + d.slice(0, 200) + '\n');
    process.stdout.write('<parse-error>');
  }
});
" -- "$key"
}

# JSON 配列フィールドの長さ取り出し。dot-path 解決で深いキーも辿れる。
# 配列でない値が来たら `<not-array>` の sentinel で返す (= integer 比較で噛み合わず可視化される)。
# parse 失敗の stderr 出力は json_field と同形。
json_array_length() {
  local json="$1" key="$2"
  printf '%s' "$json" | node -e "
let d='';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(d);
    const arr = process.argv[1].split('.').reduce((acc, p) => acc?.[p], j);
    process.stdout.write(Array.isArray(arr) ? String(arr.length) : '<not-array>');
  } catch (e) {
    process.stderr.write('[json_array_length] parse error key=' + process.argv[1] + ' err=' + String(e) + ' raw=' + d.slice(0, 200) + '\n');
    process.stdout.write('<parse-error>');
  }
});
" -- "$key"
}
