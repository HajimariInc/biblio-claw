# issue #136 E: Vertex 認証 heartbeat 失敗が 5min 内に 3 回以上発火したら Slack 通知に
# 飛ばす Cloud Monitoring alert。#137 の自動復旧が入るまでの運用側 fallback。
#
# 公式仕様 (google-dev-knowledge 裏取り、
# docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.alertPolicies +
# docs.cloud.google.com/logging/docs/alerting/log-based-alerts):
#   - `condition_matched_log` を使う log-based alert は 1 policy 1 condition のみ
#     (metric-based との併用不可)
#   - `notification_rate_limit` は log-based alert では必須 (metric-based は任意)
#   - `notification_prompts` は log-based alert では自動的に `[OPENED]` のみに制限
#     (log は discrete event で "CLOSED" 状態を持たない、Terraform 側で明示不要)
#   - `auto_close` は 7d (604800s) 推奨、これを超えると incident が自動 close
#   - `label_extractors` で任意 jsonPayload field を label 化して documentation に
#     `${log.extracted_label.<name>}` で注入可能 (alert 通知本文に channel /
#     request_id を含めて Slack 上で即時原因分類できる → 高価値)

resource "google_monitoring_notification_channel" "slack" {
  project      = var.project_id
  display_name = "biblio-claw Vertex Auth Alert (Slack)"
  type         = "slack"
  labels = {
    channel_name = var.slack_channel_name
  }
  sensitive_labels {
    auth_token = var.slack_webhook_token
  }
}

resource "google_monitoring_alert_policy" "vertex_auth_heartbeat_failed" {
  project      = var.project_id
  display_name = var.alert_display_name
  combiner     = "OR"

  conditions {
    display_name = "vertex heartbeat 401 forensic dump >= 3 in 5min"
    condition_matched_log {
      # heartbeat 由来の 401 forensic dump のみを対象にする。
      #
      # 実装上、heartbeat 経路と実 request 経路の両方が `buildVertexForensicPayload` を
      # 経由するため、log の `jsonPayload.event` は経路によらず常に
      # `vertex.401.forensic_dump` になる (`src/adk/vertex-forensic.ts`)。heartbeat 経路の
      # 呼出は `request_id: 'heartbeat'` を渡す (`src/sidecar/vertex-auth-heartbeat.ts`) ため、
      # この 2 条件の AND で heartbeat 発火分だけを拾える。実 patron request の 401 は #137
      # の自浄機能で扱うため本 alert の対象外 (別 policy を追加する場合は `request_id!="heartbeat"`
      # で分岐する)。
      filter = <<-EOT
        resource.type="k8s_container"
        AND resource.labels.namespace_name="${var.k8s_namespace}"
        AND jsonPayload.event="vertex.401.forensic_dump"
        AND jsonPayload.request_id="heartbeat"
      EOT
      # 公式サポート: EXTRACT(<field-path>) で任意 jsonPayload field を label 化。
      # documentation.content から `$${log.extracted_label.channel}` で参照。
      label_extractors = {
        "channel"     = "EXTRACT(jsonPayload.channel)"
        "http_status" = "EXTRACT(jsonPayload.http_status)"
      }
    }
  }

  alert_strategy {
    # log-based alert では notification_rate_limit は必須 (公式仕様)。
    # period = "300s" で「5min 内に何回発火しても Slack 通知は 1 回だけ」= alert 洪水回避。
    notification_rate_limit {
      period = var.notification_rate_limit_period
    }
    # 7 days 経過で incident 自動 close。明示 close 忘れによる incident 滞留を防ぐ。
    auto_close = var.auto_close_duration
    # 12h 経過しても incident が close されていなければ Slack に再通知 (30min-24h の範囲)。
    notification_channel_strategy {
      renotify_interval          = var.renotify_interval
      notification_channel_names = [google_monitoring_notification_channel.slack.name]
    }
  }

  # alert 通知本文に extract した label を注入 (channel/request_id で原因分類が
  # Slack 上で即時可能)。
  documentation {
    content = <<-EOT
      Vertex 認証 heartbeat が 5min 内に 3 回失敗しました。

      - channel: `$${log.extracted_label.channel}` (adk = 経路 1 keyless ADC / onecli = 経路 2 MITM)
      - http_status: `$${log.extracted_label.http_status}` (401 = 認証、429 は本 alert では除外済 = false positive 回避)

      観察手順: `docs/operations-runbook.md` §M4-B Vertex 401 発生時の観察手順。
      BQ correlation query 実行 → 4 分類判定 → #137 で自浄機能に引き継ぎ。
    EOT
    mime_type = "text/markdown"
  }

  notification_channels = [google_monitoring_notification_channel.slack.name]
}
