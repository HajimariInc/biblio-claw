# =============================================================================
# M4-E Phase 5: Fugue channel infra (GKE Ingress + Google-managed cert + DNS +
# Secret Manager + secret-scoped IAM binding)
#
# 主要判断:
# - GCE Ingress + `pre-shared-cert` annotation パターン (Gateway API は Google-managed
#   cert の自動発行に非対応)
# - static IP + Cloud DNS で FQDN → LB の routing を宣言 (annotation で Ingress が引く)
# - `google_secret_manager_secret_iam_member` (secret scope) で最小権限
# - 既存 `biblio-orchestrator` GSA に role を追加 (1 workload = 1 GSA 原則)
# =============================================================================

# ------------------- Static IP (Ingress + DNS 両方が参照) --------------------
resource "google_compute_global_address" "fugue_channel_ip" {
  name        = "biblio-fugue-channel-ip"
  description = "Static IP for biblio-claw Fugue channel GCE Ingress (Phase 5)"
}

# ------------------- Google-managed SSL certificate ---------------------------
# provisioning は最大 60 分待ち。cert Active 化を待つ間に StatefulSet update を先に
# 済ませて時間ロス最小化する運用 (runbook §M4-E Phase 5 参照)。
resource "google_compute_managed_ssl_certificate" "fugue_channel_cert" {
  name = "biblio-fugue-channel-cert"
  managed {
    domains = [var.domain_name]
  }
}

# ------------------- Cloud DNS A record ---------------------------------------
# 既存 zone を data source で参照。zone 不在なら Terraform apply 前に
# `gcloud dns managed-zones create` (別プロジェクト管理の可能性あり) が必要。
data "google_dns_managed_zone" "existing" {
  name = var.dns_zone_name
}

resource "google_dns_record_set" "fugue_channel_a" {
  name         = "${var.domain_name}."
  type         = "A"
  ttl          = 300
  managed_zone = data.google_dns_managed_zone.existing.name
  rrdatas      = [google_compute_global_address.fugue_channel_ip.address]
}

# ------------------- Secret Manager fugue-shared-token -----------------------
resource "google_secret_manager_secret" "fugue_token" {
  secret_id = "fugue-shared-token"
  replication {
    auto {}
  }
}

# create_before_destroy = true = rotation 時に新版を先に作ってから旧版を無効化する
# 順序を保証 = 短時間の secret 不在で Pod が 401 を返す silent failure を防ぐ。
resource "google_secret_manager_secret_version" "fugue_token_v1" {
  secret      = google_secret_manager_secret.fugue_token.id
  secret_data = var.fugue_shared_token

  lifecycle {
    create_before_destroy = true
  }
}

# ------------------- Secret-scoped IAM binding (最小権限) --------------------
# `google_project_iam_member` (project scope) より blast radius が狭い secret scope。
# 既存 biblio-orchestrator GSA に対して fugue-shared-token 単体の accessor role のみ付与。
resource "google_secret_manager_secret_iam_member" "fugue_token_accessor" {
  secret_id = google_secret_manager_secret.fugue_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.orchestrator_gsa_email}"
}
