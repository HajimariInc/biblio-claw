#!/usr/bin/env bash
# biblio-claw M2 PRD A Phase 2: init-first-agent GKE wrapper.
#
# kubectl exec biblio-orchestrator-0 -- pnpm exec tsx scripts/init-first-agent.ts
# 経由で central DB に first-agent (DEN owner) を bootstrap する。
#
# 前提:
#   - kubectl context が biblio-prod (gcloud container clusters get-credentials biblio-prod --region=asia-northeast1)
#   - StatefulSet biblio-orchestrator が Ready (= host が cli.sock listen 済)
#   - k8s Secret biblio-slack-tokens が投入済 (envFrom secretRef、本番 @biblio App の token)
#   - .env (or 環境変数) に SLACK_OWNER_USER_ID / SLACK_OWNER_DM_CHANNEL_ID /
#     SLACK_OWNER_DISPLAY_NAME が **GKE 用の値で** 投入済 — local 用 (= @biblio-dev
#     との DM) と GKE 用 (= @biblio との DM) で DM channel ID が違うため、
#     local とは別の値を渡す必要がある。
#
# 冪等: init-first-agent.ts が getAgentGroupByFolder / getMessagingGroupByPlatform
# で reuse 判定するため、2 回目以降の実行は "Reusing ..." 出力で no-op になる。
#
# Override:
#   ENV_FILE=./.env.gke bash scripts/init-first-agent-gke.sh
#   SLACK_OWNER_DM_CHANNEL_ID=Dxxxx bash scripts/init-first-agent-gke.sh
#   ORCH_POD=biblio-orchestrator-0 BIBLIO_NAMESPACE=biblio-claw bash scripts/init-first-agent-gke.sh

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

: "${SLACK_OWNER_USER_ID:?missing — .env or shell env に SLACK_OWNER_USER_ID を投入 (Slack の U0... ID)}"
: "${SLACK_OWNER_DM_CHANNEL_ID:?missing — .env or shell env に SLACK_OWNER_DM_CHANNEL_ID を投入 (bot との DM の D... ID、GKE 用)}"
: "${SLACK_OWNER_DISPLAY_NAME:?missing — .env or shell env に SLACK_OWNER_DISPLAY_NAME を投入}"

NAMESPACE="${BIBLIO_NAMESPACE:-biblio-claw}"
ORCH_POD="${ORCH_POD:-biblio-orchestrator-0}"
AGENT_NAME="${INIT_AGENT_NAME:-biblio-first}"
WELCOME="${INIT_WELCOME:-biblio が起動しました。何でもお申し付けください。}"

ctx="$(kubectl config current-context)"
case "$ctx" in
  gke_*_biblio-prod)
    ;;
  *)
    echo "[init-first-agent-gke] expected biblio-prod context, got: $ctx" >&2
    echo "[init-first-agent-gke]   gcloud container clusters get-credentials biblio-prod --region=asia-northeast1" >&2
    exit 1
    ;;
esac

ready="$(kubectl get statefulset biblio-orchestrator -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)"
if [ "$ready" != "1" ]; then
  echo "[init-first-agent-gke] StatefulSet biblio-orchestrator readyReplicas != 1 (actual=$ready)" >&2
  echo "[init-first-agent-gke]   kubectl rollout status statefulset/biblio-orchestrator -n $NAMESPACE" >&2
  exit 1
fi

echo "[init-first-agent-gke] AGENT_NAME=$AGENT_NAME"
echo "[init-first-agent-gke] OWNER=$SLACK_OWNER_DISPLAY_NAME ($SLACK_OWNER_USER_ID)"
echo "[init-first-agent-gke] DM=$SLACK_OWNER_DM_CHANNEL_ID"
echo "[init-first-agent-gke] target=$ORCH_POD -n $NAMESPACE"

kubectl exec -n "$NAMESPACE" "$ORCH_POD" -- \
  pnpm exec tsx scripts/init-first-agent.ts \
    --channel slack \
    --user-id "$SLACK_OWNER_USER_ID" \
    --platform-id "$SLACK_OWNER_DM_CHANNEL_ID" \
    --display-name "$SLACK_OWNER_DISPLAY_NAME" \
    --agent-name "$AGENT_NAME" \
    --role owner \
    --welcome "$WELCOME"
