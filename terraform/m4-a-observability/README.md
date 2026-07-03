# M4-A Phase 3: Cloud Logging → BigQuery sink

biblio-claw の構造化ログを BigQuery `llm_observability` dataset に sink する Terraform。

## 前提

- GCP project: `hajimari-ai-hackathon-2026`
- DEN account に `roles/logging.configWriter` + `roles/bigquery.admin` 付与済 (memory `gcp_iam_secret_manager_pattern` 参照)
- GKE cluster `biblio-prod` (region `asia-northeast1`) で biblio-claw が稼働中
- keyless: `gcloud auth application-default login` 済 (ADC)、service account key を使わない
- **terraform CLI (v1.5+ 推奨)** — install 手順は `docs/operations-runbook.md` §M4-A Phase 3 §前提 を参照 (AlmaLinux/RHEL/Ubuntu/Debian/macOS 対応)

## Apply

```bash
cd terraform/m4-a-observability
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

作成リソース:
- `google_bigquery_dataset.logs` (`llm_observability`、location `asia-northeast1`、90 日 expiration)
- `google_logging_project_sink.biblio` (`biblio-claw-to-bq`、filter = `k8s_container` + namespace `biblio-claw`)
- `google_bigquery_dataset_iam_member.sink_writer` (writer identity → `roles/bigquery.dataEditor`)
- `google_project_service.{bigquery,logging}` (API 有効化、destroy 時無効化しない)

## Verify (手動 1 回確認)

1. biblio-claw で任意の biblio action を 1 回実行 (= Slack で `@bot 蔵書` 等)
2. ~5 分待ち、`bq ls hajimari-ai-hackathon-2026:llm_observability` でテーブル materialize 確認
3. 実テーブル名は GKE container の logName 由来で **`stdout` / `stderr` の 2 テーブル** (2026-06-28 実測)
4. `sql/summary.sql` は `<PROJECT_ID>` / `<DATASET_ID>` placeholder 形式 (= Phase 4 verify-m4-a.sh と共有) のため `sed` 置換で実行:
   ```bash
   sed -e "s/<PROJECT_ID>/hajimari-ai-hackathon-2026/g" \
       -e "s/<DATASET_ID>/llm_observability/g" \
       sql/summary.sql | \
     bq query --project_id=hajimari-ai-hackathon-2026 --use_legacy_sql=false --format=json
   ```
   `hit_count >= 1` かつ `marker = 'M4A_OK'` が返れば OK
5. `request_id` 1 つを取り出し、`SELECT * WHERE jsonPayload.request_id='<UUID>'` で全境界ログが取得できることを確認

> **注 (TZ bug 回避)**: `WHERE DATE(timestamp) = CURRENT_DATE('Asia/Tokyo')` は UTC date と JST date を比較するため時差で 0 件になる。必ず `DATE(timestamp, 'Asia/Tokyo')` を使う (`summary.sql` は対応済)。

> **注 (log には載らない field)**: `latency_ms` / `tokens_in` / `tokens_out` は span attribute としてのみ記録される (Cloud Trace 側)。BQ サマリは event / outcome / component / action の境界集計に絞る設計。

## Clustering 後追い (初回 emit 後に 1 回)

sink 経由作成テーブルは Terraform 管理外。clustering は `bq update` で後追い適用:

```bash
bq update \
  --clustering_fields=severity \
  hajimari-ai-hackathon-2026:llm_observability.stdout
```

- **BQ 仕様: clustering は top-level column のみ**。`jsonPayload.event` 等の nested field は `Fields specified for clustering can only be top-level fields` で reject されるため使えない。`severity` 単独で WHERE 句頻出ケースをカバー
- 新規行のみ clustering 対象 (既存行は再クラスタなし)。biblio-claw の運用量 (~100 req/day) では DML UPDATE 再クラスタは不要
- `bq show --format=json hajimari-ai-hackathon-2026:llm_observability.stdout | jq .clustering` で `{"fields": ["severity"]}` が返れば反映済
- **罠**: `CREATE OR REPLACE TABLE ... CLUSTER BY` は全ログ消滅。使わない

## Teardown

- 本番 sink target のため `delete_contents_on_destroy = false`。`terraform destroy` 単独では dataset 削除失敗
- 手動 teardown 手順:
  ```bash
  cd terraform/m4-a-observability
  terraform plan -destroy                                                  # dry-run
  bq rm -r -f -d hajimari-ai-hackathon-2026:llm_observability             # dataset + 全テーブル削除
  terraform destroy -auto-approve                                          # sink + IAM 削除
  ```
- `google_project_service` は `disable_on_destroy=false` で API 残置 (他リソース影響回避)

