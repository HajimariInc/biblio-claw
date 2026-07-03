output "static_ip_name" {
  description = "Ingress annotation `kubernetes.io/ingress.global-static-ip-name` に渡す名前"
  value       = google_compute_global_address.fugue_channel_ip.name
}

output "static_ip_address" {
  description = "Cloud DNS の外部確認用 (dig で反映確認)"
  value       = google_compute_global_address.fugue_channel_ip.address
}

output "cert_name" {
  description = "Ingress annotation `ingress.gcp.kubernetes.io/pre-shared-cert` に渡す名前"
  value       = google_compute_managed_ssl_certificate.fugue_channel_cert.name
}

output "dns_record_name" {
  description = "Cloud DNS record 名 (`.` 付き末尾の FQDN)。疎通確認用"
  value       = google_dns_record_set.fugue_channel_a.name
}

output "secret_name" {
  description = "K8s Secret 作成時 `gcloud secrets versions access` で参照する secret_id"
  value       = google_secret_manager_secret.fugue_token.secret_id
}
