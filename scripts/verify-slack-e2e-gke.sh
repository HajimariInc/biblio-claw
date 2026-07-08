#!/usr/bin/env bash
# biblio-claw: Phase 6 (slack-e2e-verify) 本番 GKE + Slack ws E2E verify (半自動)
#
# init-project-gcp PRD Phase 6 の最終ゴール: 本番 Slack ws (biblio-slack-app) で
# `@bot 仕入れて owner/repo` → PR URL までの 1 周を半自動 polling 検証する。
#
# 半自動の意味: patron が手で 2 回投稿する (初回 `@bot 仕入れて o/r` + categorize 応答後の
# 「はい」)、script はその合間で kubectl exec node -e による inbound.db 直読み polling と
# PR URL 抽出 + cleanup を担う。完全自動化 (Bot/User Token 経由の chat.postMessage) は
# 将来 Phase 6.5 or 別 PRD の領域 (= Plan §Out of Scope、自分の post に bot が反応しない
# Slack の制約への対処を含むため別建て)。
#
# 引数:
#   --dry-run            pre-flight のみで exit 0 (Section A 以降を skip)
#   --skip-slack-check   Section F (outbound + delivered の Slack 配信補助確認) を skip
#   --help               usage を表示して exit 0
#
# 環境変数 (必須、未設定で fail-fast):
#   SHELF_REPO_OWNER     棚 repo owner (= cleanup の gh pr close で使用)
#   SHELF_REPO_NAME      棚 repo name
#
# 環境変数 (任意、default あり):
#   TARGET_REPO          仕入れ対象 (default: example-org/test-biblio-minimal)
#
# 前提:
#   - kubectl context = gke_*_biblio-prod
#   - StatefulSet biblio-orchestrator readyReplicas=1 + Pod phase=Running
#   - 本番 Slack ws (biblio-slack-app) の token が K8s Secret biblio-slack-tokens に投入済
#   - first-agent の Slack channel wiring 済 (= scripts/init-first-agent-gke.sh 実行済)
#   - gh CLI が認証済 (cleanup の gh pr close で使用)
#
# 後始末 (cleanup trap):
#   - 作成された draft PR を gh pr close --delete-branch
#   - shelf 物理ファイル (/data/shelf/*/<biblio>) + quarantine (/data/quarantine/<biblio>) を rm
#   - $STDERR_DIR を rm -rf
#
# 全段 PASS で `Phase 6 PASS (Slack E2E GKE) — PR URL=...` を出して exit 0。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# info/warn/fail/probe_onecli は verify-m3-helpers.sh に集約。ok() のみ局所定義
# (= verify-phase-4-deploy.sh:44 と同流儀、helpers には ok がない)。
# shellcheck source=scripts/verify-m3-helpers.sh
source "$(dirname "${BASH_SOURCE[0]}")/verify-m3-helpers.sh"
ok() { printf '[OK]   %s\n' "$*" >&2; }

NS='biblio-claw'
ORCH_POD='biblio-orchestrator-0'

print_usage() {
  cat <<'EOF'
Usage: bash scripts/verify-slack-e2e-gke.sh [OPTIONS]

本番 GKE + Slack ws (biblio-slack-app) で acquire → shelve → PR URL までの 1 周を
半自動 polling で verify する。

Options:
  --dry-run            pre-flight のみで exit 0 (Section A 以降を skip)
  --skip-slack-check   Section F (Slack 配信補助確認) を skip
  --help               この usage を表示して exit 0

Required env:
  SHELF_REPO_OWNER     棚 repo owner (cleanup で使用)
  SHELF_REPO_NAME      棚 repo name

Optional env:
  TARGET_REPO          仕入れ対象 (default: example-org/test-biblio-minimal)

Example:
  SHELF_REPO_OWNER=HajimariInc SHELF_REPO_NAME=biblio-shelf \
    bash scripts/verify-slack-e2e-gke.sh
EOF
}

# --- 引数 parse ---
DRY_RUN=0
SKIP_SLACK_CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-slack-check) SKIP_SLACK_CHECK=1 ;;
    --help|-h) print_usage; exit 0 ;;
    *) print_usage; fail "unknown arg: $1" ;;
  esac
  shift
