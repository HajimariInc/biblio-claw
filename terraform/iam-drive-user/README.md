# terraform/iam-drive-user

M4-F Phase 3 (life-capabilities) の Drive access 経路 (R4 = SA 2 段 impersonation) を成立させる最小構成 Terraform module。

## 何を宣言するか

| リソース | 用途 |
|---------|------|
| `google_service_account_iam_member.orchestrator_impersonates_drive_user` | `biblio-orchestrator@` に、`biblio-google-drive-user@` に対する `roles/iam.serviceAccountTokenCreator` を付与。orchestrator が drive-user を impersonate して `generateAccessToken` で drive.readonly scope 付き token を発行できるようにする |

## R4 経路の全体像

```
orchestrator Pod (WI 経由で biblio-orchestrator@ を assume)
      │
      │ (1) metadata server から caller token (cloud-platform scope)
      ▼
  iamcredentials.googleapis.com/v1/.../generateAccessToken
      │  (Bearer caller_token)
      │  (target = biblio-google-drive-user@, scope = drive.readonly)
      │  ← 本 module の IAM binding が「caller は target を impersonate できる」を保証
      ▼
  drive.readonly scope 付き access token (~1h TTL)
      │
      ▼
  OneCLI に PATCH で投入 → agent-container の MCP 経由 Drive request に MITM 注入
      │
      ▼
  Drive フォルダの ACL (biblio-google-drive-user@ が閲覧者) で access 成立
```

## 設計判断

- **target SA を分離** — orchestrator SA (Vertex / GH / Cloud SQL IAM / OneCLI 等多方面の権限) に Drive access を相乗りさせず、Drive 専用の `biblio-google-drive-user@` を Drive フォルダ ACL に共有。orchestrator は「その SA を impersonate する権限」だけを持つ (権限最小化 + 境界明快)
- **GSA 本体は Terraform 管理外** — `biblio-google-drive-user@` GSA は DEN さんが GCP Console で作成済 (手動 lifecycle)。本 module では GSA 作成せず、既存 GSA に対する binding のみ宣言する
- **Drive フォルダ ACL は Terraform 管理外** — Drive フォルダの ACL は Google Drive リソース側の設定で GCP IAM の管轄外。DEN さんが Drive UI で `biblio-google-drive-user@...` を「閲覧者」共有すること
- **keyless 維持** — GSA key JSON なし、WI + `iamcredentials` API のみで完結 (biblio-claw 全体の設計原則を守る)

## 前提条件

- `iamcredentials.googleapis.com` API が project で enabled (本 module では担わない)
- `biblio-google-drive-user@hajimari-ai-hackathon-2026.iam.gserviceaccount.com` GSA が存在
- Drive フォルダの ACL に上記 SA email が閲覧者として追加済 (Drive UI 側の手作業)

## Apply / Verify

```bash
cd terraform/iam-drive-user
terraform init
terraform apply

# verify: binding が付いていることを確認
gcloud iam service-accounts get-iam-policy \
  biblio-google-drive-user@hajimari-ai-hackathon-2026.iam.gserviceaccount.com \
  --project=hajimari-ai-hackathon-2026 --format=yaml
```

期待出力:

```yaml
bindings:
- members:
  - serviceAccount:biblio-orchestrator@hajimari-ai-hackathon-2026.iam.gserviceaccount.com
  role: roles/iam.serviceAccountTokenCreator
```

## 動作確認 (rotator 経路)

```bash
# rotator container 内で新 script を叩く (R4 経路の token 発行 + OneCLI PATCH まで完走)
kubectl exec biblio-orchestrator-0 -c drive-token-rotator -n biblio-claw -- \
  bash /scripts/onecli-drive-secret.sh

# agent Pod から Drive 到達性 確認 (200 が返れば境界分離が成立している証跡)
POD=$(kubectl get pod -n biblio-claw -l job-name -o jsonpath='{.items[0].metadata.name}')
kubectl exec "$POD" -n biblio-claw -- node -e "
fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
  headers: { Authorization: 'Bearer placeholder' }
}).then(r => r.text().then(t => console.log(r.status, t)))
"
# 期待: HTTP=200 + user.emailAddress = biblio-google-drive-user@...
```

## Teardown

```bash
cd terraform/iam-drive-user
terraform destroy
```

⚠️ destroy 後は orchestrator が drive-user を impersonate できなくなり、次の rotation 発火で `generateAccessToken` が 403 で fail する。Drive access を停止したい場合は本 module の destroy が最も明確な経路 (IAM binding 削除で経路遮断)。
