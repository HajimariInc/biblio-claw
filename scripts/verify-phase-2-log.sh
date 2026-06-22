#!/usr/bin/env bash
# biblio-claw: Phase 2 (log-implementation) 完成判定 smoke verify
#
# LOG_FORMAT=json モードで以下が成立することを assert:
#   1. host (src/log.ts) の各レベル (info / warn / error / debug) が JSON parse 通る
#   2. JSON 行に必須フィールド (severity / message / time / component) が揃う
#   3. data 内の reserved keys (severity / time / stream) は top-level に混ざらない (drop される)
#   4. shell rotator (scripts/gh-rotate.sh の log_event) が JSON parse 通る形式で出力する
#   5. Error 型が { error_name, error_message, stack } に serialize される
#
# 範疇外 (= Phase 4 deploy-verify で実機検証):
#   - docker compose 経由の host orchestrator stdout 全行 JSON 化 (= host を JSON モードで
#     起動するには docker-compose.yml に LOG_FORMAT=json env 追加が必要、現状 compose は OneCLI +
#     postgres のみで host は `pnpm run dev` 別経路)
#   - K8s 経路の jsonPayload が Cloud Logging Logs Explorer で解析される確認
#
# 各 assert 失敗で exit 1。全通過で "Phase 2 log JSON PASS" を出して exit 0。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

info() { printf '[INFO] %s\n' "$*" >&2; }
ok() { printf '[OK]   %s\n' "$*" >&2; }
fail() {
  printf '[FAIL] %s\n' "$*" >&2
  exit 1
}

# --- pre-flight ---
command -v jq >/dev/null 2>&1 || fail "jq が見つかりません。apt install jq / brew install jq を実行してください。"
command -v node >/dev/null 2>&1 || fail "node が見つかりません。"

# --- assertion 1-3: host src/log.ts の JSON 出力 ---
info 'assertion 1-3: host src/log.ts JSON モード smoke test'

# tsx 経由で src/log.ts を import し、各レベル + reserved key + Error 型を生成。
# stdout (= info/debug) と stderr (= warn/error/fatal) を 1 ストリームに結合して capture。
TMP_OUT=$(mktemp)
trap 'rm -f "$TMP_OUT"' EXIT

LOG_FORMAT=json LOG_COMPONENT=verify-phase-2-log LOG_LEVEL=debug \
  pnpm exec tsx -e "
import { log } from './src/log.ts';
log.info('hello world', { event: 'verify.smoke.info', request_id: 'req-test-001', session_id: 'sess-001' });
log.debug('low level', { event: 'verify.smoke.debug' });
log.warn('warn fired', { event: 'verify.smoke.warn', outcome: 'failure' });
log.error('error fired', { event: 'verify.smoke.error', err: new Error('synthetic boom') });
// reserved keys は drop される (Cloud Logging 予約語と衝突しない)
log.info('reserved key test', { event: 'verify.smoke.reserved', severity: 'OVERRIDE_ATTEMPT', time: 'OVERRIDE_ATTEMPT', stream: 'OVERRIDE_ATTEMPT' });
" >"$TMP_OUT" 2>&1

# 各 JSON 行を抽出 (= 行頭 `{`)。`grep '^{'` で JSON 行のみ取り出す。
JSON_LINES=$(grep '^{' "$TMP_OUT" || true)
[ -n "$JSON_LINES" ] || fail "JSON 行が 1 つも見つかりませんでした (出力):
$(cat "$TMP_OUT")"

# 各行が jq で parse 通る + 必須フィールド (severity / message / time / component) が揃う
LINE_COUNT=0
while IFS= read -r line; do
  LINE_COUNT=$((LINE_COUNT + 1))
  echo "$line" | jq -e '.severity and .message and .time and .component' >/dev/null \
    || fail "assert 必須フィールド欠落 (line $LINE_COUNT): $line"
done <<<"$JSON_LINES"
ok "assertion 1: $LINE_COUNT 行すべて JSON parse + 必須 4 フィールド揃い"

