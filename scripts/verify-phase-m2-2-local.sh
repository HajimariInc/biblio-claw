#!/usr/bin/env bash
# biblio-claw: M2 PRD A Phase 2 — init-first-agent の **local 機構レベル** 検証。
#
# Scope (= "機構の正しさ" まで、会話 1 往復は試みない):
#   §1. docker compose の postgres + onecli が Up + healthy
#   §2. nanoclaw-agent image に agent-runner src / skills / CLAUDE.md が焼き込まれている
#   §3. host orchestrator (compose 外、`pnpm run dev`) が起動中 = central DB ready
#   §4. scripts/init-first-agent-local.sh が冪等実行可能で Init complete. を出す
#   §5. central DB の 6 テーブル + container_configs に first-agent の行が入る
#   §6. host log (logs/dev.out) に Slack adapter 起動成立痕跡 (`@biblio-dev`)
#
# 会話 1 往復 (= Vertex API → agent-runner → outbound.db → Slack 配信) は GKE
# E2E (verify-phase-m2-2.sh) 側で実施する。理由は plan §Out of Scope:
#   - local の CONTAINER_PROVIDER=docker と GKE の k8s で agent-runner 起動経路 +
#     OneCLI vault 注入経路が異なり、両方 verify すると検証パスが膨らむ
#
# 前提:
#   - docker compose up -d --wait
#   - 別 shell で pnpm run dev (host が compose 外で起動、logs/dev.out に流れる想定)
#   - .env に SLACK_OWNER_* + local 用 Slack App (@biblio-dev) の SLACK_BOT_TOKEN 等が投入済

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/onecli-lib.sh
. "${ROOT}/scripts/onecli-lib.sh"

ANSI_STRIP='s/\x1b\[[0-9;]*m//g'

info "==== M2 Phase 2 (init-first-agent) local mechanical assertion ===="

# === §1. docker compose の postgres + onecli が Up + healthy ===
# biblio-claw の compose は postgres + onecli のみ (orchestrator は compose 外)。
# 上流 NanoClaw の "host を compose service にする" 構成と異なる点に注意。
for svc in biblio-postgres biblio-onecli; do
  status="$(docker inspect -f '{{.State.Status}}' "$svc" 2>/dev/null || echo absent)"
  [ "$status" = "running" ] \
    || fail "[compose] container $svc が running でない (actual=$status) — docker compose up -d --wait を実行"
  # health は postgres のみ healthcheck 定義あり (compose yaml L35-43)。onecli は未定義なので running まで。
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$svc" 2>/dev/null || echo none)"
  case "$health" in
    healthy|none) ok "[compose] $svc running (health=$health)" ;;
    *) fail "[compose] $svc は running だが health=$health — docker logs $svc で確認" ;;
  esac
done

# === §2. nanoclaw-agent image に焼き込み 3 ファイルが入っている ===
# Phase 2 Task 1 で container/Dockerfile に biblio-claw 流の上流逸脱として COPY を
# 追加した検証点。compose の hostPath mount は image 内ファイルを上書きするので
# compose 経由 (= docker compose exec) ではなく **生 image** を docker run --rm で覗く。
#
# image tag は `<install-slug>:latest` (container/build.sh L20-21)。slug は repo
# パスから派生するため、install-slug.sh を読んで動的に解決する。
INSTALL_SLUG_LIB="${ROOT}/setup/lib/install-slug.sh"
[ -r "$INSTALL_SLUG_LIB" ] \
  || fail "[image] $INSTALL_SLUG_LIB が読み取れない — 上流 NanoClaw 構造の前提崩れ"
# shellcheck source=setup/lib/install-slug.sh
. "$INSTALL_SLUG_LIB"
AGENT_IMAGE="$(container_image_base):latest"
info "[image] target = $AGENT_IMAGE"

# docker image inspect で image 存在を確認 (run の前に明示)。
docker image inspect "$AGENT_IMAGE" >/dev/null 2>&1 \
  || fail "[image] $AGENT_IMAGE が存在しない — ./container/build.sh で build"

# 3 ファイル存在チェック — run の終了コードと output を両方見る。
bake_out="$(docker run --rm --entrypoint sh "$AGENT_IMAGE" -lc \
  'ls /app/src/index.ts /app/skills /app/CLAUDE.md 2>&1' 2>&1 || true)"
for f in /app/src/index.ts /app/skills /app/CLAUDE.md; do
  echo "$bake_out" | grep -qF "$f" \
    || fail "[image] $f が image に焼き込まれていない (output: ${bake_out:0:200}) — Dockerfile L78 直後の COPY を確認"