done

# --- pre-flight: .env 読み込み (warn 継続) ---
# .env は local 経路 (= docker compose で host から env を渡す) のもの。GKE 経路では
# manifest 経由で orchestrator container に env を直接投入する設計のため `.env` 不在は
# warn 継続で十分 (= verify-m3.sh:65-72 と同流儀、Phase 4.6 bug 6 fix と整合)。
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . .env
  set +a
else
  warn ".env が見つかりません — GKE 経路 (manifest env 直接投入) と想定して継続 (現在地: $PWD)"
fi

# --- pre-flight: 必須 env ---
: "${SHELF_REPO_OWNER:?SHELF_REPO_OWNER must be set (cleanup の gh pr close --repo で使用)}"
: "${SHELF_REPO_NAME:?SHELF_REPO_NAME must be set}"
TARGET_REPO="${TARGET_REPO:-example-org/test-biblio-minimal}"

info "==== Phase 6 Slack E2E GKE verify (namespace=$NS, target=$TARGET_REPO) ===="

# --- pre-flight: コマンド存在確認 ---
command -v kubectl >/dev/null 2>&1 || fail "[pre-flight] kubectl が見つかりません (PATH を確認)"
command -v node    >/dev/null 2>&1 || fail "[pre-flight] node が見つかりません (PATH を確認)"
command -v gh      >/dev/null 2>&1 || fail "[pre-flight] gh CLI が見つかりません (cleanup で使用、PATH を確認)"

# --- pre-flight: kubectl context gate ---
ctx="$(kubectl config current-context 2>/dev/null || echo '<none>')"
case "$ctx" in
  gke_*_biblio-prod) ok "[ctx] $ctx" ;;
  *) fail "[ctx] kubectl context が biblio-prod ではない (= $ctx)。実行: gcloud container clusters get-credentials biblio-prod --region=asia-northeast1 --project=<your-gcp-project>" ;;
esac

# --- pre-flight: orchestrator StatefulSet ready ---
ready="$(kubectl get statefulset biblio-orchestrator -n "$NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)"
[ "$ready" = "1" ] || fail "[orchestrator] StatefulSet readyReplicas != 1 (actual=$ready)。kubectl describe statefulset biblio-orchestrator -n $NS で原因確認"
ok "[orchestrator] StatefulSet ready=$ready"

# --- pre-flight: Pod phase Running ---
phase="$(kubectl get pod "$ORCH_POD" -n "$NS" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
[ "$phase" = "Running" ] || fail "[orchestrator] Pod $ORCH_POD が Running でない (現在: ${phase:-不明})。kubectl describe pod $ORCH_POD -n $NS で確認"
ok "[orchestrator] Pod $ORCH_POD phase=$phase"

# --- pre-flight: STDERR_DIR + LAST_HARNESS_STDERR 初期化 ---
# helpers の fail() が LAST_HARNESS_STDERR を参照、kubectl exec の stderr を都度捕捉する。
STDERR_DIR="$(mktemp -d -t verify-slack-e2e-XXXXXX)"
LAST_HARNESS_STDERR=''

# --- pre-flight: OneCLI probe via orchestrator Pod ---
# orchestrator container 内から ONECLI_URL に到達できることを確認 (= pod 内 fetch)。
# helpers の probe_onecli は host 側 (localhost) 用なので kubectl exec で代用。
LAST_HARNESS_STDERR="$STDERR_DIR/onecli-probe.stderr"
if ! kubectl exec "$ORCH_POD" -c orchestrator -n "$NS" -- node -e "
  fetch(process.env.ONECLI_URL + '/v1/agents', { signal: AbortSignal.timeout(5000) })
    .then(r => process.exit(r.ok ? 0 : 1))
    .catch(() => process.exit(1));
" 2>"$LAST_HARNESS_STDERR"; then
  fail "[onecli] orchestrator Pod 内から OneCLI proxy への到達失敗。kubectl logs $ORCH_POD -n $NS -c onecli で原因確認"
fi
ok "[onecli] orchestrator Pod 内 OneCLI 到達確認"