# severity マッピング (= INFO / DEBUG / WARNING / ERROR が出る)。
# 注: jq -e の終了コードは「最後の output 値」を見るため、複数 input + select で非マッチが
#     末尾に来ると exit 4 (= no valid result) を返す罠がある。grep -q で件数を見るほうが堅牢。
echo "$JSON_LINES" | jq -r '.severity' | grep -q '^INFO$' \
  || fail "assert INFO severity 行が見つかりませんでした"
echo "$JSON_LINES" | jq -r '.severity' | grep -q '^DEBUG$' \
  || fail "assert DEBUG severity 行が見つかりませんでした"
echo "$JSON_LINES" | jq -r '.severity' | grep -q '^WARNING$' \
  || fail "assert WARNING severity 行が見つかりませんでした"
echo "$JSON_LINES" | jq -r '.severity' | grep -q '^ERROR$' \
  || fail "assert ERROR severity 行が見つかりませんでした"
ok "assertion 2: severity マッピング (DEBUG/INFO/WARNING/ERROR) すべて確認"

# reserved keys (severity / time / stream) が data 経由で来ても top-level を上書きしない
RESERVED_LINE=$(echo "$JSON_LINES" | jq -c 'select(.event == "verify.smoke.reserved")' | head -1)
[ -n "$RESERVED_LINE" ] || fail "reserved test 行が見つかりませんでした"
echo "$RESERVED_LINE" | jq -e '.severity == "INFO"' >/dev/null \
  || fail "reserved 上書き失敗: severity が OVERRIDE_ATTEMPT に上書きされた (期待: INFO)"
ok "assertion 3: reserved keys (severity/time/stream) は drop されて top-level を保護"

# --- assertion 5: Error 型 serialize ---
ERROR_LINE=$(echo "$JSON_LINES" | jq -c 'select(.event == "verify.smoke.error")' | head -1)
[ -n "$ERROR_LINE" ] || fail "error test 行が見つかりませんでした"
echo "$ERROR_LINE" | jq -e '.err.error_name == "Error" and .err.error_message == "synthetic boom" and (.err.stack | length > 0)' >/dev/null \
  || fail "assert Error type 展開失敗 (line: $ERROR_LINE)"
ok "assertion 5: Error 型が { error_name, error_message, stack } に serialize された"

# --- assertion 4: shell rotator (gh-rotate.sh の log_event) ---
info 'assertion 4: shell rotator log_event JSON 出力 smoke test'
ROTATE_OUT=$(LOG_FORMAT=json LOG_COMPONENT=gh-token-rotator bash -c '
  # gh-rotate.sh の log_event を source で借用 (rotation 本体は実行しない)
  source <(sed -n "/^COMPONENT_NAME=/,/^log() /p" scripts/gh-rotate.sh)
  log_event INFO  rotation.ok      success "smoke test ok"
  log_event ERROR rotation.failed  failure "exit_code=42"
' 2>&1)

[ -n "$ROTATE_OUT" ] || fail "rotator log_event が何も出力しませんでした"
ROTATE_LINES=$(printf '%s\n' "$ROTATE_OUT" | grep '^{' || true)
[ "$(printf '%s\n' "$ROTATE_LINES" | wc -l)" -ge 2 ] \
  || fail "rotator JSON 行が 2 行未満です: $ROTATE_OUT"

# 各行 parse + event / outcome 整合
echo "$ROTATE_LINES" | head -1 | jq -e '.severity == "INFO" and .event == "rotation.ok" and .outcome == "success" and .component == "gh-token-rotator"' >/dev/null \
  || fail "rotator INFO 行 assert 失敗: $(echo "$ROTATE_LINES" | head -1)"
echo "$ROTATE_LINES" | sed -n '2p' | jq -e '.severity == "ERROR" and .event == "rotation.failed" and .outcome == "failure"' >/dev/null \
  || fail "rotator ERROR 行 assert 失敗: $(echo "$ROTATE_LINES" | sed -n '2p')"
ok "assertion 4: shell rotator log_event が JSON 形式 + event/outcome/component で出力"

# --- 全 PASS ---
printf '\n[PASS] Phase 2 log JSON PASS — 5/5 assertion all passed\n'
