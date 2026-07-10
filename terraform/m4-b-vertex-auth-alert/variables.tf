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

variable "notification_channel_name" {
  description = <<-EOT
    Cloud Console で事前作成した Slack notification channel の resource name。
    形式: `projects/<PROJECT_ID>/notificationChannels/<numeric-id>`
    (例: `projects/<your-gcp-project>/notificationChannels/10737247742413738863`)

    経緯 (issue #136 対応時、DEN さん判断):
      Google Cloud Monitoring 公式 app の Slack Bot User OAuth Token (`xoxb-*`) は Google 側
      管理のため DEN さん側から取得不可 = Terraform で `google_monitoring_notification_channel`
      resource を直接作れない (auth_token label が要求される)。Cloud Console UI 経由で
      Slack authorize + channel 保存 + Test Connection まで完了させ、その resource name を
      本 variable で受け取る経路に倒した。

    確認 command (README.md も参照):
      curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
        "https://monitoring.googleapis.com/v3/projects/PROJECT_ID/notificationChannels" \
        | jq -r '.notificationChannels[] | select(.type == "slack") | .name'
  EOT
  type        = string
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
