variable "project_id" {
  description = "GCP project ID (biblio-claw ハッカソン環境)."
  type        = string
  default     = "hajimari-ai-hackathon-2026"
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
