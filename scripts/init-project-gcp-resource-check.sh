#!/usr/bin/env bash
# biblio-claw: GCP リソース現状確認スクリプト (= /init-project-gcp resource-check の素材)
#
# GKE / Cloud SQL / Secret Manager / Artifact Registry の生存確認を 1 コマンドで実施。
# scripts/verify-phase-2-wiring.sh が「GKE 内のリソース」を見るのに対し、本スクリプトは
# 「GCP 側のリソース」を見る (役割分担)。
#
# 前提:
#   - gcloud SDK + kubectl が install 済 + ADC (= gcloud auth application-default login) 済
#   - biblio-prod context 取得済
#     (gcloud container clusters get-credentials biblio-prod --region=asia-northeast1)
#
# 使い方:
#   bash scripts/init-project-gcp-resource-check.sh
#
# 既定値 (env で上書き可、.env から読み込み):
#   GCP_PROJECT_ID=<your-gcp-project>
#   GCP_REGION=asia-northeast1
#   GKE_CLUSTER=biblio-prod        ← shell glob (*, ?) は不可 (context match の bash case pattern に展開されるため)
#   CLOUD_SQL_INSTANCE=biblio-pgsql
#   SM_GH_PEM_NAME=biblio-gh-app-pem
#   AR_REPO_NAME=biblio-claw
#   BIBLIO_NAMESPACE=biblio-claw
#
# 出力:
#   - [INFO]/[OK]/[WARN]/[FAIL] のブラケットタグ形式 (stderr)
#   - WARN_COUNT で集計、致命的でない異常は WARN 継続
#   - 致命的なものは [FAIL] で即 exit 1

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- .env 読み込み (あれば、optional) ---
if [ -f "${ROOT}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${ROOT}/.env"
  set +a
fi

# shellcheck source=scripts/onecli-lib.sh
. "${ROOT}/scripts/onecli-lib.sh"

# --- 既定値 (env で上書き可) ---
PROJECT="${GCP_PROJECT_ID:?required (export GCP_PROJECT_ID)}"
REGION="${GCP_REGION:-asia-northeast1}"
GKE_CLUSTER="${GKE_CLUSTER:-biblio-prod}"
CLOUD_SQL_INSTANCE="${CLOUD_SQL_INSTANCE:-biblio-pgsql}"
SM_GH_PEM_NAME="${SM_GH_PEM_NAME:-biblio-gh-app-pem}"
AR_REPO_NAME="${AR_REPO_NAME:-biblio-claw}"
NS="${BIBLIO_NAMESPACE:-biblio-claw}"

# WARN_COUNT は致命的でない異常を集計。fail は即 exit 1。
WARN_COUNT=0

info "==== GCP リソース現状確認 (project=$PROJECT region=$REGION) ===="

# === 1. 依存コマンド確認 ===
for c in gcloud kubectl; do
  command -v "$c" >/dev/null 2>&1 || fail "必須コマンドが見つかりません: $c"
done
ok "[deps] gcloud + kubectl 検出"

# === 2. kubectl context 確認 (= GKE 接続前提) ===
# GKE Autopilot cluster context 名は `gke_<project>_<region>_<cluster>` 形式。
# project + region + cluster の 3 フィールド全てを検証する (= 別 project / 別 region の同名 cluster
# が current のとき namespace 確認 §7 で誤検出 OK にならないようにする)。
# 名前ベース match のため、$GKE_CLUSTER / $REGION / $PROJECT に shell glob (* / ?) を入れないこと。
ctx="$(kubectl config current-context 2>/dev/null || echo NONE)"
expected_ctx="gke_${PROJECT}_${REGION}_${GKE_CLUSTER}"
if [ "$ctx" = "$expected_ctx" ]; then
  ok "[ctx] $ctx"
else
  fail "[ctx] expected=$expected_ctx, actual=$ctx (gcloud container clusters get-credentials $GKE_CLUSTER --region=$REGION --project=$PROJECT)"
fi

# === 3. GKE cluster の生存確認 (gcloud 側) ===
# Autopilot cluster は RUNNING 以外でも describe は返るため、status で正規化。
status="$(gcloud container clusters describe "$GKE_CLUSTER" --region "$REGION" --project "$PROJECT" --format='value(status)' 2>/dev/null || echo MISSING)"
case "$status" in
  RUNNING)
    ok "[gke] cluster $GKE_CLUSTER RUNNING"
    ;;
  MISSING)
    fail "[gke] cluster $GKE_CLUSTER 存在しない or 権限不足 (gcloud container clusters create-auto $GKE_CLUSTER --region=$REGION --project=$PROJECT で作成)"
    ;;
  *)
    warn "[gke] cluster $GKE_CLUSTER 異常状態 (status=$status)"
    WARN_COUNT=$((WARN_COUNT + 1))
    ;;
