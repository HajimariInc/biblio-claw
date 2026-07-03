# terraform/fugue-channel

M4-E Phase 5 で新設。Fugue channel を **GKE Ingress + Cloud Endpoints DNS (`.cloud.goog`
sub-domain) + Google-managed cert + Secret Manager (token + domain)** で受け皿にする。
既存 `biblio-orchestrator` GSA に対して secret scope で `roles/secretmanager.secretAccessor`
を付与する = 新 GSA を切らない (1 workload = 1 GSA 原則、`docs/operations-runbook.md`
§M4-E Phase 5 参照)。

## 設計判断

- **Public DNS zone 不要**: Cloud Endpoints Service で `.cloud.goog` sub-domain の A record を
  自動払い出し (`x-google-endpoints` extension による DNS provisioning のみを拝借する
  公式パターン)。ESPv2 proxy 等の API management 機能は使わない。
- **ホスト名の Source of Truth = Secret Manager `fugue-domain-name`**:
  `.env` / k8s manifest 等の静的ファイルにホスト名を hardcode しない (公開ポリシー準拠、
  大会 public 化予定)。K8s Ingress manifest は envsubst で `${DOMAIN}` を展開してから apply、
  verify / Fugue チーム連携も `gcloud secrets versions access --secret=fugue-domain-name`
  経由で動的取得。
- **secret-scoped IAM binding**: `google_secret_manager_secret_iam_member` (secret scope) で
  fugue-shared-token + fugue-domain-name 単体の accessor role のみ付与 = 最小権限。

## 前提