done
ok "[image] /app/src/index.ts + /app/skills + /app/CLAUDE.md 焼き込み済"

# === §3. host orchestrator (compose 外) が起動中 = central DB ready ===
DATA_DIR_PATH="${DATA_DIR:-${ROOT}/data}"
V2_DB="${DATA_DIR_PATH}/v2.db"
[ -f "$V2_DB" ] \
  || fail "[host] $V2_DB が無い — host orchestrator (pnpm run dev) を起動して central DB を初期化"
CLI_SOCK="${DATA_DIR_PATH}/cli.sock"
[ -S "$CLI_SOCK" ] \
  || fail "[host] $CLI_SOCK が無い — host orchestrator が起動していない (pnpm run dev で立てる)"
ok "[host] central DB + cli.sock 検出 (host orchestrator 稼働中)"

# === §4. scripts/init-first-agent-local.sh が冪等実行可能で Init complete. を出す ===
LOCAL_WRAPPER="${ROOT}/scripts/init-first-agent-local.sh"
[ -x "$LOCAL_WRAPPER" ] \
  || fail "[init] $LOCAL_WRAPPER が無い or 実行権限が無い"

init_out="$(bash "$LOCAL_WRAPPER" 2>&1)" || {
  echo "$init_out" >&2
  fail "[init] init-first-agent-local.sh が exit 0 で終わらない — 出力上記参照"
}
echo "$init_out" | grep -qF 'Init complete.' \
  || fail "[init] 'Init complete.' が出力にない (output 末尾: $(echo "$init_out" | tail -5 | tr '\n' ' '))"
ok "[init] init-first-agent-local.sh が冪等実行成功 + Init complete."

# === §5. central DB 6 テーブル + container_configs に first-agent の行 ===
# CLAUDE.md §中央DB の推奨 wrapper (scripts/q.ts) を使う。sqlite3 CLI 非依存。
Q="pnpm exec tsx scripts/q.ts"
check_count() {
  local table="$1" expected_min="${2:-1}"
  local n
  n="$($Q "$V2_DB" "SELECT COUNT(*) FROM ${table}" 2>/dev/null || echo 0)"
  [ "${n:-0}" -ge "$expected_min" ] \
    || fail "[db] テーブル ${table} の行数 ${n} < ${expected_min} — init-first-agent が正しく書いたか確認"
  ok "[db] ${table}: ${n} 行"
}
for t in users user_roles agent_groups agent_group_members messaging_groups messaging_group_agents; do
  check_count "$t" 1
done
# container_configs は initGroupFilesystem 内で ensureContainerConfig が走る。
check_count container_configs 1

# === §6. host log に Slack adapter 起動成立痕跡 ===
# verify-phase-2-wiring.sh §9 と同じ ANSI 剥離 + 両一致パターン。
# host は compose 外で動くので docker compose logs ではなく logs/dev.out を見る。
DEV_LOG="${ROOT}/logs/dev.out"
[ -f "$DEV_LOG" ] \
  || fail "[slack] $DEV_LOG が無い — host orchestrator のログが流れる先 (pnpm run dev のリダイレクト先) を確認"

# 直近 N 行のみで起動成立を見る。 起動後の Shutdown 痕跡が tail に残っていても
# 「最新の adapter 起動」を確認したいので、最後の "Channel adapter stopped" 以降
# の "Channel adapter started" を探す。
log_text="$(tail -n 500 "$DEV_LOG" | sed -r "$ANSI_STRIP")"
if echo "$log_text" | grep -E 'Channel adapter started.*channel="slack"' >/dev/null; then
  ok "[slack] Slack adapter 起動済 (Channel adapter started + channel=\"slack\" 両一致)"
elif echo "$log_text" | grep -E 'Channel credentials missing.*channel="slack"' >/dev/null; then
  fail "[slack] Slack credentials が adapter から見えていない — .env に SLACK_BOT_TOKEN / SLACK_APP_TOKEN / SLACK_SIGNING_SECRET (local 用 @biblio-dev App) を投入"
else
  fail "[slack] Slack adapter 起動痕跡も credentials missing 痕跡も無い — pnpm run dev を再起動して logs/dev.out を更新"
fi

ok "==== PASS: M2 Phase 2 local (mechanical) verified ===="
info "GKE E2E verify は: bash scripts/verify-phase-m2-2.sh (要 cluster context)"
