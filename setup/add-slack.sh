#!/usr/bin/env bash
#
# Install the Slack adapter (Socket Mode), persist SLACK_BOT_TOKEN +
# SLACK_APP_TOKEN to .env + data/env/env, and restart the service. Non-interactive
# — the operator-facing app creation walkthrough + credential paste live in
# setup/channels/slack.ts. Credentials come in via env vars:
# SLACK_BOT_TOKEN (required), SLACK_APP_TOKEN (required for Socket Mode),
# SLACK_SIGNING_SECRET (optional — Socket Mode does not require it, but
# setup/auto collects it for completeness; persisted only when non-empty).
#
# Emits exactly one status block on stdout (ADD_SLACK) at the end. All chatty
# progress messages go to stderr so setup:auto's raw-log capture sees the full
# story without cluttering the final block for the parser.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Keep in sync with .claude/skills/add-slack/SKILL.md.
ADAPTER_VERSION="@chat-adapter/slack@4.30.0"

# Resolve which remote carries the channels branch — handles forks where
# upstream lives on a different remote than `origin`.
# shellcheck source=setup/lib/channels-remote.sh
source "$PROJECT_ROOT/setup/lib/channels-remote.sh"
CHANNELS_REMOTE=$(resolve_channels_remote)
CHANNELS_BRANCH="${CHANNELS_REMOTE}/channels"

emit_status() {
  local status=$1 error=${2:-}
  local already=${ADAPTER_ALREADY_INSTALLED:-false}
  local signing_secret_set=false
  [ -n "${SLACK_SIGNING_SECRET:-}" ] && signing_secret_set=true
  echo "=== NANOCLAW SETUP: ADD_SLACK ==="
  echo "STATUS: ${status}"
  echo "ADAPTER_VERSION: ${ADAPTER_VERSION}"
  echo "ADAPTER_ALREADY_INSTALLED: ${already}"
  echo "SLACK_SIGNING_SECRET_SET: ${signing_secret_set}"
  [ -n "$error" ] && echo "ERROR: ${error}"
  echo "=== END ==="
}

log() { echo "[add-slack] $*" >&2; }

if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
  emit_status failed "SLACK_BOT_TOKEN env var not set"
  exit 1
fi
if [ -z "${SLACK_APP_TOKEN:-}" ]; then
  emit_status failed "SLACK_APP_TOKEN env var not set (required for Socket Mode)"
  exit 1
fi
if [ -z "${SLACK_SIGNING_SECRET:-}" ]; then
  log "SLACK_SIGNING_SECRET not set — skipping (Socket Mode does not require it)."
fi

need_install() {
  [ ! -f src/channels/slack.ts ] && return 0
  ! grep -q "^import './slack.js';" src/channels/index.ts 2>/dev/null && return 0
  return 1
}

ADAPTER_ALREADY_INSTALLED=true
if need_install; then
  ADAPTER_ALREADY_INSTALLED=false
  log "Fetching channels branch…"
  git fetch "$CHANNELS_REMOTE" channels >&2 2>/dev/null || {
    emit_status failed "git fetch ${CHANNELS_REMOTE} channels failed"
    exit 1
  }

  log "Copying adapter from ${CHANNELS_BRANCH}…"
  # Write atomically via a temp file. A naked `git show ... > dst` leaves an
  # empty dst behind when git show fails (e.g. ref exists but path moved),
  # and the subsequent build still passes — leaving an empty Slack adapter
  # that silently skips registration (PR #6 review P8).
  tmp_slack="$(mktemp)"
  trap 'rm -f "$tmp_slack"' EXIT
  if ! git show "${CHANNELS_BRANCH}:src/channels/slack.ts" > "$tmp_slack"; then
    emit_status failed "git show ${CHANNELS_BRANCH}:src/channels/slack.ts failed"
    exit 1
  fi
  if [ ! -s "$tmp_slack" ]; then
    emit_status failed "git show ${CHANNELS_BRANCH}:src/channels/slack.ts produced an empty file"
    exit 1
  fi
  mv "$tmp_slack" src/channels/slack.ts
  trap - EXIT

  # Append self-registration import if missing.
  if ! grep -q "^import './slack.js';" src/channels/index.ts; then
    echo "import './slack.js';" >> src/channels/index.ts
  fi

  log "Installing ${ADAPTER_VERSION}…"
  pnpm install "${ADAPTER_VERSION}" >&2 2>/dev/null || {
    emit_status failed "pnpm install ${ADAPTER_VERSION} failed"
    exit 1
  }

  log "Building…"
  pnpm run build >&2 2>/dev/null || {
    emit_status failed "pnpm run build failed"
    exit 1
  }
else
  log "Adapter files already installed — skipping install phase."
fi

# Persist credentials. auto.ts validates via auth.test before this point, so
# bad values here would be an internal bug rather than operator input.
touch .env
upsert_env() {
  local key=$1 value=$2
  if grep -q "^${key}=" .env; then
    awk -v k="$key" -v v="$value" \
        'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' \
      .env > .env.tmp && mv .env.tmp .env
  else
    echo "${key}=${value}" >> .env
  fi
}
upsert_env SLACK_BOT_TOKEN "$SLACK_BOT_TOKEN"
upsert_env SLACK_APP_TOKEN "$SLACK_APP_TOKEN"
if [ -n "${SLACK_SIGNING_SECRET:-}" ]; then
  upsert_env SLACK_SIGNING_SECRET "$SLACK_SIGNING_SECRET"
fi

# Container reads from data/env/env (the host mounts it).
mkdir -p data/env
cp .env data/env/env

log "Restarting service so the new adapter picks up the credentials…"
# shellcheck source=setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
# biblio-claw は docker compose 環境のため launchd/systemd ユニットを持たない。
# 上流 NanoClaw の launchctl/systemctl 経路は本 repo では失敗するのが正常。
# 失敗を silent にせず、手動再起動が必要であることを操作者に明示する。
restarted=false
case "$(uname -s)" in
  Darwin)
    if launchctl kickstart -k "gui/$(id -u)/$(launchd_label)" >&2 2>/dev/null; then
      restarted=true
    fi
    ;;
  Linux)
    if systemctl --user restart "$(systemd_unit)" >&2 2>/dev/null \
      || sudo systemctl restart "$(systemd_unit)" >&2 2>/dev/null; then
      restarted=true
    fi
    ;;
esac
if ! $restarted; then
  log "Service restart skipped (no launchd/systemd unit found)."
  log "→ docker compose 環境では host プロセスを手動で再起動してください:"
  log "    pnpm run dev   (foreground) or"
  log "    docker compose restart nanoclaw  (compose 上の場合)"
fi

# Give the Slack adapter a moment to finish starting the webhook listener
# before emitting success.
sleep 3

emit_status success