esac

# === 4. Cloud SQL instance 確認 ===
# §3 GKE cluster と異なり MISSING でも fail にしない: teardown 直後や未構築では存在しないことが
# 「設計通りの中間状態」であり、orchestrator が起動できない事実を warn で通知して後続チェックを
# 完走させる方が運用上の情報量が大きい (= §3 GKE は cluster 無いと resource-check 自体の前提が崩れる
# ため fail、§4 Cloud SQL は teardown 確認や再構築 dry-run の通常文脈で MISSING が出る)。
state="$(gcloud sql instances describe "$CLOUD_SQL_INSTANCE" --project "$PROJECT" --format='value(state)' 2>/dev/null || echo MISSING)"
case "$state" in
  RUNNABLE)
    ok "[sql] $CLOUD_SQL_INSTANCE RUNNABLE"
    ;;
  MISSING)
    warn "[sql] $CLOUD_SQL_INSTANCE 存在しない (= teardown 済 or 未構築の可能性、orchestrator は起動できない)"
    WARN_COUNT=$((WARN_COUNT + 1))
    ;;
  *)
    warn "[sql] $CLOUD_SQL_INSTANCE 異常状態 (state=$state)"
    WARN_COUNT=$((WARN_COUNT + 1))
    ;;
esac

# === 5. Secret Manager biblio-gh-app-pem 確認 ===
# 無いと fetch-pem initContainer (= 本物 init、run-to-completion) が PEM 取得に失敗して
# orchestrator Pod 自体が起動しない (= gh-token-rotator や onecli sidecar に到達する手前で詰まる)
# ため fail。
if gcloud secrets describe "$SM_GH_PEM_NAME" --project "$PROJECT" >/dev/null 2>&1; then
  ok "[sm] $SM_GH_PEM_NAME 存在"
else
  fail "[sm] $SM_GH_PEM_NAME 未投入 or 権限不足 (gcloud secrets create $SM_GH_PEM_NAME --data-file=<pem> + biblio-orchestrator GSA に roles/secretmanager.secretAccessor)"
fi

# === 6. Artifact Registry biblio-claw 確認 ===
# 初回 setup 時にまだ無い可能性があるため warn 扱い。
if gcloud artifacts repositories describe "$AR_REPO_NAME" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  ok "[ar] $AR_REPO_NAME リポジトリ存在"
else
  warn "[ar] $AR_REPO_NAME リポジトリ未作成 (gcloud artifacts repositories create $AR_REPO_NAME --repository-format=docker --location=$REGION --project=$PROJECT)"
  WARN_COUNT=$((WARN_COUNT + 1))
fi

# === 7. GKE 内 namespace 確認 (verify-phase-2-wiring.sh への引き継ぎ前提) ===
# StatefulSet / PVC / Sidecar 等の中身は verify-phase-2-wiring.sh の領分のためここで止める。
if kubectl get ns "$NS" >/dev/null 2>&1; then
  ok "[ns] $NS exists"
else
  fail "[ns] namespace $NS が存在しない (kubectl apply -f k8s/00-namespace.yaml)"
fi

# === 集計 ===
if [ "$WARN_COUNT" -gt 0 ]; then
  printf '\n' >&2
  warn "==== resource-check 完了 (WARN=$WARN_COUNT) — 要確認 ===="
  info "GKE 内のリソース (StatefulSet / PVC / Sidecar / OneCLI REST / Slack adapter) は次に: bash scripts/verify-phase-2-wiring.sh"
else
  ok "==== resource-check 完了 (全 OK) ===="
  info "次のステップ: bash scripts/verify-phase-2-wiring.sh で GKE 内のリソースを確認"
fi
