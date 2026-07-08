#!/usr/bin/env bash
# biblio-claw: Cloud SQL Bootstrap GRANT 公式化スクリプト
#
# Postgres 15+ で IAM user に CREATE on public schema が default で付かない問題への対処。
#
# 何をするか:
#   gcloud sql connect (IAP TCP forwarding 経由) で postgres superuser として接続し、
#   biblio-orchestrator GSA の IAM user に biblio_onecli DB 上の必要 GRANT を一括適用する。
#   GRANT 再実行は no-op のため冪等 (= 何度実行しても安全)。
#
# 前提:
#   - GKE 環境 + Cloud SQL biblio-pgsql RUNNABLE
#   - 手元 gcloud + psql (postgresql-client) が install 済
#     (gcloud sql connect は内部で psql を呼ぶため、psql 不在だと run-time に詰まる)
#   - 手元 gcloud に roles/iap.tunnelResourceAccessor 権限 (IAP TCP forwarding 用)
#   - postgres superuser のパスワードが gcloud sql users set-password で設定済
#       gcloud sql users set-password postgres \
#         --instance=biblio-pgsql --password=<pw> --project=<project>
#     (未設定だと本スクリプト実行中に password prompt が出て止まる)
#   - biblio-orchestrator GSA が Cloud SQL IAM user として登録済
#       gcloud sql users create biblio-orchestrator@<project>.iam \
#         --instance=biblio-pgsql --type=cloud_iam_service_account \
#         --project=<project>
#
# 既定値 (env で上書き可、.env から読み込み):
#   GCP_PROJECT_ID=<your-gcp-project>
#   CLOUD_SQL_INSTANCE=biblio-pgsql
#   PGSQL_DB_NAME=biblio_onecli   (= OneCLI 内部 DB、k8s/10-orchestrator-statefulset.yaml の DATABASE_URL より)
#   PGSQL_IAM_USER=biblio-orchestrator@${GCP_PROJECT_ID}.iam
#     (= GSA email から ".gserviceaccount.com" を除いた Cloud SQL IAM user 命名規則)
#
# 使い方:
#   bash scripts/init-project-gcp-pgsql-grant.sh
#
# 根拠:
#   - PostgreSQL 15 Release Notes — PUBLIC から CREATE on public schema が剥奪
#     https://www.postgresql.org/docs/15/release-15.html
#   - Cloud SQL IAM Users — IAM user 作成後に DB 権限付与が必要
#     https://docs.cloud.google.com/sql/docs/postgres/add-manage-iam-users
#   - DDL Schemas Privileges (Postgres 15) — GRANT USAGE, CREATE ON SCHEMA public の根拠
#     https://www.postgresql.org/docs/15/ddl-schemas.html#DDL-SCHEMAS-PRIV

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
INSTANCE="${CLOUD_SQL_INSTANCE:-biblio-pgsql}"
DB_NAME="${PGSQL_DB_NAME:-biblio_onecli}"
IAM_USER="${PGSQL_IAM_USER:-biblio-orchestrator@${PROJECT}.iam}"

# === 依存コマンド ===
# gcloud sql connect は IAP TCP forwarding + psql を内部で呼ぶ。psql 不在で run-time に詰まる
# (gcloud 側のエラーメッセージが分かりにくいため、ここで先に弾く)。
for c in gcloud psql; do
  command -v "$c" >/dev/null 2>&1 || fail "必須コマンドが見つかりません: $c (postgresql-client パッケージを install)"
done

info "==== Cloud SQL Bootstrap GRANT (instance=$INSTANCE db=$DB_NAME iam_user=$IAM_USER) ===="

# === 前提アナウンス (gcloud sql connect の罠を明示) ===
info "前提 1: postgres superuser パスワードが gcloud sql users set-password で設定済"
info "        未設定なら本スクリプト実行中に password prompt が出て止まる"
info "        設定: gcloud sql users set-password postgres --instance=$INSTANCE --password=<pw> --project=$PROJECT"
info "前提 2: 手元 gcloud に roles/iap.tunnelResourceAccessor 権限 (IAP TCP forwarding 用)"

# === SQL ブロック (heredoc、bash 変数展開 + PG identifier quote の両立) ===
# "${IAM_USER}" を heredoc 内で bash が展開 → 結果が PG identifier として quote される
# (= "biblio-orchestrator@<your-gcp-project>.iam" 等、@ や - を含むので必須)。
#
# 冪等性 (= 同一 SQL の再実行で no-op になる根拠):
#   - GRANT: 既付与の権限への再実行は NOTICE なしに通過 (= 実質 no-op)
#   - GRANT ON ALL TABLES は実行時点で存在するテーブルのみが対象
#   - ALTER DEFAULT PRIVILEGES は将来作成されるテーブルへの権限を事前宣言する設計のため、
#     現在のテーブルへの GRANT (= GRANT ON ALL TABLES) と将来分の宣言 (= ALTER DEFAULT PRIVILEGES)
#     の両方が必要 (= 1 SQL では網羅できない)。再実行時の重複も PostgreSQL がエラーにせず通過。
SQL=$(cat <<EOF
-- biblio-claw: Bootstrap GRANT for ${IAM_USER} on ${DB_NAME}
GRANT CONNECT ON DATABASE "${DB_NAME}" TO "${IAM_USER}";
GRANT USAGE, CREATE ON SCHEMA public TO "${IAM_USER}";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${IAM_USER}";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${IAM_USER}";
EOF
)

info "適用する SQL:"
printf '%s\n' "$SQL" | sed 's/^/    /' >&2

info "Bootstrap GRANT 適用開始 (gcloud sql connect IAP 経由、psql バッチモード)"

# gcloud sql connect は IAP TCP forwarding 経由で psql session を張る。
# stdin に SQL を流すと psql のバッチモードで実行される。
# postgres password 未設定なら ここで prompt が出て止まる (= 上記前提を満たさないケース)。
#
# silent success 回避 (= psql は default で SQL エラーでも exit 0 を返す):
#   PGOPTIONS='-c ON_ERROR_STOP=1' を環境変数経由で psql に渡し、SQL エラー時に exit 3 を
#   返すよう強制する。これにより IAM user 未登録 / DB 名違い / 権限エラーで GRANT が失敗しても
#   `[OK] Bootstrap GRANT 完了` と誤表示される silent failure を防ぐ。
#   exit code: 0 = 全 SQL 成功 / 2 = 接続失敗 / 3 = SQL エラー
#   `gcloud sql connect` には psql フラグ専用オプションがないため PGOPTIONS env が唯一の手段。
#
# 注: `VAR=value cmd | other` 形式は cmd だけに VAR が渡る (= echo にだけ渡って効果なし) ため、
#     pipe 受け側の gcloud に PGOPTIONS を確実に届けるため export + unset で囲む。
export PGOPTIONS='-c ON_ERROR_STOP=1'
echo "$SQL" | gcloud sql connect "$INSTANCE" --user=postgres --database="$DB_NAME" --project="$PROJECT"
unset PGOPTIONS

ok "==== Bootstrap GRANT 完了 (db=$DB_NAME iam_user=$IAM_USER) ===="
info "確認: 同一 SQL を再実行しても no-op (= 冪等、PostgreSQL の GRANT 挙動)"
