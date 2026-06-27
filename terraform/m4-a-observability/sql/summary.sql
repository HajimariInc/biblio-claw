-- biblio-claw M4-A Phase 3: 構造化ログサマリ
-- Usage: bq query --project_id=hajimari-ai-hackathon-2026 --use_legacy_sql=false < summary.sql
-- 出力: event / outcome / component 別の hit_count + 最新時刻 (本日 Asia/Tokyo 分のみ)
--
-- 注: latency / token usage は span attribute としてのみ記録 (= Cloud Trace 側)。
--     log には載らないため、BQ サマリは event 単位の boundary 集計に絞る。
--     latency / token を含む集計は Cloud Trace REST API or GenAI semconv 経由で取得する。
--
-- 注: テーブル名は GKE container stdout/stderr の logName 由来。
--     `bq ls hajimari-ai-hackathon-2026:llm_observability` で実テーブル名を確認可能。

SELECT
  jsonPayload.event       AS event,
  jsonPayload.outcome     AS outcome,
  jsonPayload.component   AS component,
  jsonPayload.action      AS action,
  COUNT(*)                AS hit_count,
  MAX(timestamp)          AS latest_ts
FROM `hajimari-ai-hackathon-2026.llm_observability.stdout`
WHERE DATE(timestamp, 'Asia/Tokyo') = CURRENT_DATE('Asia/Tokyo')
  AND jsonPayload.event IS NOT NULL
GROUP BY event, outcome, component, action
ORDER BY hit_count DESC;

-- 特定 request_id の全境界ログ (= 1 trace 串刺し):
-- SELECT
--   timestamp,
--   jsonPayload.component,
--   jsonPayload.event,
--   jsonPayload.outcome,
--   jsonPayload.action,
--   jsonPayload.message
-- FROM `hajimari-ai-hackathon-2026.llm_observability.stdout`
-- WHERE jsonPayload.request_id = '<UUID>'
--   AND DATE(timestamp, 'Asia/Tokyo') = CURRENT_DATE('Asia/Tokyo')
-- ORDER BY timestamp ASC;

-- stderr 側 (= warn / error) を一緒に見たい場合は UNION ALL で
-- `hajimari-ai-hackathon-2026.llm_observability.stderr` を追加する。
