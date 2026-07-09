variable "project_id" {
  description = <<-EOT
    GCP project id (biblio-claw deploy 対象)。
    default 値なし = **apply 時に `TF_VAR_project_id` env で明示指定を強制** し、
    Source of Truth を repo 外に出す (公開ポリシー: 静的ファイルに project id を出さない、
    `m4-a-observability` / `iam-drive-user` / `fugue-channel` module と同流儀)。
  EOT
  type        = string
  # default 値なし = 必須化
}

variable "region" {
  description = "GCP region (provider block の要求のみ、IAM binding 自体は region 非依存)."
  type        = string
  default     = "asia-northeast1"
}

variable "dataset_id" {
  description = <<-EOT
    BigQuery dataset を参照する ID。`terraform/m4-a-observability/variables.tf` の default と
    整合させる必要があり、M4-A 側の default をそのまま踏襲。
  EOT
  type        = string
  default     = "llm_observability"
}

variable "orchestrator_gsa_email" {
  description = <<-EOT
    既存 biblio-orchestrator GSA email。M4-C reporting CronJob が K8s WI 経由で
    assume する主体 SA。本 module では以下 2 role を付与する:
    - project-scoped `roles/bigquery.jobUser` (CronJob が BQ query job を submit 可)
    - dataset-scoped `roles/bigquery.dataViewer` on `llm_observability` (read 権限)
    (1 workload = 1 GSA 原則、他 module と同流儀)。
    default 値なし = **apply 時に `TF_VAR_orchestrator_gsa_email` env で明示指定を強制**
    (例: `biblio-orchestrator@$${var.project_id}.iam.gserviceaccount.com` を呼出側で組み立て)。
  EOT
  type        = string
  # default 値なし = 必須化 (var.project_id への参照式が default では書けないため)
}
