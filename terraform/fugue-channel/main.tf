# =============================================================================
# Fugue channel infra (Cloud Endpoints DNS + Secret Manager)
#
# 主要判断:
# - GCE Ingress + `pre-shared-cert` annotation パターン (Gateway API は Google-managed
#   cert の自動発行に非対応)
# - Cloud Endpoints Service で `.cloud.goog` sub-domain を自動払い出し (Public DNS zone 不要、
#   全部本 project 内で完結、別組織側の作業ゼロ)。API management 機能は使わず
#   `x-google-endpoints` extension による DNS provisioning のみを拝借する公式パターン
# - Secret Manager `fugue-domain-name` に domain を保管 = Source of Truth 一元化
#   (`.env` / k8s manifest 等の静的ファイルにホスト名を hardcode しない、公開ポリシー準拠)
# - `google_secret_manager_secret_iam_member` (secret scope) で最小権限
# - 既存 `biblio-orchestrator` GSA に role を追加 (1 workload = 1 GSA 原則)
# =============================================================================

# ------------------- Static IP (Ingress + Endpoints DNS 両方が参照) ----------
resource "google_compute_global_address" "fugue_channel_ip" {
  name        = "biblio-fugue-channel-ip"
  description = "Static IP for biblio-claw Fugue channel GCE Ingress"
}

# ------------------- Google-managed SSL certificate ---------------------------
# `.cloud.goog` sub-domain も Load Balancer authorization で発行可能。ただし Active 化には
# **K8s Ingress apply (LB backend authorization) が前提条件** = Terraform apply 直後に
# cert Active を待っても `PROVISIONING` + `FAILED_NOT_VISIBLE` で無限 stuck する
# (実 deploy で判明した managed-cert PROVISIONING 制約)。
# 正しい順序: Terraform apply → DNS 反映 (`.cloud.goog` = 通常 5-10 分) → K8s Ingress apply
# (`k8s/25-ingress-fugue-channel.yaml`) → cert Active 待ち (Ingress apply 後 15-30 分、
# 最大 60 分)。
resource "google_compute_managed_ssl_certificate" "fugue_channel_cert" {
  name = "biblio-fugue-channel-cert"
  managed {
    domains = [var.domain_name]
  }
}

# ------------------- Cloud Endpoints Service (DNS provisioning) --------------
# `.cloud.goog` sub-domain の A record を自動払い出し。ESPv2 proxy 等の API management 機能は
# 使わず、`x-google-endpoints` extension による DNS record 作成だけを利用する公式サポート
# パターン (docs.cloud.google.com/endpoints/docs/openapi/get-started-kubernetes-engine 参照)。
#
# 前提: `gcloud services enable endpoints.googleapis.com` を apply 前に実行する
# (Fugue channel initial deploy 手順)。
resource "google_endpoints_service" "fugue_dns" {
  service_name = var.domain_name

  openapi_config = <<-EOT
    swagger: "2.0"
    info:
      description: "Cloud Endpoints DNS record for biblio-claw Fugue channel"
      title: "biblio-claw Fugue channel"
      version: "1.0.0"
    paths: {}
    host: "${var.domain_name}"
    x-google-endpoints:
      - name: "${var.domain_name}"
        target: "${google_compute_global_address.fugue_channel_ip.address}"
  EOT
}

# ------------------- Secret Manager: fugue-shared-token (Bearer 認証) -------
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
# 別経路 (`docs/operations-runbook.md` の手動 `kubectl create secret
# --from-literal="$(gcloud secrets versions access latest ...)"`) で sync するため、本
# lifecycle は Pod 401 応答を直接には防がない。**K8s Secret 側は手動 rotation 時に別途
# 再作成が必要** (現状は手動運用、自動化は将来検討)。
resource "google_secret_manager_secret_version" "fugue_token_v1" {
  secret      = google_secret_manager_secret.fugue_token.id
  secret_data = var.fugue_shared_token

  lifecycle {
    create_before_destroy = true
  }
}

resource "google_secret_manager_secret_iam_member" "fugue_token_accessor" {
  secret_id = google_secret_manager_secret.fugue_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.orchestrator_gsa_email}"
}

# ------------------- Secret Manager: fugue-domain-name (ホスト名 SoT) --------
# ホスト名を静的ファイルに出さないための Source of Truth。K8s Ingress manifest / verify
# scripts / Fugue チーム連携での URL 参照は全て本 Secret から動的取得する運用
# (docs/operations-runbook.md の全 Step で `gcloud secrets versions access
# --secret=fugue-domain-name` 経由)。application 側 (Pod 内) からは現状 domain を知る必要が
# ないが、将来 X-Forwarded-Host 検証等の需要が出た時に読める状態にしておく defensive 経路。
resource "google_secret_manager_secret" "fugue_domain" {
  secret_id = "fugue-domain-name"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "fugue_domain_v1" {
  secret      = google_secret_manager_secret.fugue_domain.id
  secret_data = var.domain_name

  lifecycle {
    create_before_destroy = true
  }
}

resource "google_secret_manager_secret_iam_member" "fugue_domain_accessor" {
  secret_id = google_secret_manager_secret.fugue_domain.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.orchestrator_gsa_email}"
}
