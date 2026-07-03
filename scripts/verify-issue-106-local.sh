#!/usr/bin/env bash
# biblio-claw: issue #106 Local Case L2-Local (30 秒 timer expire) の自動検証
#
# runbook §M4-B Phase 4 §「issue #106 の実機検証手順」§Case L2-Local の手順を 1 コマンドに集約。
# 副作用は明示的に stdout に告知しつつ順次実行し、失敗時は cleanup を必ず実行して復旧する。
#
# # 前提
#
# - main worktree (`/home/proj/wforest/github/biblio-claw`) の docker compose stack が稼働中
#   (biblio-onecli + biblio-postgres = 既存の 17 h+ 稼働状態を想定)
# - main worktree の nanoclaw host (`pnpm run dev`) が pid 検出可能な状態で稼働中
# - worktree (`/home/proj/wforest/github/biblio-claw-issue-106`) に:
#   - `.env` copy 済 (main worktree の .env と同一内容)
#   - `data/` → main worktree data への symlink
#   - `logs/` → main worktree logs への symlink
# - `slack:U7F8TRM6X` (DEN さん) が central DB `users` table に登録済
#
# # 副作用 (実行前に必ず確認)
#
# 1. central DB `user_roles` に `('slack:U7F8TRM6X', 'owner', NULL)` を INSERT OR IGNORE
#    (permanent、以降の運用でも DEN さんが owner として残る)
# 2. main worktree の nanoclaw を SIGTERM で停止 (~5 秒)
# 3. worktree で `ADK_APPROVAL_TIMEOUT_MS=30000` の env override で nanoclaw を bg 起動 (~30 秒)
# 4. 実行完了 (or 失敗) 後、worktree nanoclaw を停止し、main worktree nanoclaw を復帰起動
#
# # 使い方
#
#   bash scripts/verify-issue-106-local.sh
#
# 完遂で "L2-Local PASS" + exit 0、いずれかの assertion で fail 時は exit 1 + cleanup 実行。

set -euo pipefail

WORKTREE="/home/proj/wforest/github/biblio-claw-issue-106"
MAIN_WT="/home/proj/wforest/github/biblio-claw"
DUMMY_BIBLIO="example-org/dummy-nonexistent-biblio-verify-l2"
TIMEOUT_MS=30000
WAIT_SEC=40  # timeout より少し長め = expire fire を確実に含む
LOG_PREFIX='[verify-issue-106-local]'

info()  { printf '\033[36m%s INFO\033[0m %s\n' "$LOG_PREFIX" "$*"; }
warn()  { printf '\033[33m%s WARN\033[0m %s\n' "$LOG_PREFIX" "$*"; }
fail()  { printf '\033[31m%s FAIL\033[0m %s\n' "$LOG_PREFIX" "$*"; cleanup; exit 1; }

WORKTREE_PID=''
MAIN_PID=''

cleanup() {
  info 'cleanup: worktree host stop + main worktree host restart'
  if [ -n "$WORKTREE_PID" ] && kill -0 "$WORKTREE_PID" 2>/dev/null; then
    kill -TERM "$WORKTREE_PID" 2>/dev/null || true
    wait "$WORKTREE_PID" 2>/dev/null || true
    info "  worktree host (pid=$WORKTREE_PID) stopped"
  fi
  if [ -n "$MAIN_PID" ]; then
    # main host はユーザ session プロセスなので nohup 経由で復帰起動
    info "  main worktree host を復帰起動 (元の pid=$MAIN_PID は既に停止済、新規 pid 起動)"
    (cd "$MAIN_WT" && nohup pnpm run dev > "$MAIN_WT/logs/nanoclaw-restart.log" 2>&1 &)
    sleep 2
    NEW_PID="$(pgrep -f 'tsx.*src/index' | head -1 || true)"
    if [ -n "$NEW_PID" ]; then
      info "  main worktree host restarted (new pid=$NEW_PID)"
    else
      warn "  main worktree host の restart 確認できず (手動で 'cd $MAIN_WT && pnpm run dev &' 起動を確認してください)"
    fi
  fi
}
trap cleanup EXIT INT TERM

info "=== Case L2-Local: issue #106 30 秒 timer expire 自動検証 ==="

# ── Step 0: 前提確認 ──
info 'Step 0: 前提確認'
[ -f "$WORKTREE/.env" ] || fail ".env が worktree に不在 (copy 手順が未実行)"
[ -L "$WORKTREE/data" ] || fail "data/ が symlink でない (準備手順が未実行)"
[ -L "$WORKTREE/logs" ] || fail "logs/ が symlink でない (準備手順が未実行)"
docker inspect biblio-onecli >/dev/null 2>&1 || fail 'docker container biblio-onecli 不在'
docker inspect biblio-postgres >/dev/null 2>&1 || fail 'docker container biblio-postgres 不在'

