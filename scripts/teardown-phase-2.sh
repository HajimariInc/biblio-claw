#!/usr/bin/env bash
# biblio-claw: Phase 2 teardown (GCP リソース削除、dry-run 既定)
#
# 削除対象 (順序固定、依存関係に従う):
#   1. K8s manifest (kubectl delete -f k8s/)
#   2. GKE Autopilot biblio-prod
#   3. Cloud SQL biblio-pgsql
#   4. Artifact Registry biblio-claw
#   5. GSA biblio-sidecar + biblio-onecli (Vault 方針 = 2 件)
#   6. VPC peering 解除 + PSC アドレス削除 + Subnet 削除 + VPC 削除
#
# 削除しない (残置):
#   - Secret Manager biblio-gh-app-pem (本番 biblio-claw 用途で残置)
#   - Self-grant role (roles/servicenetworking.networksAdmin, roles/secretmanager.admin)
#     は別途 gcloud projects remove-iam-policy-binding で剥がす
#
# 使い方:
#   bash scripts/teardown-phase-2.sh              # dry-run (既定、リスト確認のみ)
#   bash scripts/teardown-phase-2.sh --dry-run    # 明示的 dry-run
#   bash scripts/teardown-phase-2.sh --confirm    # 実行 (10 秒カウントダウン)
#
# 必ず --dry-run で削除対象を確認してから --confirm で実行する。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${PROJECT:-hajimari-ai-hackathon-2026}"
REGION="${REGION:-asia-northeast1}"
NS="biblio-claw"

# shellcheck source=scripts/onecli-lib.sh
. "${ROOT}/scripts/onecli-lib.sh"

DRY_RUN=true
case "${1:-}" in
  --confirm) DRY_RUN=false ;;
  --dry-run|"") DRY_RUN=true ;;
  -h|--help) printf 'usage: %s [--dry-run | --confirm]\n' "$0"; exit 0 ;;
  *) fail "usage: $0 [--dry-run | --confirm]" ;;
esac

if $DRY_RUN; then
  info "==== Phase 2 teardown (dry-run mode、何も削除しない) ===="
else
  warn "==== Phase 2 teardown (--confirm 実行モード) ===="
  warn "10 秒後に削除を開始する。Ctrl-C で中断可能。"
  sleep 10
fi

# run: dry-run なら [dry-run] log、--confirm なら実行 (失敗時は warn で継続)
run() {
  if $DRY_RUN; then
    info "[dry-run] $*"
  else
    info "[exec] $*"
    "$@" || warn "(command failed, 継続)"
  fi
}

# === 1. K8s manifest 削除 ===
run kubectl delete -f "${ROOT}/k8s/" --ignore-not-found=true

# === 2. GKE Autopilot 削除 ===
run gcloud container clusters delete biblio-prod --region="$REGION" --project="$PROJECT" --quiet

# === 3. Cloud SQL 削除 ===
run gcloud sql instances delete biblio-pgsql --project="$PROJECT" --quiet

# === 4. Artifact Registry 削除 (image を含めて消える) ===
run gcloud artifacts repositories delete biblio-claw --location="$REGION" --project="$PROJECT" --quiet

# === 5. GSA 削除 (Vault 方針 = 2 件) ===
run gcloud iam service-accounts delete "biblio-sidecar@$PROJECT.iam.gserviceaccount.com" --project="$PROJECT" --quiet
run gcloud iam service-accounts delete "biblio-onecli@$PROJECT.iam.gserviceaccount.com" --project="$PROJECT" --quiet

# === 6. VPC peering 解除 + PSC アドレス削除 + Subnet 削除 + VPC 削除 ===
# 順序固定: peering 解除 → アドレス → Subnet → VPC (上から下への依存解除)
run gcloud services vpc-peerings delete --service=servicenetworking.googleapis.com --network=biblio-net --project="$PROJECT" --quiet
run gcloud compute addresses delete biblio-psc-range --global --project="$PROJECT" --quiet
run gcloud compute networks subnets delete biblio-subnet-an1 --region="$REGION" --project="$PROJECT" --quiet
run gcloud compute networks delete biblio-net --project="$PROJECT" --quiet

if $DRY_RUN; then
  printf '\n'
  info "==== dry-run 完了。実行するなら: bash $0 --confirm ===="
  info "残置リソース: Secret Manager biblio-gh-app-pem (本番運用継続のため)"
  info "self-grant role の解除は別途:"
  info "  gcloud projects remove-iam-policy-binding $PROJECT --member=user:<DEN> --role=roles/servicenetworking.networksAdmin"
  info "  gcloud projects remove-iam-policy-binding $PROJECT --member=user:<DEN> --role=roles/secretmanager.admin"
else
  ok "==== Phase 2 teardown 完了 (Secret Manager biblio-gh-app-pem は残置) ===="
fi
