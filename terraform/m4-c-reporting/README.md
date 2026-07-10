# terraform/m4-c-reporting

M4-C 週次 reporting CronJob が Prod GKE Autopilot 上で BQ を read するための IAM binding 宣言モジュール。

## 何を宣言するか

| リソース | 用途 |
|---------|------|
| `google_project_iam_member.orchestrator_bq_job_user` | `biblio-orchestrator@` に、project-scoped `roles/bigquery.jobUser` を付与。BQ query job の submit 権限 (repo 初の `google_project_iam_member` 使用例) |
| `google_bigquery_dataset_iam_member.orchestrator_dataset_reader` | 同 SA に、dataset-scoped `roles/bigquery.dataViewer` on `llm_observability` を付与。table read 権限 (project-wide は付与しない、対象 dataset に絞る) |

## 権限最小化の判断

- `bigquery.jobUser` を **project-scoped** で付与するのは、BQ job submit 権限が project scope より下 (dataset scope) に存在しないため。CronJob は BQ job を submit する必要があるので必須。
- 実 table read 権限は **dataset-scoped** で絞る。project 全 dataset を舐められる `bigquery.dataViewer` project-wide は付与しない。
- どちらも既存 SA を再利用する形 (1 workload = 1 GSA 原則、他 module と同流儀)。M4-C 専用 SA を作らない = 認証境界の管理コストを増やさない。

## 前提条件

- `biblio-orchestrator@<your-gcp-project>.iam.gserviceaccount.com` GSA が存在 (`init-project-gcp` フロー or Console で作成済)
- `llm_observability` dataset が存在 (`terraform/m4-a-observability` module 側で apply 済)
- `bigquery.googleapis.com` API が project で enabled (M4-A module が有効化済み)

## Apply / Verify

```bash
cd terraform/m4-c-reporting
# 必須 var (project_id + orchestrator_gsa_email の 2 つは default 削除済、明示指定必須)
export TF_VAR_project_id='<your-gcp-project>'
export TF_VAR_orchestrator_gsa_email="biblio-orchestrator@${TF_VAR_project_id}.iam.gserviceaccount.com"
terraform init
terraform validate
terraform plan
terraform apply
```

期待する `terraform plan` 出力:

```
Plan: 2 to add, 0 to change, 0 to destroy.
```

`add` 内訳:
- `google_project_iam_member.orchestrator_bq_job_user`
- `google_bigquery_dataset_iam_member.orchestrator_dataset_reader`

`data.google_bigquery_dataset.logs` は Read 参照のみ (Create/Update しない)。

### verify (binding が実際に付いたか確認)

```bash
# project-scoped bigquery.jobUser を確認
gcloud projects get-iam-policy '<your-gcp-project>' \
  --flatten='bindings[].members' \
  --filter="bindings.members:'serviceAccount:biblio-orchestrator@<your-gcp-project>.iam.gserviceaccount.com' AND bindings.role:'roles/bigquery.jobUser'" \
  --format='value(bindings.role)'
# 期待: roles/bigquery.jobUser

# dataset-scoped bigquery.dataViewer を確認
bq show --format=prettyjson '<your-gcp-project>:llm_observability' | jq '.access[] | select(.userByEmail=="biblio-orchestrator@<your-gcp-project>.iam.gserviceaccount.com")'
# 期待: { "role": "READER", "userByEmail": "biblio-orchestrator@..." }
```

## Teardown

```bash
cd terraform/m4-c-reporting
terraform destroy
```

⚠️ destroy 後は CronJob Pod が BQ query 呼出で 403 を返し始める (実装は `src/reporting/cronjob-lib.ts:safeRunQuery` 経由で `reporting.<kind>_failed` event を per-kind emit、`<kind>` は `biblio-usage` / `llm-cost` / `inspect-distribution` / `error-trend` の 4 種)。reporting を停止したい場合は、CronJob 側を先に停止 (`kubectl delete cronjob reporting-cronjob -n biblio-claw`) してから本 module を destroy する。

## state 管理

- local backend (`.gitignore` の `*.tfstate` 継承)。
- CI 経路の apply は現状想定なし = メンテナ手動 apply。
