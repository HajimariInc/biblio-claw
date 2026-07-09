# ------------------- IAM binding: orchestrator → BigQuery (M4-C reporting) -------------------
# M4-C 週次 reporting CronJob が Prod GKE Autopilot 上で BQ を read するための最小権限セット。
#
# 付与内容:
#   1. project-scoped `roles/bigquery.jobUser` — BQ query job の submit 可
#      (repo 初の google_project_iam_member 使用例、他 module は SA-scoped / dataset-scoped)
#   2. dataset-scoped `roles/bigquery.dataViewer` on `llm_observability` — 該当 dataset の
#      table を read 可 (project-scoped BQ 権限は与えず、対象 dataset に絞る)
#
# ## 権限最小化の判断
# - `bigquery.jobUser` を project-scoped で付与するのは、BQ job submit 権限が project scope
#   より下 (dataset scope) に存在しないため。CronJob は job を作成する必要があるので必須。
# - 実 table read 権限は dataset-scoped で絞る。project 全 dataset を舐められる
#   `bigquery.dataViewer` project-wide は付与しない。
#
# ## 前提となる状態
# - `biblio-orchestrator@<PROJECT_ID>.iam.gserviceaccount.com` GSA が存在 (init-project-gcp
#   フロー or 別 Console lifecycle で作成済)。本 module は既存 GSA に対する binding のみ宣言。
# - `llm_observability` dataset (= `terraform/m4-a-observability` module の apply 済) が
#   存在。dataset 作成は M4-A 側の責務で、本 module は data 参照のみ。
#
# ## GSA 本体 / dataset 本体は他 module の管轄
# 本 module が対象とするのは IAM binding 2 件のみ。GSA の作成は Console (手動 lifecycle)、
# dataset の作成は `terraform/m4-a-observability`。lifecycle 境界を明確化することで
# apply 失敗時の rollback 範囲を最小化する。

# 既存 dataset を data 参照 (作成しない、apply 前提として存在必須)
data "google_bigquery_dataset" "logs" {
  project    = var.project_id
  dataset_id = var.dataset_id
}

# 1. project-scoped bigquery.jobUser (BQ job submit 権限)
resource "google_project_iam_member" "orchestrator_bq_job_user" {
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${var.orchestrator_gsa_email}"
}

# 2. dataset-scoped bigquery.dataViewer on llm_observability (table read 権限)
resource "google_bigquery_dataset_iam_member" "orchestrator_dataset_reader" {
  project    = var.project_id
  dataset_id = data.google_bigquery_dataset.logs.dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = "serviceAccount:${var.orchestrator_gsa_email}"
}
