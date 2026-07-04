#!/usr/bin/env bash
# biblio-claw M4-F Phase 1 revival-core: init-hybrid-agent GKE wrapper.
#
# kubectl exec biblio-orchestrator-0 -- pnpm exec tsx scripts/init-hybrid-agent.ts
# 経由で central DB に hybrid agent group (= claude fallback provider の
# agent-container 経路) を bootstrap + DEN さん Slack DM に wire する。
#
# 前提:
#   - kubectl context が biblio-prod (gcloud container clusters get-credentials
#     biblio-prod --region=asia-northeast1 済)
#   - StatefulSet biblio-orchestrator が Ready (= host が起動済)
#   - k8s Secret biblio-slack-tokens が投入済 (envFrom secretRef、本番 Slack workspace)
#   - HYBRID_USER_ID (Slack `slack:U...` 形式) と HYBRID_SLACK_DM_CHANNEL_ID (raw `D...` 形式)
#     が env or .env で投入済
#
# 冪等: init-hybrid-agent.ts が getAgentGroupByFolder / getMessagingGroupByPlatform で
# reuse 判定するため、2 回目以降の実行は "Reusing ..." 出力で no-op になる。
#
# fan-out 二重発火防止 (init-hybrid-agent.ts:wireSlackDm の safety net):
# HYBRID_SLACK_DM_CHANNEL_ID が指す既存 messaging_group が他 agent_group に wire
# 済の場合、seed script は fail-fast + 手動対応 prompt を出して exit 1。DEN さんが
# 「既存 wire を先に外す」か「別 platform_id で分離する」を判断する。
#
# Usage:
#   # 基本 (env or .env に HYBRID_USER_ID + HYBRID_SLACK_DM_CHANNEL_ID を投入)
#   bash scripts/init-hybrid-agent-gke.sh
#
#   # HYBRID_SLACK_DM_CHANNEL_ID を明示指定
#   HYBRID_SLACK_DM_CHANNEL_ID=D0B6JA2M5GA bash scripts/init-hybrid-agent-gke.sh
#
#   # Slack DM wire なし (test / dry-run)
#   HYBRID_SKIP_SLACK_DM=1 bash scripts/init-hybrid-agent-gke.sh
#
#   # 別 namespace / 別 pod / 別 env file
#   BIBLIO_NAMESPACE=biblio-claw ORCH_POD=biblio-orchestrator-0 \
#     ENV_FILE=./.env.gke bash scripts/init-hybrid-agent-gke.sh

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

# HYBRID_USER_ID (Slack `slack:U...` 形式) は必須。DEN さん owner user (`SLACK_OWNER_USER_ID`)
# を default にする経路もあるが、後段の accountability を明示するため fail-fast。
: "${HYBRID_USER_ID:?missing — HYBRID_USER_ID を env or .env に投入 (例: slack:U7F8TRM6X)}"

SKIP_SLACK_DM="${HYBRID_SKIP_SLACK_DM:-0}"
if [ "$SKIP_SLACK_DM" != "1" ] && [ "$SKIP_SLACK_DM" != "true" ]; then
  : "${HYBRID_SLACK_DM_CHANNEL_ID:?missing — HYBRID_SLACK_DM_CHANNEL_ID を env or .env に投入 (raw D... 形式、例: D0B6JA2M5GA)。Slack DM wire を skip したい場合は HYBRID_SKIP_SLACK_DM=1}"
fi

NAMESPACE="${BIBLIO_NAMESPACE:-biblio-claw}"
ORCH_POD="${ORCH_POD:-biblio-orchestrator-0}"
AGENT_NAME="${HYBRID_AGENT_NAME:-司書 (hybrid)}"
DISPLAY_NAME="${HYBRID_DISPLAY_NAME:-Patron}"

# kubectl context assert (biblio-prod cluster が current であること)。
ctx="$(kubectl config current-context 2>/dev/null || echo '')"
case "$ctx" in
  gke_*_biblio-prod)
    ;;
  *)
    echo "[init-hybrid-agent-gke] expected biblio-prod context, got: $ctx" >&2
    echo "[init-hybrid-agent-gke]   gcloud container clusters get-credentials biblio-prod --region=asia-northeast1" >&2
    exit 1
    ;;
esac

# StatefulSet Ready assert。
ready="$(kubectl get statefulset biblio-orchestrator -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)"
if [ "$ready" != "1" ]; then
  echo "[init-hybrid-agent-gke] StatefulSet biblio-orchestrator readyReplicas != 1 (actual=$ready)" >&2
  echo "[init-hybrid-agent-gke]   kubectl rollout status statefulset/biblio-orchestrator -n $NAMESPACE" >&2
  exit 1
fi

echo "[init-hybrid-agent-gke] AGENT_NAME=$AGENT_NAME"
echo "[init-hybrid-agent-gke] DISPLAY_NAME=$DISPLAY_NAME"
echo "[init-hybrid-agent-gke] USER_ID=$HYBRID_USER_ID"
if [ "$SKIP_SLACK_DM" = "1" ] || [ "$SKIP_SLACK_DM" = "true" ]; then
  echo "[init-hybrid-agent-gke] SLACK_DM=skipped"
else
  echo "[init-hybrid-agent-gke] SLACK_DM=${HYBRID_SLACK_DM_CHANNEL_ID}"
fi
echo "[init-hybrid-agent-gke] target=$ORCH_POD -n $NAMESPACE"

# kubectl exec 引数 (Slack DM 有無で分岐)。orchestrator Pod 内は working dir /app、
# `pnpm exec tsx` は image build 済の node_modules/.bin/tsx を使う。
if [ "$SKIP_SLACK_DM" = "1" ] || [ "$SKIP_SLACK_DM" = "true" ]; then
  kubectl exec -n "$NAMESPACE" "$ORCH_POD" -c orchestrator -- \
    pnpm exec tsx scripts/init-hybrid-agent.ts \
      --user-id "$HYBRID_USER_ID" \
      --display-name "$DISPLAY_NAME" \
      --agent-name "$AGENT_NAME" \
      --skip-slack-dm
else
  kubectl exec -n "$NAMESPACE" "$ORCH_POD" -c orchestrator -- \
    pnpm exec tsx scripts/init-hybrid-agent.ts \
      --user-id "$HYBRID_USER_ID" \
      --slack-dm-channel-id "$HYBRID_SLACK_DM_CHANNEL_ID" \
      --display-name "$DISPLAY_NAME" \
      --agent-name "$AGENT_NAME"
fi

echo "[init-hybrid-agent-gke] seed complete — SEED_RESULT= line above is the machine-readable summary."