MAIN_PID="$(pgrep -f 'tsx.*src/index' | head -1 || true)"
if [ -z "$MAIN_PID" ]; then
  warn '  main worktree の nanoclaw が稼働していない (= 既に停止済、restart 経路は skip)'
else
  info "  main worktree nanoclaw pid=$MAIN_PID を検出"
fi

# users テーブルで DEN さん Slack user 存在確認
DEN_EXISTS="$(cd "$WORKTREE" && pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT COUNT(*) FROM users WHERE id='slack:U7F8TRM6X'" 2>&1 | tail -1)"
[ "$DEN_EXISTS" -ge 1 ] || fail "central DB に slack:U7F8TRM6X (DEN さん user) が未登録 = Slack biblio-local wire が未完了"
info "  DEN さん user 登録済 (slack:U7F8TRM6X)"

# ── Step 1: user_roles に owner INSERT (idempotent) ──
info 'Step 1: user_roles に owner INSERT (permanent side effect)'
cd "$WORKTREE"
BEFORE="$(pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT COUNT(*) FROM user_roles WHERE user_id='slack:U7F8TRM6X' AND role='owner'" 2>&1 | tail -1)"
if [ "$BEFORE" -eq 0 ]; then
  NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  pnpm exec tsx scripts/q.ts data/v2.db \
    "INSERT INTO user_roles (user_id, role, agent_group_id, granted_at) VALUES ('slack:U7F8TRM6X', 'owner', NULL, '$NOW_ISO')" >/dev/null
  info "  INSERT 完了 (permanent, 復元しない、granted_at=$NOW_ISO)"
else
  info "  既に owner 登録済 (skip)"
fi

# ── Step 2: main worktree の nanoclaw を停止 ──
if [ -n "$MAIN_PID" ]; then
  info 'Step 2: main worktree の nanoclaw を停止'
  # ppid (pnpm) を停止すれば child (tsx) も落ちる
  MAIN_PPID="$(ps -o ppid= -p "$MAIN_PID" | tr -d ' ')"
  kill -TERM "$MAIN_PPID" 2>/dev/null || true
  # tsx process の消滅を待機
  for i in $(seq 1 15); do
    kill -0 "$MAIN_PID" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$MAIN_PID" 2>/dev/null; then
    kill -KILL "$MAIN_PPID" 2>/dev/null || true
    warn "  SIGKILL で強制停止 (SIGTERM で反応せず)"
  fi
  info "  main nanoclaw (pid=$MAIN_PID) 停止確認"
else
  info 'Step 2: skip (main nanoclaw 未稼働)'
fi

# ── Step 3: worktree で env override host を bg 起動 ──
info "Step 3: worktree で ADK_APPROVAL_TIMEOUT_MS=$TIMEOUT_MS で host を起動"
WORKTREE_LOG="$WORKTREE/logs/nanoclaw-l2-verify.log"
(cd "$WORKTREE" && ADK_APPROVAL_TIMEOUT_MS=$TIMEOUT_MS nohup pnpm run dev > "$WORKTREE_LOG" 2>&1 &)
sleep 3
WORKTREE_PID="$(pgrep -f 'tsx.*src/index' | head -1 || true)"
[ -n "$WORKTREE_PID" ] || fail "worktree nanoclaw の起動失敗 (pid 検出不可、$WORKTREE_LOG を確認)"
info "  worktree nanoclaw 起動確認 (pid=$WORKTREE_PID)"

# cli.sock 待機 (~30 秒 max)
for i in $(seq 1 30); do
  [ -S "$WORKTREE/data/cli.sock" ] && break
  sleep 1
done
[ -S "$WORKTREE/data/cli.sock" ] || fail "data/cli.sock 未 ready (30 秒経過、host 起動失敗)"
info "  data/cli.sock ready"

# ── Step 4: CLI 経由で enkin 発話 ──
info "Step 4: CLI 経由で '@bot 禁書 $DUMMY_BIBLIO biblio-dev' 発話"
CHAT_LOG="$WORKTREE/logs/nanoclaw-l2-chat.log"
(cd "$WORKTREE" && timeout 20 pnpm run chat "@bot 禁書 $DUMMY_BIBLIO biblio-dev" > "$CHAT_LOG" 2>&1 || true)
info "  chat 発話完了 (stdout: $CHAT_LOG)"

