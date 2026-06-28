output "dataset_id" {
  description = "BigQuery dataset ID (project-qualified)."
  value       = "${var.project_id}:${google_bigquery_dataset.logs.dataset_id}"
}

output "sink_name" {
  description = "Cloud Logging sink name."
  value       = google_logging_project_sink.biblio.name
}

output "writer_identity" {
  description = "Sink writer service account (granted roles/bigquery.dataEditor)."
  value       = google_logging_project_sink.biblio.writer_identity
}

output "expected_table_hint" {
  description = "Expected BQ table name hint (Cloud Logging derives from logName; confirm with `bq ls` after first emit)."
  value       = "${var.project_id}:${var.dataset_id}.<logname_normalized>"
}
