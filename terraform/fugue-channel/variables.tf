variable "project_id" {
  description = <<-EOT
    GCP project id (biblio-claw deploy 対象)。
    default 値なし = **apply 時に `TF_VAR_project_id` env で明示指定を強制** し、
    Source of Truth を repo 外に出す (公開ポリシー: 静的ファイルに project id を出さない、
    `domain_name` 慣習と対称)。
  EOT
  type        = string
  # default 値なし = 必須化
}

variable "region" {
  description = "GCP region (regional resources 用)。global cert / global IP / Endpoints Service は region 非依存"
  type        = string
  default     = "asia-northeast1"
}

variable "domain_name" {
  description = <<-EOT
    Fugue channel 公開ドメイン。Cloud Endpoints で払い出す `.cloud.goog` sub-domain を指定
    (例: `biblio-claw-fugue.endpoints.<your-gcp-project>.cloud.goog`)。
    default 値なし = **apply 時に `TF_VAR_domain_name` env で明示指定を強制** し、Source of Truth を
    Secret Manager `fugue-domain-name` に一元化する (公開ポリシー: 静的ファイルにホスト名を出さない)。
  EOT
  type        = string
  # default 値なし = 必須化
}

variable "orchestrator_gsa_email" {
  description = <<-EOT
    既存 biblio-orchestrator GSA email (secret accessor role 付与先。新 GSA を切らない = 1 workload = 1 GSA 原則)。
    default 値なし = **apply 時に `TF_VAR_orchestrator_gsa_email` env で明示指定を強制**
    (例: `biblio-orchestrator@$${var.project_id}.iam.gserviceaccount.com` を呼出側で組み立て)。
  EOT
  type        = string
  # default 値なし = 必須化 (var.project_id への参照式が default では書けないため)
}

variable "fugue_shared_token" {
  description = "Fugue Cloud Run と共有する Bearer token (`openssl rand -hex 32` 相当を投入)"
  type        = string
  sensitive   = true
}
