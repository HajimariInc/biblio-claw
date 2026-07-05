output "secret_id" {
  description = "Secret Manager の secret ID (`onecli-tavily-secret.sh` が `gcloud secrets versions access` の `--secret` に渡す値)"
  value       = google_secret_manager_secret.tavily_api_key.secret_id
}

output "secret_name" {
  description = "Secret Manager の完全な resource name (`projects/*/secrets/*` 形式、他 Terraform module から参照する場合用)"
  value       = google_secret_manager_secret.tavily_api_key.name
}
