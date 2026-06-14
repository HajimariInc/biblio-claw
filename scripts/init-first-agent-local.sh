#!/usr/bin/env bash
# biblio-claw M2 PRD A Phase 2: init-first-agent local wrapper.
#
# 上流 NanoClaw の docker compose 構成と異なり、本 repo の compose は
# postgres + onecli のみで、host orchestrator は compose 外の Node プロセスとして
# `pnpm run dev` で起動する (docker-compose.yml L1-L7 ARCHITECT 判断ログ参照)。
# このため init-first-agent.ts も `docker compose exec orchestrator` ではなく
# host で直接 `pnpm exec tsx` する。Phase 2 plan §Task 6 からの意図的な逸脱で、
# レポートに記録する。
#
# 前提:
#   - docker compose up -d --wait                    # postgres + onecli 起動
#   - pnpm run dev                                   # host orchestrator 起動
#       (init-first-agent.ts:sendWelcomeViaCliSocket() が DATA_DIR/cli.sock に
#        繋ぐため、host が動いていないと CLI socket not reachable で fail)
#   - .env に SLACK_OWNER_USER_ID / SLACK_OWNER_DM_CHANNEL_ID /
#     SLACK_OWNER_DISPLAY_NAME および local 用 Slack App (@biblio-dev) の
#     SLACK_BOT_TOKEN / SLACK_APP_TOKEN / SLACK_SIGNING_SECRET が投入済
#
# 冪等: init-first-agent.ts が getAgentGroupByFolder / getMessagingGroupByPlatform
# で reuse 判定するため、2 回目以降の実行は "Reusing ..." 出力で no-op になる。
#
# Override:
#   ENV_FILE=./.env.local bash scripts/init-first-agent-local.sh
#   INIT_AGENT_NAME=biblio-other-dev bash scripts/init-first-agent-local.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ENV_FILE:-./.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

: "${SLACK_OWNER_USER_ID:?missing — .env に SLACK_OWNER_USER_ID を投入 (Slack の U0... ID)}"
: "${SLACK_OWNER_DM_CHANNEL_ID:?missing — .env に SLACK_OWNER_DM_CHANNEL_ID を投入 (bot との DM の D... ID)}"
: "${SLACK_OWNER_DISPLAY_NAME:?missing — .env に SLACK_OWNER_DISPLAY_NAME を投入}"

AGENT_NAME="${INIT_AGENT_NAME:-biblio-first-dev}"
WELCOME="${INIT_WELCOME:-biblio-dev が起動しました (local 検証用)。}"

echo "[init-first-agent-local] AGENT_NAME=$AGENT_NAME"
echo "[init-first-agent-local] OWNER=$SLACK_OWNER_DISPLAY_NAME ($SLACK_OWNER_USER_ID)"
echo "[init-first-agent-local] DM=$SLACK_OWNER_DM_CHANNEL_ID"
echo "[init-first-agent-local] 前提: docker compose up -d + pnpm run dev 起動済"

pnpm exec tsx scripts/init-first-agent.ts \
  --channel slack \
  --user-id "$SLACK_OWNER_USER_ID" \
  --platform-id "$SLACK_OWNER_DM_CHANNEL_ID" \
  --display-name "$SLACK_OWNER_DISPLAY_NAME" \
  --agent-name "$AGENT_NAME" \
  --role owner \
  --welcome "$WELCOME"
