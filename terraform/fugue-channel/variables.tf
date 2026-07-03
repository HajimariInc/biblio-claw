variable "project_id" {
  description = "GCP project id (biblio-claw deploy 対象)"
  type        = string
  default     = "hajimari-ai-hackathon-2026"
}

variable "region" {
  description = "GCP region (regional resources 用)。global cert / global IP / Endpoints Service は region 非依存"
  type        = string
  default     = "asia-northeast1"
}

variable "domain_name" {
  description = <<-EOT
    Fugue channel 公開ドメイン。Cloud Endpoints で払い出す `.cloud.goog` sub-domain を指定
    (例: `biblio-claw-fugue.endpoints.hajimari-ai-hackathon-2026.cloud.goog`)。
    default 値なし = **apply 時に `TF_VAR_domain_name` env で明示指定を強制** し、Source of Truth を
    Secret Manager `fugue-domain-name` に一元化する (公開ポリシー: 静的ファイルにホスト名を出さない)。
  EOT
  type        = string
  # default 値なし = 必須化
}

variable "orchestrator_gsa_email" {
  description = "既存 biblio-orchestrator GSA email (secret accessor role 付与先。新 GSA を切らない = 1 workload = 1 GSA 原則)"
  type        = string
  default     = "biblio-orchestrator@hajimari-ai-hackathon-2026.iam.gserviceaccount.com"
}

variable "fugue_shared_token" {
  description = "Fugue Cloud Run と共有する Bearer token (`openssl rand -hex 32` 相当を投入)"
  type        = string
  sensitive   = true
}