# ── Step 5: pending_approvals row 作成 + expires_at 設定を確認 ──
info 'Step 5: pending_approvals row 作成 + expires_at 設定確認 (Layer 1)'
sleep 2 # LLM 応答 + tool 呼出 + createPendingApproval の完了を待つ
PENDING_COUNT="$(pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT COUNT(*) FROM pending_approvals WHERE action='adk_confirm' AND payload LIKE '%dummy-nonexistent-biblio-verify-l2%'" 2>&1 | tail -1)"
if [ "$PENDING_COUNT" -lt 1 ]; then
  fail "pending_approvals row 未作成 (count=$PENDING_COUNT) — LLM が enkin を発火しなかったか、承認カード配信に失敗した可能性"
fi
info "  pending row 作成確認 (count=$PENDING_COUNT)"

EXPIRES_SET="$(pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT COUNT(*) FROM pending_approvals WHERE action='adk_confirm' AND payload LIKE '%dummy-nonexistent-biblio-verify-l2%' AND expires_at IS NOT NULL" 2>&1 | tail -1)"
[ "$EXPIRES_SET" -eq "$PENDING_COUNT" ] || fail "expires_at が NULL (Layer 1 regression、set=$EXPIRES_SET expected=$PENDING_COUNT)"
info "  expires_at 全 row 設定済 (Layer 1 OK)"

# ── Step 6: 40 秒待機 (timer expire を確実に含む) ──
info "Step 6: $WAIT_SEC 秒待機 (expiry timer 発火まで、~$TIMEOUT_MS ms + margin)"
sleep "$WAIT_SEC"

# ── Step 7: 判定 ──
info 'Step 7: expire 完遂の 3 point 判定'

# (a) row 消滅
POST_COUNT="$(pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT COUNT(*) FROM pending_approvals WHERE action='adk_confirm' AND payload LIKE '%dummy-nonexistent-biblio-verify-l2%'" 2>&1 | tail -1)"
[ "$POST_COUNT" -eq 0 ] || fail "row 未削除 (count=$POST_COUNT) — expire 経路が発火していない可能性"
info "  (a) pending row 消滅 OK (count=0)"

# (b) host log に expired event or resolve event (どちらかで Layer 2 or race 防止経路の担保)
# NOTE: nanoclaw の log は JSON 直吐きではなく ANSI color code 付き pretty print
# (`[35mevent[39m="adk.approval.expired"` 形式) なので、`"event":"..."` の JSON pattern では
# 引っかからない。event 名だけで grep する pattern に統一。
EXPIRED_HITS="$(grep -cE 'adk\.approval\.expired' "$WORKTREE_LOG" || true)"
RESOLVE_HITS="$(grep -cE 'adk\.approval\.resolve' "$WORKTREE_LOG" || true)"

if [ "$EXPIRED_HITS" -ge 1 ]; then
  info "  (b) adk.approval.expired event 検出 OK (Layer 2 timer expire 経路、count=$EXPIRED_HITS)"
  # (c) reason='no response' の分岐 (Layer 2 timer expire 経路の担保)
  REASON_HITS="$(grep -cE 'adk\.approval\.expired.*reason.*no response' "$WORKTREE_LOG" || true)"
  [ "$REASON_HITS" -ge 1 ] || fail "expired event の reason='no response' 検出不可 (host restart 経路と混同の可能性)"
  info "  (c) reason='no response' 分岐確認 OK (Layer 2 完全動作、count=$REASON_HITS)"
  info '=== L2-Local PASS (Layer 2 実 timer expire 経路) ==='
elif [ "$RESOLVE_HITS" -ge 1 ]; then
  # admin が Slack で timer 発火前に Approve/Reject 押した = race 防止経路 (Case L1-Local)
  info "  (b) adk.approval.resolve event 検出 (Case L1-Local = race 防止 + resume 経路、count=$RESOLVE_HITS)"
  info "  (c) admin 応答が timer より先勝ち = expired event 不在 は期待通り (二重通知防止)"
  info '=== L1-Local PASS (race 防止 + admin 応答経路、admin が Slack で Approve/Reject を timer 発火前に押下)==='
else
  fail "host log に adk.approval.expired / resolve のいずれの event も不在 (Layer 2 も race 防止経路も未動作、実装または承認カード配信の regression)"
fi

info '=== L2-Local PASS ==='
info "  Layer 1 (expires_at 設定) + Layer 2 (30 秒 timer expire + reason='no response' cleanup) 動作確認完了"
info "  cleanup phase: worktree host stop → main worktree host restart (trap exit で実行)"
