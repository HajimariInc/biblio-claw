variable "project_id" {
  description = <<-EOT
    GCP project id (biblio-claw deploy 対象)。
    default 値なし = **apply 時に `TF_VAR_project_id` env で明示指定を強制** し、
    Source of Truth を repo 外に出す (公開ポリシー: 静的ファイルに project id を出さない、
    他 module と同流儀)。
  EOT
  type        = string
  # default 値なし = 必須化
}

variable "region" {
  description = "GCP region (regional resources 用)。Secret Manager 自体は region 非依存 (auto replication)、provider block の要求のみ"
  type        = string
  default     = "asia-northeast1"
}

variable "orchestrator_gsa_email" {
  description = <<-EOT
    既存 biblio-orchestrator GSA email (secret accessor role 付与先。新 GSA を切らない = 1 workload = 1 GSA 原則、Fugue module と同流儀)。
    default 値なし = **apply 時に `TF_VAR_orchestrator_gsa_email` env で明示指定を強制**
    (例: `biblio-orchestrator@$${var.project_id}.iam.gserviceaccount.com` を呼出側で組み立て)。
  EOT
  type        = string
  # default 値なし = 必須化 (var.project_id への参照式が default では書けないため)
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
