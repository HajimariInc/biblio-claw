# ------------------- IAM binding: orchestrator → drive-user (R4 経路) -------------------
# life-capabilities の Drive access 経路 (R4 = SA 2 段 impersonation) を成立させる
# ための IAM binding。orchestrator GSA が drive-user GSA を impersonate して
# `iamcredentials.googleapis.com/v1/.../generateAccessToken` で drive.readonly scope 付き
# access token を発行できるようにする。
#
# ## なぜ target SA を分離するか (biblio-google-drive-user@)
# orchestrator GSA (biblio-orchestrator@) は Vertex / GH / Cloud SQL IAM 認証 / OneCLI 等
# 多方面の権限を持つ。ここに Drive access も相乗りさせると誤経路で Drive を叩けてしまう
# 攻撃面が広がる。R4 は「Drive 専用の SA」を Drive フォルダ ACL に共有し、orchestrator は
# 「その SA を impersonate する権限」だけを持つ = 権限最小化 + 境界明快。
#
# ## GSA 本体は Terraform 管理外
# `biblio-google-drive-user@` GSA 自体は operator が GCP Console で作成済 (手動 lifecycle)。
# 本 module では GSA 作成は行わず、既存 GSA に対する binding のみを宣言する。GSA を消したり
# 再作成したりする operation は Console 側で明示的に行う (Terraform 側は state 依存を持たない)。
#
# ## Drive フォルダ ACL は Terraform 管理外
# Drive フォルダの ACL は Google Drive リソース側の設定であり、GCP IAM の管轄外。
# operator が Drive UI で `biblio-google-drive-user@...` を「閲覧者」として共有すること。
# 本 module では ACL 状態を assert しない (Terraform provider に該当 resource がないため)。
#
# ## 前提となる API 有効化
# `iamcredentials.googleapis.com` が project で enabled になっていること (本 module では
# API 有効化は担わない = project レベルで一括管理される想定、`gcloud services enable` or
# 別 Terraform で先行)。
resource "google_service_account_iam_member" "orchestrator_impersonates_drive_user" {
  service_account_id = "projects/${var.project_id}/serviceAccounts/${var.drive_user_gsa_email}"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${var.orchestrator_gsa_email}"
}