- **terraform CLI (v1.5+ 推奨)** — install 手順は `docs/operations-runbook.md` §M4-A Phase 3 §前提 を参照 (AlmaLinux/RHEL/Ubuntu/Debian/macOS 対応、issue #70 で 2 module 共通の集約点として整備)
- GCP 側前提 (Cloud Endpoints API 有効化 / static IP / Secret Manager 権限) は `docs/operations-runbook.md` §M4-E Phase 5 参照

## Apply

```bash
cd terraform/fugue-channel

# Step 0: Cloud Endpoints API 有効化 (初回のみ、既に enable 済なら no-op)
gcloud services enable endpoints.googleapis.com \
  --project=hajimari-ai-hackathon-2026

# Step 1: Domain 名 + Bearer token を投入 (セッション先頭で 1 回、以降 export で継承)
export TF_VAR_domain_name='biblio-claw-fugue.endpoints.hajimari-ai-hackathon-2026.cloud.goog'
export TF_VAR_fugue_shared_token=$(openssl rand -hex 32)

# Step 2: Terraform apply (9 resource create: IP + Endpoints Service + cert + secret x2 +
# secret_version x2 + IAM binding x2)
terraform init
terraform plan
terraform apply
terraform output   # static_ip_address / cert_name / endpoints_service_name / secret 2 個の名前
```

## Verify

```bash
# Domain を Secret Manager から動的取得 (セッション env、`.env` に書かない)
export DOMAIN=$(gcloud secrets versions access latest --secret=fugue-domain-name \
  --project=hajimari-ai-hackathon-2026)
echo "domain: $DOMAIN"

# 1. Cloud Endpoints Service 状態確認
gcloud endpoints services describe "$DOMAIN" \
  --project=hajimari-ai-hackathon-2026 \
  --format='value(state)'
# 期待: ACTIVE

# 2. DNS 反映確認 (.cloud.goog は Google 内部 DNS = 通常 5-10 分)
while ! dig +short "$DOMAIN" | grep -q .; do
  echo "waiting for DNS ($DOMAIN)..." && sleep 30
done
dig +short "$DOMAIN"
# 期待: static IP アドレス (terraform output static_ip_address と一致)

# 3. Managed cert Active 化待ち (最大 60 分、通常 15-30 分)
# ⚠️ **重要な順序前提**: cert Active 化には **Ingress apply (Load Balancer authorization) が
# 前提条件**。K8s Ingress (k8s/25-ingress-fugue-channel.yaml) apply を先に済ませてから本
# ステップを実行すること。Terraform apply 直後に本ステップを走らせると cert が
# `PROVISIONING` + `FAILED_NOT_VISIBLE` で無限 stuck する (Phase 5 実 deploy で判明、
# `docs/operations-runbook.md` §M4-E Phase 5 罠 13 参照)。
while true; do
  status=$(gcloud compute ssl-certificates describe biblio-fugue-channel-cert \
    --global --format='value(managed.status)')
  echo "cert status: $status"
  [[ "$status" == "ACTIVE" ]] && break
  sleep 60
done

# 4. Secret Manager から token 取得可能か
gcloud secrets versions access latest --secret=fugue-shared-token \
  --project=hajimari-ai-hackathon-2026 | head -c 8
# 期待: 8 hex chars (プレフィックス確認のみ = 全文は表示しない)
```

## Teardown

**削除順序が重要**: LB attach 中の cert / static IP + Cloud Endpoints Service に依存する
DNS record は Terraform destroy がハングする可能性がある。先に K8s 側の Ingress + Secret を
削除してから Terraform を叩く。

```bash
# Step 1: K8s Ingress + Secret を先に削除
kubectl delete -f ../../k8s/25-ingress-fugue-channel.yaml
kubectl delete secret biblio-fugue-shared-token -n biblio-claw

# Step 2: Terraform destroy (cert が Ingress から detach 済 + Endpoints Service が LB attach
# 参照なし = destroy 成立)
export TF_VAR_domain_name='biblio-claw-fugue.endpoints.hajimari-ai-hackathon-2026.cloud.goog'
export TF_VAR_fugue_shared_token='dummy-for-destroy'  # sensitive var は destroy 時も必要
terraform destroy
```

## 既知の罠

1. **`create_before_destroy` を外すと rotation 時に短時間 secret 不在**:
   `google_secret_manager_secret_version` の `lifecycle` block を外すと、rotation apply 時に
   旧 version が先に destroy されて短時間 secret 不在 = `latest` alias を読む他 caller が
   一瞬 secret 不在を観測する。本 module は明示的に `create_before_destroy = true` を指定して
   回避している (ただし K8s Secret 側の rotation は Terraform 管理外、手動 sync が必要)。

2. **Cloud Endpoints API 未有効化**:
   Step 0 の `gcloud services enable endpoints.googleapis.com` を skip すると Terraform apply
   が `google_endpoints_service` resource で `SERVICE_DISABLED` error になる。初回は必須。

3. **DNS 反映 → Ingress apply → Cert Active の順序 (Phase 5 実 deploy で判明)**:
   Managed cert の Active 化には **Ingress apply (Load Balancer authorization) が前提条件**
   になる。Terraform apply 直後に cert Active 化を待つと `PROVISIONING` + `FAILED_NOT_VISIBLE`
   で無限 stuck する。正しい順序は Terraform apply → DNS 反映 (`.cloud.goog` = 通常 5-10 分) →
   K8s Ingress apply (`k8s/25-ingress-fugue-channel.yaml`) → cert Active 待ち (Ingress apply
   後 15-30 分、最大 60 分)。詳細は `docs/operations-runbook.md` §M4-E Phase 5 罠 13 参照。

4. **Teardown 順序 (Ingress + K8s Secret → terraform destroy)**:
   `google_compute_managed_ssl_certificate` が Ingress に attach されたままだと destroy が
   failed になる。上記 Teardown 手順の順序が必須。

5. **`TF_VAR_domain_name` の指定漏れ**:
   variables.tf で `domain_name` に default 値を持たない = apply 時 env 未指定なら
   `Missing required argument` で fail-fast。silent に間違った domain で apply される事故を防ぐ
   ための意図的な設計。

## 関連

- Source Plan: `.claude/PRPs/plans/completed/phase-5-prod-deploy.plan.md` (Task 4)
- 参照した pattern: `terraform/m4-a-observability/` (M4-A 先例、versions.tf / providers.tf の書式)
- 適用先 K8s manifest: `k8s/25-ingress-fugue-channel.yaml` (envsubst で `${DOMAIN}` を展開して apply)
- runbook: `docs/operations-runbook.md` §M4-E Phase 5 (apply / verify / rollback 手順)
- Cloud Endpoints DNS 公式: docs.cloud.google.com/endpoints/docs/openapi/get-started-kubernetes-engine
