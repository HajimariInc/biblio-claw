variable "project_id" {
  description = <<-EOT
    GCP project id (biblio-claw deploy 対象)。
    default 値なし = **apply 時に `TF_VAR_project_id` env で明示指定を強制** し、
    Source of Truth を repo 外に出す (公開ポリシー: 静的ファイルに project id を出さない、
    `fugue-channel` module と同流儀)。
  EOT
  type        = string
  # default 値なし = 必須化
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
    (1 workload = 1 GSA 原則、他 module と同流儀)。
    default 値なし = **apply 時に `TF_VAR_orchestrator_gsa_email` env で明示指定を強制**
    (例: `biblio-orchestrator@$${var.project_id}.iam.gserviceaccount.com` を呼出側で組み立て)。
  EOT
  type        = string
  # default 値なし = 必須化 (var.project_id への参照式が default では書けないため)
}

variable "drive_user_gsa_email" {
  description = <<-EOT
    Drive access 専用の分離 SA email (target SA、binding のみ管理 = main.tf 冒頭コメント参照)。
    orchestrator SA が本 SA を impersonate して drive.readonly scope 付き access token を発行する。
    Drive フォルダ ACL の共有先もこの SA email。
    default 値なし = **apply 時に `TF_VAR_drive_user_gsa_email` env で明示指定を強制**
    (例: `biblio-google-drive-user@$${var.project_id}.iam.gserviceaccount.com` を呼出側で組み立て)。
  EOT
  type        = string
  # default 値なし = 必須化 (var.project_id への参照式が default では書けないため)
}
