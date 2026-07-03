# terraform/fugue-channel

M4-E Phase 5 で新設。Fugue channel を GKE Ingress + 固定 DNS + Google-managed cert +
Secret Manager で受け皿にする。既存 `biblio-orchestrator` GSA に対して secret scope で
`roles/secretmanager.secretAccessor` を付与する = 新 GSA を切らない (1 workload = 1 GSA
原則、`docs/operations-runbook.md` §M4-E Phase 5 参照)。

## Apply

```bash
cd terraform/fugue-channel

# 1. Cloud DNS zone name を事前確認
gcloud dns managed-zones list --project=hajimari-ai-hackathon-2026

# 2. fugue-shared-token を openssl で生成 (64 hex = 256 bit エントロピー)
#    Fugue チームと共有する値。/tmp に一時保存し、Slack DM 等で受け渡し後に削除。
export TF_VAR_fugue_shared_token=$(openssl rand -hex 32)
export TF_VAR_dns_zone_name=<既存 zone 名 (Step 1 で確認)>
echo "$TF_VAR_fugue_shared_token" > /tmp/fugue-token-backup

# 3. Terraform apply
terraform init
terraform plan   # 6 resource + 1 data source が create 予定
terraform apply
terraform output # static_ip_address / cert_name / secret_name 等 5 output を確認
```

## Verify

```bash
# 1. Cloud DNS A record 反映確認 (dig で外部から解決可能か)
dig +short biblio-claw.fugue-channel.hajimari-ai-hackathon-2026.app
# 期待: static IP アドレスが返る (伝播に数分〜数時間)

# 2. Managed cert の Active 化待ち (最大 60 分)
gcloud compute ssl-certificates describe biblio-fugue-channel-cert \
  --global --format='value(managed.status)'
# 期待: ACTIVE (PROVISIONING の間は待つ)

# 3. Secret Manager から token 取得可能か
gcloud secrets versions access latest --secret=fugue-shared-token \
  --project=hajimari-ai-hackathon-2026 | head -c 8
# 期待: 8 hex chars (プレフィックス確認のみ = 全文は表示しない)
```

## Teardown

**削除順序が重要**: LB attach 中の cert / static IP は Terraform destroy がハングするため、
先に K8s 側の Ingress + Secret を削除してから Terraform を叩く。

```bash
# Step 1: K8s Ingress + Secret を先に削除
kubectl delete -f ../../k8s/25-ingress-fugue-channel.yaml
kubectl delete secret biblio-fugue-shared-token -n biblio-claw

# Step 2: Terraform destroy (cert が Ingress から detach 済 = destroy 成立)
terraform destroy
```

## 既知の罠

1. **`create_before_destroy` を外すと rotation 時に短時間 secret 不在**:
   `google_secret_manager_secret_version` の `lifecycle` block を外すと、rotation apply 時に
   旧 version が先に destroy されて短時間 secret 不在 = Pod が 401 を返す silent failure。
   本 module は明示的に `create_before_destroy = true` を指定して回避している。

2. **`data.google_dns_managed_zone.existing` が zone 未作成で fail**:
   事前に `gcloud dns managed-zones list` で zone 存在確認、不在なら
   `gcloud dns managed-zones create` で作成が必要 (別プロジェクト管理の可能性あり)。

3. **DNS 反映 → Cert Active の順序**:
   Managed cert の Active 化は **DNS record が propagate 済** の状態で始まるのが最短。
   本 module は DNS record を先に create するが、実際の DNS 伝播は Cloud DNS 側の
   非同期処理のため apply 直後は Cert が PROVISIONING で待つ経路が残る。

4. **Teardown 順序 (Ingress delete → terraform destroy)**:
   `google_compute_managed_ssl_certificate` が Ingress に attach されたままだと
   destroy が failed になる = 上記 Teardown 手順の順序が必須。

## 関連

- Source Plan: `.claude/PRPs/plans/completed/phase-5-prod-deploy.plan.md` (Task 4)
- 参照した pattern: `terraform/m4-a-observability/` (M4-A 先例、versions.tf / providers.tf の書式)
- 適用先 K8s manifest: `k8s/25-ingress-fugue-channel.yaml` (annotation で本 module 出力を参照)
- runbook: `docs/operations-runbook.md` §M4-E Phase 5 (apply / verify / rollback 手順)
