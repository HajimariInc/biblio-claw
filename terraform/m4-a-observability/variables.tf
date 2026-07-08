variable "project_id" {
  description = <<-EOT
    GCP project ID (biblio-claw deploy 対象).
    default 値なし = **apply 時に `TF_VAR_project_id` env で明示指定を強制** し、
    Source of Truth を repo 外に出す (公開ポリシー: 静的ファイルに project id を出さない、
    他 module と同流儀)。
  EOT
  type        = string
  # default 値なし = 必須化
}

variable "region" {
  description = "BigQuery dataset region. GKE cluster region と一致必須 (不一致で無音 drop)."
  type        = string
  default     = "asia-northeast1"
}

variable "dataset_id" {
  description = "BigQuery dataset for biblio-claw observability logs."
  type        = string
  default     = "llm_observability"
}

variable "sink_name" {
  description = "Cloud Logging sink name."
  type        = string
  default     = "biblio-claw-to-bq"
}

variable "k8s_namespace" {
  description = "K8s namespace to filter logs from."
  type        = string
  default     = "biblio-claw"
}

variable "default_table_expiration_ms" {
  description = "BQ table expiration in milliseconds. 7776000000 = 90 days."
  type        = number
  default     = 7776000000
}