# --- cleanup trap (= shelve PR close + shelf 物理ファイル rm + STDERR_DIR) ---
CREATED_PR_NUMBER=""
BIBLIO_NAME=""

cleanup() {
  local exit_code=$?
  if [ -n "$CREATED_PR_NUMBER" ]; then
    info "cleanup: closing draft PR #$CREATED_PR_NUMBER on $SHELF_REPO_OWNER/$SHELF_REPO_NAME"
    if ! gh pr close --repo "$SHELF_REPO_OWNER/$SHELF_REPO_NAME" --delete-branch "$CREATED_PR_NUMBER" >/dev/null 2>&1; then
      warn "draft PR close 失敗: #$CREATED_PR_NUMBER (gh 認証 / 権限を確認、手動で close してください)"
    fi
  fi
  if [ -n "$BIBLIO_NAME" ]; then
    info "cleanup: removing shelf/quarantine for $BIBLIO_NAME"
    # `*` glob は Pod 内 bash で展開させる (= host shell では quote 内のため非展開)。
    # 失敗は warn 継続 (= cleanup ベストエフォート、本体 exit code には影響させない)。
    if ! kubectl exec "$ORCH_POD" -c orchestrator -n "$NS" -- \
      bash -c "rm -rf /data/shelf/*/${BIBLIO_NAME} /data/quarantine/${BIBLIO_NAME} || true" \
      >/dev/null 2>&1; then
      warn "shelf/quarantine cleanup 失敗 (手動 rm 推奨)"
    fi
  fi
  rm -rf "$STDERR_DIR"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

# --- dry-run 早期 exit ---
if [ "$DRY_RUN" = "1" ]; then
  ok "[dry-run] pre-flight all OK, skipping Section A-F"
  exit 0
fi

# === Section A: 本番 Slack ws での初回投稿 (interactive) ===
info ""
info "==============================================================="
info "Section A: 本番 Slack ws での初回投稿"
info "==============================================================="
info ""
info "本番 Slack ws (= biblio-slack-app workspace) で次を biblio bot 宛て mention で投稿してください:"
info ""
info "    @biblio 仕入れて ${TARGET_REPO}"
info ""
info "(channel は wiring 済の channel、bot は agent group 配線済の biblio bot)"
info ""
read -r -p "[ACTION REQUIRED] 投稿が完了したら Enter を押してください: " _
ok "[section-a] 初回投稿の OK を受領"

# === Section B: agent 起床 + 投稿到達 polling (60s) ===
# 最新 session の inbound.db.messages_in で `trigger=1` + content text に TARGET_REPO を
# 含む行を polling。検出失敗は engage 不発 / wiring / adapter 疎通の問題を示唆。
info ""
info "[section-b] agent 起床 + 投稿到達を待機 (timeout 60s)..."
LAST_HARNESS_STDERR="$STDERR_DIR/section-b.stderr"
section_b_hit=''
for _ in $(seq 1 12); do
  section_b_hit="$(kubectl exec "$ORCH_POD" -c orchestrator -n "$NS" -- node -e "
    const Database = require('better-sqlite3');
    const central = new Database('/data/v2.db', { readonly: true });
    const sess = central.prepare('SELECT id, agent_group_id FROM sessions ORDER BY rowid DESC LIMIT 1').get();
    if (!sess) { process.exit(0); }
    try {
      const inb = new Database('/data/v2-sessions/' + sess.agent_group_id + '/' + sess.id + '/inbound.db', { readonly: true });
      const rows = inb.prepare(\"SELECT content FROM messages_in WHERE trigger = 1 ORDER BY seq DESC LIMIT 10\").all();
      const target = process.argv[1];
      for (const r of rows) {
        let text = '';
        try { text = (JSON.parse(r.content).text || ''); } catch { text = r.content || ''; }
        if (text.indexOf(target) !== -1) { console.log(text); break; }
      }
    } catch (e) { /* DB not yet present */ }
  " -- "$TARGET_REPO" 2>"$LAST_HARNESS_STDERR" || true)"
  if [ -n "$section_b_hit" ]; then break; fi
  sleep 5
done
[ -n "$section_b_hit" ] || fail "[section-b] 60s 待っても patron の投稿が agent まで届かない。Slack adapter 疎通 / channel 配線 / messaging_group_agents wiring を確認 (kubectl logs $ORCH_POD -c orchestrator -n $NS --since=120s | grep -i slack で受信痕跡)"
ok "[section-b] 投稿到達確認 (content snippet: $(printf '%s' "$section_b_hit" | head -c 120 | tr '\n' ' '))"

# === Section C: acquire 完了 polling + BIBLIO_NAME 抽出 (180s) ===
# acquire-action.ts:21 の resultText: `仕入れ完了: ${repo} を quarantine に配置しました (${quarantinePath})。`
# quarantinePath は `data/quarantine/<owner>--<name>` の形 (= acquire.ts)、regex で biblio 抽出。
info ""
info "[section-c] acquire 完了を待機 (timeout 180s)..."
LAST_HARNESS_STDERR="$STDERR_DIR/section-c.stderr"
section_c_hit=''
for _ in $(seq 1 36); do
  section_c_hit="$(kubectl exec "$ORCH_POD" -c orchestrator -n "$NS" -- node -e "
    const Database = require('better-sqlite3');
    const central = new Database('/data/v2.db', { readonly: true });
    const sess = central.prepare('SELECT id, agent_group_id FROM sessions ORDER BY rowid DESC LIMIT 1').get();
    if (!sess) { process.exit(0); }
    try {
      const inb = new Database('/data/v2-sessions/' + sess.agent_group_id + '/' + sess.id + '/inbound.db', { readonly: true });
      const rows = inb.prepare(\"SELECT content FROM messages_in WHERE id LIKE 'acquire-resp%' ORDER BY seq DESC LIMIT 1\").all();
      if (rows[0]) {
        let text = '';
        try { text = (JSON.parse(rows[0].content).text || ''); } catch { text = rows[0].content || ''; }
        console.log(text);
      }
    } catch (e) { /* DB not yet present */ }
  " 2>"$LAST_HARNESS_STDERR" || true)"
  if [ -n "$section_c_hit" ]; then break; fi
  sleep 5
done
[ -n "$section_c_hit" ] || fail "[section-c] 180s 待っても acquire 完了 (acquire-resp) が messages_in に現れない。kubectl logs $ORCH_POD -c orchestrator -n $NS --since=240s | grep biblio.acquire で原因確認 (gh api / git clone の timeout / 認証エラー?)"

# acquire 失敗ケース (= 「仕入れエラー」テキスト) は早期 fail
case "$section_c_hit" in
  *仕入れエラー*) fail "[section-c] acquire が失敗テキストを返した: $(printf '%s' "$section_c_hit" | head -c 300)" ;;
esac

# BIBLIO_NAME 抽出 (= cleanup 用、`(data/quarantine/<biblio>)` から正規表現で)
BIBLIO_NAME="$(printf '%s' "$section_c_hit" | node -e "
let d='';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  const m = d.match(/data\\/quarantine\\/([A-Za-z0-9][A-Za-z0-9._-]*--[A-Za-z0-9][A-Za-z0-9._-]*)/);
  if (m) process.stdout.write(m[1]);
});" || true)"
[ -n "$BIBLIO_NAME" ] || fail "[section-c] acquire-resp text から BIBLIO_NAME を抽出できない: $(printf '%s' "$section_c_hit" | head -c 300)"
ok "[section-c] acquire 完了 (biblio=$BIBLIO_NAME)"

