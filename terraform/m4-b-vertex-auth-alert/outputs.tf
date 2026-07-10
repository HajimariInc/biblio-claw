output "notification_channel_name" {
  description = "Slack notification channel の resource name (Cloud Console で事前作成した既存 resource の passthrough)。"
  value       = var.notification_channel_name
}

output "alert_policy_name" {
  description = "Alert policy の resource name。verify-m4-b.sh Section 6.6 で参照。"
  value       = google_monitoring_alert_policy.vertex_auth_heartbeat_failed.name
}

output "alert_policy_display_name" {
  description = "Alert policy の display name (`gcloud alpha monitoring policies list --filter` で使用)。"
  value       = google_monitoring_alert_policy.vertex_auth_heartbeat_failed.display_name
}
