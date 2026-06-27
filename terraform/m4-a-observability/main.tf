locals {
  # biblio-claw namespace の全 container ログを抽出。
  # component (host-orchestrator / gh-token-rotator / vertex-token-rotator / agent-runner) は
  # jsonPayload.component で BQ 側で分類可能、sink 側では細分しない。
  sink_filter = "resource.type=\"k8s_container\" AND resource.labels.namespace_name=\"${var.k8s_namespace}\""
}

resource "google_project_service" "bigquery" {
  project            = var.project_id
  service            = "bigquery.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "logging" {
  project            = var.project_id
  service            = "logging.googleapis.com"
  disable_on_destroy = false
}

resource "google_bigquery_dataset" "logs" {
  project                     = var.project_id
  dataset_id                  = var.dataset_id
  location                    = var.region
  description                 = "biblio-claw M4-A observability logs (Cloud Logging sink target)."
  default_table_expiration_ms = var.default_table_expiration_ms
  delete_contents_on_destroy  = false

  depends_on = [google_project_service.bigquery]
}

resource "google_logging_project_sink" "biblio" {
  project                = var.project_id
  name                   = var.sink_name
  destination            = "bigquery.googleapis.com/projects/${var.project_id}/datasets/${google_bigquery_dataset.logs.dataset_id}"
  filter                 = local.sink_filter
  unique_writer_identity = true

  bigquery_options {
    use_partitioned_tables = true
  }

  depends_on = [google_project_service.logging]
}

resource "google_bigquery_dataset_iam_member" "sink_writer" {
  project    = var.project_id
  dataset_id = google_bigquery_dataset.logs.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = google_logging_project_sink.biblio.writer_identity
}