# === Section D: categorize 完了 polling + 「はい」投稿促し (180s) ===
# categorize-action.ts:21-25 の resultText:
#   `カテゴリ判定: \`${result.category}\` (理由: ${result.reason})。\n陳列を進めますか? (...)`
info ""
info "[section-d] categorize 完了を待機 (timeout 180s)..."
LAST_HARNESS_STDERR="$STDERR_DIR/section-d.stderr"
section_d_hit=''
for _ in $(seq 1 36); do
  section_d_hit="$(kubectl exec "$ORCH_POD" -c orchestrator -n "$NS" -- node -e "
    const Database = require('better-sqlite3');
    const central = new Database('/data/v2.db', { readonly: true });
    const sess = central.prepare('SELECT id, agent_group_id FROM sessions ORDER BY rowid DESC LIMIT 1').get();
    if (!sess) { process.exit(0); }
    try {
      const inb = new Database('/data/v2-sessions/' + sess.agent_group_id + '/' + sess.id + '/inbound.db', { readonly: true });
      const rows = inb.prepare(\"SELECT content FROM messages_in WHERE id LIKE 'categorize-resp%' ORDER BY seq DESC LIMIT 1\").all();
      if (rows[0]) {
        let text = '';
        try { text = (JSON.parse(rows[0].content).text || ''); } catch { text = rows[0].content || ''; }
        if (text.indexOf('カテゴリ判定') !== -1 && text.indexOf('陳列を進めますか') !== -1) {
          console.log(text);
        }
      }
    } catch (e) { /* DB not yet present */ }
  " 2>"$LAST_HARNESS_STDERR" || true)"
  if [ -n "$section_d_hit" ]; then break; fi
  sleep 5
done
[ -n "$section_d_hit" ] || fail "[section-d] 180s 待っても categorize 完了 (陳列確認プロンプト) が messages_in に現れない。kubectl logs $ORCH_POD -c orchestrator -n $NS --since=240s | grep biblio.categorize で原因確認 (Vertex 呼出失敗 / inspect REJECT で categorize 未到達?)"
ok "[section-d] categorize 完了 (prompt snippet: $(printf '%s' "$section_d_hit" | head -c 120 | tr '\n' ' '))"

info ""
info "次に本番 Slack ws で biblio bot 宛て mention で「はい」を投稿してください:"
info ""
info "    @biblio はい"
info ""
info "(同じ thread に投稿してください。engage_mode=mention-sticky で既存 session に届きます)"
info ""
read -r -p "[ACTION REQUIRED] 投稿が完了したら Enter を押してください: " _
ok "[section-d] 「はい」投稿の OK を受領"

# === Section E: shelve 完了 polling + PR URL 抽出 (300s) ===
# shelve-action.ts:21 の resultText:
#   `陳列完了: PR URL = ${result.prUrl} (branch: \`${result.branchName}\`)\n手動 merge をお願いします。`
# shelve は blob × N + tree + commit + branch + PR の Git Data API 直列 (blob 間 1s sleep)、
# 20-30 file の biblio で 60s 以上かかる → 300s で十分な余裕。
info ""
info "[section-e] shelve 完了 + PR URL 抽出を待機 (timeout 300s)..."
LAST_HARNESS_STDERR="$STDERR_DIR/section-e.stderr"
section_e_hit=''
for _ in $(seq 1 60); do
  section_e_hit="$(kubectl exec "$ORCH_POD" -c orchestrator -n "$NS" -- node -e "
    const Database = require('better-sqlite3');
    const central = new Database('/data/v2.db', { readonly: true });
    const sess = central.prepare('SELECT id, agent_group_id FROM sessions ORDER BY rowid DESC LIMIT 1').get();
    if (!sess) { process.exit(0); }
    try {
      const inb = new Database('/data/v2-sessions/' + sess.agent_group_id + '/' + sess.id + '/inbound.db', { readonly: true });
      const rows = inb.prepare(\"SELECT content FROM messages_in WHERE id LIKE 'shelve-resp%' ORDER BY seq DESC LIMIT 1\").all();
      if (rows[0]) {
        let text = '';
        try { text = (JSON.parse(rows[0].content).text || ''); } catch { text = rows[0].content || ''; }
        if (text.indexOf('陳列完了: PR URL') !== -1) {
          console.log(text);
        }
      }
    } catch (e) { /* DB not yet present */ }
  " 2>"$LAST_HARNESS_STDERR" || true)"
  if [ -n "$section_e_hit" ]; then break; fi
  sleep 5
done
[ -n "$section_e_hit" ] || fail "[section-e] 300s 待っても shelve 完了 (PR URL) が messages_in に現れない。kubectl logs $ORCH_POD -c orchestrator -n $NS --since=360s | grep biblio.shelve で原因確認 (gh-token-rotator が secret 投入できているか / shelf repo pathPattern が effective か)"

# PR URL + PR_NUMBER 抽出
extract_out="$(printf '%s' "$section_e_hit" | node -e "
let d='';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  const m = d.match(/https:\\/\\/github\\.com\\/[^\\s\\/]+\\/[^\\s\\/]+\\/pull\\/(\\d+)/);
  if (m) process.stdout.write(m[0] + '|' + m[1]);
});" || true)"
[ -n "$extract_out" ] || fail "[section-e] shelve-resp text から PR URL を抽出できない: $(printf '%s' "$section_e_hit" | head -c 300)"
PR_URL="${extract_out%%|*}"
CREATED_PR_NUMBER="${extract_out##*|}"
ok "[section-e] shelve 完了 (PR URL=$PR_URL, #$CREATED_PR_NUMBER)"

