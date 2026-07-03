variable "project_id" {
  description = "GCP project id (biblio-claw deploy 対象)"
  type        = string
  default     = "hajimari-ai-hackathon-2026"
}

variable "region" {
  description = "GCP region (regional resources 用)。global cert / global IP は region 非依存"
  type        = string
  default     = "asia-northeast1"
}

variable "domain_name" {
  description = "Fugue channel 公開ドメイン (Google-managed cert の SAN + DNS A record)"
  type        = string
  default     = "biblio-claw.fugue-channel.hajimari-ai-hackathon-2026.app"
}

variable "dns_zone_name" {
  description = "Cloud DNS zone name (data source で参照する既存 zone)。事前に `gcloud dns managed-zones list` で確認"
  type        = string
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
