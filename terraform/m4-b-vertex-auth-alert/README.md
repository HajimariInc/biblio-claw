# m4-b-vertex-auth-alert

issue #136 E: Vertex 認証 heartbeat 失敗の Slack 通知 (Cloud Monitoring alert)。

## 概要

`src/sidecar/vertex-auth-heartbeat.ts` が 5min 周期で probe に失敗したときに emit する
`vertex.401.forensic_dump` (`request_id: 'heartbeat'` が付く) を Cloud Logging → log-based
alert で監視する Terraform module。5min 内に 3 回以上発火したら Slack 通知に飛ばす。

**注**: heartbeat 経路と実 request 経路の両方が同じ event 名 `vertex.401.forensic_dump` を
emit するため、alert filter では `request_id="heartbeat"` で heartbeat 発火分だけを絞り込む
(実 patron request の 401 は #137 の自浄機能で扱う)。

epic 3 段:
- **#136 (本 module)**: observability の実装 (原因層 4 分類が特定可能な状態まで) + Slack alert
- **#137**: 自浄機能の実装 (Layer 1-4)
- **M4-G**: patron 向け「時間がかかっている理由」表示

## 前提

- `terraform/m4-a-observability` で BigQuery sink が構築済 = 本 module 実装後の
  `vertex.401.forensic_dump` event は自動で BQ に流れる (本 module は Cloud Logging
  を直接 filter するため sink 依存なし、後追いの correlation SQL は sink 経由)
- **Slack notification channel を Cloud Console UI で事前作成済** (本 module は resource name
  を variable で受けて alert policy のみ作成する経路、下記参照)

### Slack notification channel の事前作成 (Cloud Console UI 経由)

Google Cloud Monitoring 公式 app の Slack Bot User OAuth Token (`xoxb-*`) は Google 側管理の
ため、Terraform で `google_monitoring_notification_channel` resource を直接作れない。
以下の手順で Cloud Console UI で事前作成する:

1. Slack workspace に "Google Cloud Monitoring" app を install (Slack App Directory)
2. 通知先 channel で bot invite (`/invite @Google Cloud Monitoring`)
3. Cloud Console → Monitoring → Notification channels → Add new → Slack →
   Authorize workspace → channel name 入力 → Test Connection → Save
4. 発行される resource name を控える: `projects/<PROJECT_ID>/notificationChannels/<numeric-id>`

resource name は以下 command で確認可能:
```bash
curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://monitoring.googleapis.com/v3/projects/${TF_VAR_project_id}/notificationChannels" \
  | jq -r '.notificationChannels[] | select(.type == "slack") | .name'
```

## apply

```bash
export TF_VAR_project_id=<gcp-project-id>
export TF_VAR_notification_channel_name='projects/<gcp-project-id>/notificationChannels/<numeric-id>'

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

`terraform destroy` は alert policy のみ削除する。Slack notification channel (Cloud Console
UI 経由で作成した既存 resource) は Terraform state 外なので **削除されない**。channel も
不要になったら Cloud Console UI から手動削除するか、以下の REST 経由:

```bash
curl -X DELETE -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://monitoring.googleapis.com/v3/${TF_VAR_notification_channel_name}"
```

## 動作確認

```bash
# apply 後、policy が Cloud Monitoring 側に反映されたことを確認
# (gcloud alpha が無い環境でも REST 経由で確認可能)
curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://monitoring.googleapis.com/v3/projects/${TF_VAR_project_id}/alertPolicies" \
  | jq -r '.alertPolicies[] | select(.displayName | test("Vertex Auth")) | "\(.displayName) [\(.name)]"'

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
