# terraform/tavily-secret

Tavily Web 検索 API key を Google Secret Manager に置くための最小構成 Terraform module (M4-F Phase 3、life-capabilities)。

## 中身

| リソース | 用途 |
|---------|------|
| `google_secret_manager_secret.tavily_api_key` (`secret_id = "biblio-tavily-api-key"`) | Tavily API key の container、auto replication |
| `google_secret_manager_secret_version.tavily_api_key_v1` | 実 key の初期 version、`create_before_destroy = true` で rotation 時の `latest` alias 継続性を保証 |
| `google_secret_manager_secret_iam_member.tavily_api_key_accessor` | 既存 `biblio-orchestrator` GSA に本 secret のみへの `roles/secretmanager.secretAccessor` を付与 (1 workload = 1 GSA 原則、Fugue module 踏襲) |

## 設計判断

- **新 GSA を切らない** — `biblio-orchestrator` GSA に集約 (Fugue channel module 同様)
- **Terraform 化する意義** — Tavily は static key で rotate 不要だが、Kubernetes envFrom / initContainer などの追加インフラを避けて **script (`scripts/onecli-tavily-secret.sh`) が gcloud CLI 経由で直接読む** シンプル経路を採用。この経路は「Secret Manager の存在 + IAM binding」だけが前提条件になるため、Terraform module 1 個で完結する。
- **k8s Secret 化しない** — Fugue の `fugue-shared-token` は Pod 起動時に envFrom で必要 = k8s Secret 化必須だが、Tavily は deploy 時に 1 回叩く script が読むだけ = k8s Secret 経由の必要なし。
- **rotation** — Tavily Dashboard で key regenerate 時のみ `terraform apply -var="tavily_api_key=tvly-..."` で新 version 追加。`onecli-tavily-secret.sh` を再実行すれば OneCLI 側も更新される。

## Apply / Verify

```bash
# apply (実 key は env 経由で渡す、TF state には sensitive で残るが .terraform.lock.hcl 経由の外部漏洩は防げる)
cd terraform/tavily-secret
TF_VAR_tavily_api_key='tvly-...' terraform init
TF_VAR_tavily_api_key='tvly-...' terraform apply

# verify: gcloud で読み戻せることを確認
gcloud secrets versions access latest --secret=biblio-tavily-api-key --project=<your-gcp-project>
```

## Teardown

```bash
cd terraform/tavily-secret
TF_VAR_tavily_api_key='dummy' terraform destroy
```

⚠️ destroy 前に OneCLI に投入済の secret が生き続ける (Cloud SQL Postgres 永続化) ため、Tavily 経路の即時停止は `container_configs.mcp_servers.tavily` を DB から抜く方が確実。
