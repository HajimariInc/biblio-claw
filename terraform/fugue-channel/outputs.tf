output "static_ip_name" {
  description = "Ingress annotation `kubernetes.io/ingress.global-static-ip-name` に渡す名前"
  value       = google_compute_global_address.fugue_channel_ip.name
}

output "static_ip_address" {
  description = "Cloud Endpoints Service の target (自動反映) + dig 疎通確認用"
  value       = google_compute_global_address.fugue_channel_ip.address
}

output "cert_name" {
  description = "Ingress annotation `ingress.gcp.kubernetes.io/pre-shared-cert` に渡す名前"
  value       = google_compute_managed_ssl_certificate.fugue_channel_cert.name
}

output "endpoints_service_name" {
  description = "Cloud Endpoints Service 名 = DNS record 対象。`gcloud endpoints services describe` 等で状態確認用"
  value       = google_endpoints_service.fugue_dns.service_name
}

output "fugue_token_secret_name" {
  description = "K8s Secret 作成時 `gcloud secrets versions access --secret=<この値>` 用"
  value       = google_secret_manager_secret.fugue_token.secret_id
}

output "fugue_domain_secret_name" {
  description = "K8s manifest apply + verify で参照する domain の Source of Truth (`gcloud secrets versions access --secret=<この値>` 経由)"
  value       = google_secret_manager_secret.fugue_domain.secret_id
}
