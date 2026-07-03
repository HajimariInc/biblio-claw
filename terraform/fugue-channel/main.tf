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

# create_before_destroy = true が守るのは **Secret Manager 側の `latest` alias の継続性**
# (Terraform apply で secret_data を更新するとき、新 version を先に作成 → `latest` alias が
# 新 version を指した状態を維持しつつ旧 version を destroy する順序を保証)。これにより、
# Terraform apply の実行中に `latest` を読む他の caller (別 Terraform module / CI script /
# 手動 gcloud command 等) が「一瞬 secret が消えた」状態を観測しない。
#
# ⚠️ 注: K8s Secret `biblio-fugue-shared-token` (Pod が envFrom で読む) は Terraform 管理外の
# 別経路 (`docs/operations-runbook.md` §M4-E Phase 5 Step 4 の手動 `kubectl create secret
# --from-literal="$(gcloud secrets versions access latest ...)"`) で sync するため、本
# lifecycle は Pod 401 応答を直接には防がない。**K8s Secret 側は手動 rotation 時に別途
# 再作成が必要** (現状 Phase 5 は手動運用、rotator sidecar は Phase 90+ で別 PRP 予定)。
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