# === Section F (任意): Slack bot 応答配信確認 ===
# outbound.db.messages_out に kind=chat + slack 宛て + text に PR URL を含む行があるか、
# かつ inbound.db.delivered に対応 message_out_id があるかを確認。
# Section E で PR URL を取得した時点で実質 E2E は成立しているため、本 section は補助確認。
# 失敗は warn 継続 (= --skip-slack-check で skip 可能)。
info ""
if [ "$SKIP_SLACK_CHECK" = "1" ]; then
  info "[section-f] --skip-slack-check により skip"
else
  info "[section-f] Slack bot 応答配信を確認 (outbound + delivered、timeout 30s)..."
  LAST_HARNESS_STDERR="$STDERR_DIR/section-f.stderr"
  delivered_hit=''
  for _ in $(seq 1 6); do
    delivered_hit="$(kubectl exec "$ORCH_POD" -c orchestrator -n "$NS" -- node -e "
      const Database = require('better-sqlite3');
      const central = new Database('/data/v2.db', { readonly: true });
      const sess = central.prepare('SELECT id, agent_group_id FROM sessions ORDER BY rowid DESC LIMIT 1').get();
      if (!sess) { process.exit(0); }
      try {
        const outDb = new Database('/data/v2-sessions/' + sess.agent_group_id + '/' + sess.id + '/outbound.db', { readonly: true });
        const inDb = new Database('/data/v2-sessions/' + sess.agent_group_id + '/' + sess.id + '/inbound.db', { readonly: true });
        const target = process.argv[1];
        const outRows = outDb.prepare(\"SELECT id, kind, channel_type, content FROM messages_out ORDER BY seq DESC LIMIT 20\").all();
        for (const r of outRows) {
          if (r.kind !== 'chat') continue;
          if (r.channel_type && r.channel_type !== 'slack') continue;
          let text = '';
          try { text = (JSON.parse(r.content).text || ''); } catch { text = r.content || ''; }
          if (text.indexOf(target) === -1) continue;
          const del = inDb.prepare(\"SELECT message_out_id FROM delivered WHERE message_out_id = ?\").get(r.id);
          if (del) { console.log(r.id); break; }
        }
      } catch (e) { /* DB not yet present */ }
    " -- "$PR_URL" 2>"$LAST_HARNESS_STDERR" || true)"
    if [ -n "$delivered_hit" ]; then break; fi
    sleep 5
  done
  if [ -n "$delivered_hit" ]; then
    ok "[section-f] Slack bot 応答配信確認 (delivered message_out_id=$delivered_hit)"
  else
    warn "[section-f] Slack 配信確認 NG (bot 応答が outbound に出ていない or delivered に記録されていない)。Section E で PR URL 取得済のため PASS 維持 (kubectl logs $ORCH_POD -c orchestrator -n $NS | grep delivery で原因確認)"
  fi
fi

# === 完了報告 ===
info ""
info "==============================================================="
ok "Phase 6 PASS (Slack E2E GKE) — PR URL=$PR_URL"
info "biblio=$BIBLIO_NAME / PR #$CREATED_PR_NUMBER on $SHELF_REPO_OWNER/$SHELF_REPO_NAME"
info "==============================================================="
exit 0
