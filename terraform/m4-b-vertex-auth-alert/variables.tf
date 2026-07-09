variable "project_id" {
  description = <<-EOT
    GCP project ID (biblio-claw deploy 対象).
    default 値なし = **apply 時に `TF_VAR_project_id` env で明示指定を強制** し、
    Source of Truth を repo 外に出す (公開ポリシー: 静的ファイルに project id を出さない、
    他 module と同流儀)。
  EOT
  type        = string
}

variable "k8s_namespace" {
  description = "GKE namespace 名。log filter の resource.labels.namespace_name に使用。"
  type        = string
  default     = "biblio-claw"
}

variable "slack_channel_name" {
  description = <<-EOT
    Slack channel 名 (`#biblio-alerts` 等)。alert 通知の宛先。Slack Workspace 側で
    Cloud Monitoring OAuth app を install 済であること前提。
  EOT
  type        = string
}

variable "slack_webhook_token" {
  description = <<-EOT
    Slack OAuth token (`xoxb-*`)。`google_monitoring_notification_channel.sensitive_labels`
    の `auth_token` に入る。`TF_VAR_slack_webhook_token` env で渡す。
    Terraform state に平文で入らないよう sensitive marker を付ける。
  EOT
  type        = string
  sensitive   = true
}

variable "alert_display_name" {
  description = "alert policy の display name。UI で識別しやすい string を指定。"
  type        = string
  default     = "Vertex Auth Heartbeat Failed (issue #136)"
}

variable "notification_rate_limit_period" {
  description = <<-EOT
    Slack 通知の rate limit period (秒)。同 alert が 5min 内に複数回発火しても Slack
    通知は 1 回だけ = alert 洪水回避。log-based alert では **必須** (公式仕様)。
  EOT
  type        = string
  default     = "300s"
}

variable "auto_close_duration" {
  description = <<-EOT
    incident 自動 close 期間 (秒、default 7 日)。log-based alert は log が discrete event
    で "CLOSED" 状態を持たないため、明示 close 忘れによる incident 滞留を防ぐ safety net。
  EOT
  type        = string
  default     = "604800s"
}

variable "renotify_interval" {
  description = <<-EOT
    12h 経過しても incident が close されていなければ Slack に再通知する間隔 (秒)。
    公式 spec で 30min-24h の範囲 (1800-86400)。運用忘れの safety net。
  EOT
  type        = string
  default     = "43200s"
}
