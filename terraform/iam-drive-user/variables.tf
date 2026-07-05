variable "project_id" {
  description = "GCP project id (biblio-claw deploy 対象)"
  type        = string
  default     = "hajimari-ai-hackathon-2026"
}

variable "region" {
  description = "GCP region (provider block の要求のみ、IAM binding 自体は region 非依存)"
  type        = string
  default     = "asia-northeast1"
}

variable "orchestrator_gsa_email" {
  description = <<-EOT
    既存 biblio-orchestrator GSA email。R4 経路の caller SA (metadata server 経由で ADC を取得する主体)。
    本 module では target SA (drive-user) 上に `roles/iam.serviceAccountTokenCreator` を持つ member として binding される。
    (1 workload = 1 GSA 原則、他 module と同流儀)
  EOT
  type        = string
  default     = "biblio-orchestrator@hajimari-ai-hackathon-2026.iam.gserviceaccount.com"
}

variable "drive_user_gsa_email" {
  description = <<-EOT
    Drive access 専用の分離 SA email (target SA)。orchestrator SA が本 SA を impersonate して
    drive.readonly scope 付き access token を発行する。GSA 本体は本 module では作成しない (DEN さんが
    Console で作成済 = 手動 lifecycle) — 本 module は binding のみを管理する。
    Drive 側 ACL 共有先はこの SA email。
  EOT
  type        = string
  default     = "biblio-google-drive-user@hajimari-ai-hackathon-2026.iam.gserviceaccount.com"
}
