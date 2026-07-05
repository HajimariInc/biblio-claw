output "drive_user_gsa_email" {
  description = "Drive access 専用の target SA email (Drive フォルダ ACL 共有先、`onecli-drive-secret.sh` の DRIVE_USER_SA 既定値)"
  value       = var.drive_user_gsa_email
}

output "orchestrator_gsa_email" {
  description = "impersonation 経路の caller SA email (metadata server 経由で ADC を取得する主体、debug 用)"
  value       = var.orchestrator_gsa_email
}
