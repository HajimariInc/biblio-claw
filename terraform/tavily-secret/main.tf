# ------------------- Secret Manager: biblio-tavily-api-key -------------------
# Tavily Web 検索の API key (life-capabilities)。
#
# `scripts/onecli-tavily-secret.sh` が deploy 時に本 secret から `latest` version を読み、
# OneCLI vault に `type=generic + hostPattern=api.tavily.com + Bearer {value}` として投入する。
# 以降 agent-container 内の Tavily MCP server が発する `api.tavily.com` への request に
# OneCLI MITM proxy が Bearer header を注入する経路。
#
# Fugue module (`terraform/fugue-channel/`) の Secret Manager pattern を踏襲:
#   - auto replication (region 非依存)
#   - create_before_destroy = true (rotation 時の `latest` alias 継続性)
#   - google_secret_manager_secret_iam_member で既存 orchestrator GSA に secret scope で付与
#     (1 workload = 1 GSA 原則、新 GSA は切らない)
resource "google_secret_manager_secret" "tavily_api_key" {
  secret_id = "biblio-tavily-api-key"
  replication {
    auto {}
  }
}

# create_before_destroy = true の意義 (Fugue module から継承):
# Secret Manager 側の `latest` alias の継続性を守る。Terraform apply で secret_data を更新
# するとき、新 version を先に作成 → `latest` alias が新 version を指した状態を維持しつつ
# 旧 version を destroy する順序を保証する。これにより Terraform apply 実行中に `latest` を
# 読む caller (`onecli-tavily-secret.sh` / 他 Terraform module / 手動 gcloud 等) が「一瞬
# secret が消えた」状態を観測しない。
resource "google_secret_manager_secret_version" "tavily_api_key_v1" {
  secret      = google_secret_manager_secret.tavily_api_key.id
  secret_data = var.tavily_api_key

  lifecycle {
    create_before_destroy = true
  }
}

# 既存 biblio-orchestrator GSA に本 secret のみへの accessor 権限を付与 (secret scope、
# project-level ではない)。orchestrator Pod 内の gcloud CLI (WI 経由 GSA impersonate) が
# `gcloud secrets versions access latest --secret=biblio-tavily-api-key` で読める。
resource "google_secret_manager_secret_iam_member" "tavily_api_key_accessor" {
  secret_id = google_secret_manager_secret.tavily_api_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.orchestrator_gsa_email}"
}
