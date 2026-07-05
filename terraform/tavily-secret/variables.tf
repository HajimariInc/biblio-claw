variable "project_id" {
  description = "GCP project id (biblio-claw deploy 対象)"
  type        = string
  default     = "hajimari-ai-hackathon-2026"
}

variable "region" {
  description = "GCP region (regional resources 用)。Secret Manager 自体は region 非依存 (auto replication)、provider block の要求のみ"
  type        = string
  default     = "asia-northeast1"
}

variable "orchestrator_gsa_email" {
  description = "既存 biblio-orchestrator GSA email (secret accessor role 付与先。新 GSA を切らない = 1 workload = 1 GSA 原則、Fugue module と同流儀)"
  type        = string
  default     = "biblio-orchestrator@hajimari-ai-hackathon-2026.iam.gserviceaccount.com"
}

variable "tavily_api_key" {
  description = <<-EOT
    Tavily Web 検索 API key (プレフィックス `tvly-`、無料枠 1,000 credits/月)。
    取得: https://tavily.com/ → account 作成 → Dashboard → API keys。
    static key (Vertex ADC のような TTL rotation 不要) = 一度投入すれば OneCLI (Cloud SQL Postgres 永続化)
    が保持。regenerate 時のみ `terraform apply -var="tavily_api_key=tvly-..."` で新 version を追加。
    default 値なし = 必須化 (apply 時に `TF_VAR_tavily_api_key` env で明示指定を強制)。
  EOT
  type        = string
  sensitive   = true
  # default 値なし = 必須化
}
