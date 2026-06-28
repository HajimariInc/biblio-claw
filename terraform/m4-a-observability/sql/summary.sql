-- biblio-claw M4-A Phase 4 verify-m4-a.sh 用 summary SQL
-- + Phase 3 操作用 GROUP BY 集計 (= 末尾コメントブロックに補助保持)
--
-- Usage (verify-m4-a.sh 経由):
--   sed -e "s/<PROJECT_ID>/$GCP_PROJECT_ID/g" -e "s/<DATASET_ID>/$BQ_DATASET_ID/g" \
--     terraform/m4-a-observability/sql/summary.sql | \
--     bq query --use_legacy_sql=false --format=json --quiet
--
-- 出力 (1 行):
--   hit_count          直近 1h で sink に流入した biblio-claw container ログ件数
--   latest_ts          同上の最新 timestamp
--   biblio_event_count うち jsonPayload.event が 'biblio.*' のもの (= biblio action 由来)
--   sample_component   流入の代表 component (host-orchestrator / agent-runner / 他)
--   marker             固定 'M4A_OK' (= SQL 自体の到達性 assert 用)
--
-- 設計上の注:
-- - テーブルは stdout_* / stderr_* のワイルドカード参照で日次 sharded を吸収。
--   _TABLE_SUFFIX = FORMAT_DATE('%Y%m%d', CURRENT_DATE('Asia/Tokyo')) で JST 基準
--   (auto memory m4-a-phase-3-bq-sink-lessons.md「DATE(timestamp) TZ bug」回避)。
-- - latency / token usage は span attribute としてのみ記録 (Cloud Trace 側)。
--   BQ サマリは event 単位の boundary 集計に絞る (Phase 3 lesson 「log と span の責務分離」)。

WITH unioned AS (
  SELECT timestamp, jsonPayload
  FROM `<PROJECT_ID>.<DATASET_ID>.stdout_*`
  WHERE _TABLE_SUFFIX = FORMAT_DATE('%Y%m%d', CURRENT_DATE('Asia/Tokyo'))
  UNION ALL
  SELECT timestamp, jsonPayload
  FROM `<PROJECT_ID>.<DATASET_ID>.stderr_*`
  WHERE _TABLE_SUFFIX = FORMAT_DATE('%Y%m%d', CURRENT_DATE('Asia/Tokyo'))
)
SELECT
  COUNT(*)                                                       AS hit_count,
  MAX(timestamp)                                                 AS latest_ts,
  COUNTIF(JSON_VALUE(jsonPayload, '$.event') LIKE 'biblio.%')    AS biblio_event_count,
  ANY_VALUE(JSON_VALUE(jsonPayload, '$.component'))              AS sample_component,
  'M4A_OK'                                                       AS marker
FROM unioned
WHERE TIMESTAMP_TRUNC(timestamp, HOUR) >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR);

-- ─── 操作用補助クエリ (= Phase 3 deliverable の event/outcome 別 GROUP BY) ───
-- 実行時は WITH 句を再利用するか、直接以下を貼る (placeholders を sed 置換):
--
-- SELECT
--   JSON_VALUE(jsonPayload, '$.event')     AS event,
--   JSON_VALUE(jsonPayload, '$.outcome')   AS outcome,
--   JSON_VALUE(jsonPayload, '$.component') AS component,
--   JSON_VALUE(jsonPayload, '$.action')    AS action,
--   COUNT(*)                               AS hit_count,
--   MAX(timestamp)                         AS latest_ts
-- FROM `<PROJECT_ID>.<DATASET_ID>.stdout_*`
-- WHERE _TABLE_SUFFIX = FORMAT_DATE('%Y%m%d', CURRENT_DATE('Asia/Tokyo'))
--   AND JSON_VALUE(jsonPayload, '$.event') IS NOT NULL
-- GROUP BY event, outcome, component, action
-- ORDER BY hit_count DESC;
--
-- 特定 request_id の全境界ログ (= 1 trace 串刺し):
-- ... WHERE JSON_VALUE(jsonPayload, '$.request_id') = '<UUID>' ORDER BY timestamp ASC
