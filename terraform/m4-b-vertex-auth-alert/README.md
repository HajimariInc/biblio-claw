# m4-b-vertex-auth-alert

issue #136 E: Vertex 認証 heartbeat 失敗の Slack 通知 (Cloud Monitoring alert)。

## 概要

`src/sidecar/vertex-auth-heartbeat.ts` が 5min 周期で emit する
`vertex.auth.heartbeat_failed` event を Cloud Logging → log-based alert で監視する
Terraform module。5min 内に 3 回以上発火したら Slack 通知に飛ばす。

epic 3 段:
- **#136 (本 module)**: observability の実装 (原因層 4 分類が特定可能な状態まで) + Slack alert
- **#137**: 自浄機能の実装 (Layer 1-4)
- **M4-G**: patron 向け「時間がかかっている理由」表示

## 前提

- `terraform/m4-a-observability` で BigQuery sink が構築済 = `vertex.auth.heartbeat_failed`
  event は自動で BQ に流れる (本 module は Cloud Logging を直接 filter するため sink 依存なし
  だが、後追いの correlation query は sink 経由)
- Slack Workspace 側で **Cloud Monitoring OAuth app を install 済**
- Slack channel (`#biblio-alerts` 等) が存在

## apply

```bash
export TF_VAR_project_id=<gcp-project-id>
export TF_VAR_slack_channel_name='#biblio-alerts'
export TF_VAR_slack_webhook_token='xoxb-...'

cd terraform/m4-b-vertex-auth-alert
terraform init
terraform plan
terraform apply
```

## teardown

```bash
cd terraform/m4-b-vertex-auth-alert
terraform destroy
```

## 動作確認

```bash
# apply 後、policy が Cloud Monitoring 側に反映されたことを確認
gcloud alpha monitoring policies list \
  --project="${TF_VAR_project_id}" \
  --filter='displayName:"Vertex Auth Heartbeat Failed"' \
  --format='value(displayName,name)'

# heartbeat 失敗を人為発火 (verify Section 6.6 と同流儀):
#   1. rotator sidecar を停止して 1h+ 待つ (expired token を強制)
#   2. OR PATCH で無効 token を OneCLI に入れる
# → 5min 以内に 3 回失敗 → Slack channel に alert 通知が届く
```

## 罠

- **log-based alert の incident close**: log は discrete event で "CLOSED" 状態を持たない。
  Terraform で `notification_prompts` を明示指定しても API 側で無視される。運用は
  Cloud Monitoring incident dashboard で明示 close するか、`auto_close = "604800s"`
  (7d) で自然 close する
- **BQ sink schema drift**: `vertex.auth.heartbeat_failed` event は本 issue 実装 deploy
  後、24h+ 稼働で新 field が BQ 側 schema に反映される。deploy 直後の correlation SQL 実行
  は空返しになる可能性 (Cloud Logging → BQ sink 特有の schema drift)。 本 alert 自体は
  Cloud Logging を直接 filter するため schema drift の影響なし
- **`notification_rate_limit` 必須**: log-based alert は Terraform 側で本 field を省略すると
  apply 時に validation error になる (公式仕様)

## 関連

- `src/sidecar/vertex-auth-heartbeat.ts` (event の emit 元)
- `docs/operations-runbook.md` §M4-B Vertex 401 発生時の観察手順 (対応手順の集約)
- `terraform/m4-a-observability` (log の BQ sink)
