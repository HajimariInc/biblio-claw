output "orchestrator_gsa_email" {
  description = "IAM binding が付いた主体 SA email (verify 表示用)."
  value       = var.orchestrator_gsa_email
}

output "dataset_id" {
  description = "read 権限を付与した dataset (project-qualified)."
  value       = "${var.project_id}:${data.google_bigquery_dataset.logs.dataset_id}"
}

output "bindings" {
  description = "本 module が付与した role の一覧 (verify 表示用)."
  value = [
    "roles/bigquery.jobUser (project-scoped)",
    "roles/bigquery.dataViewer (dataset-scoped on ${data.google_bigquery_dataset.logs.dataset_id})",
  ]
}
