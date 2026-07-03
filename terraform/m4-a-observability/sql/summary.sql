-- biblio-claw M4-A Phase 4 verify-m4-a.sh 用 summary SQL
-- + Phase 3 操作用 GROUP BY 集計 (= 末尾コメントブロックに補助保持)
--
-- Usage (verify-m4-a.sh 経由):
--   sed -e "s/<PROJECT_ID>/${GCP_PROJECT_ID}/g" -e "s/<DATASET_ID>/${BQ_DATASET_ID}/g" \
--     terraform/m4-a-observability/sql/summary.sql | \
--     bq query --project_id="${GCP_PROJECT_ID}" --use_legacy_sql=false --format=json --quiet
--
-- 注: `--project_id` を必ず指定する (= gcloud config の default に意図せず向くのを防ぐ)。
--
-- 出力 (1 行):
--   hit_count          直近 1h で sink に流入した biblio-claw container ログ件数
--   latest_ts          同上の最新 timestamp
--   biblio_event_count うち jsonPayload.event が 'biblio.*' のもの (= biblio action 由来)
--   sample_component   流入の代表 component (host-orchestrator / agent-runner / 他)
--   marker             固定 'M4A_OK' (= SQL 自体の到達性 assert 用)
--
-- 設計上の注 (= Phase 4 verify 実機検証で判明したスキーマ仕様):
-- - テーブルは Cloud Logging sink の `use_partitioned_tables = true` 設定により
--   `stdout` / `stderr` の単独形 (= terraform/m4-a-observability/main.tf:39)。日次 sharded
--   ではない。`timestamp` 列で DAY partition。
-- - `jsonPayload` は **RECORD (STRUCT) 型** で展開される (= bq show --schema 実測)。
--   `JSON_VALUE(jsonPayload, '$.event')` は型エラーで失敗。**ドット記法 `jsonPayload.event`**
--   でアクセスする。STRUCT field 不在の場合は NULL で安全に返る (= IFNULL 不要)。
-- - 一方、Cloud Logging reserved field の `trace` / `spanId` / `traceSampled` は **トップレベル**
--   STRING / STRING / BOOL カラムに展開される (= `WHERE trace = 'projects/.../traces/...'`)。
--   個別 trace 検索は `jsonPayload` ではなく top-level `trace` カラムを使う。
--   `trace` 列は gcloud logging + BQ 両経路で実測 (2026-07-03, issue #81) して resource
--   name 形式 (= `projects/<PROJECT_ID>/traces/<32-hex>`) に自動昇格されることを確認済。
--   `trace-fields.ts` 側は Preferred Format (bare 32-hex) で送出し、Fluent Bit /
--   Cloud Logging 取り込み層が projectId 補完する設計 (詳細 docs/operations-runbook.md
--   §M4-A Phase 2 log↔trace 連携)。
-- - `DATE(timestamp, 'Asia/Tokyo')` で JST 基準 (auto memory m4-a-phase-3-bq-sink-lessons.md
--   「DATE(timestamp) TZ bug」回避、デフォルト UTC 評価で朝の時間帯に 0 件症状を防ぐ)。
-- - latency / token usage は span attribute としてのみ記録 (Cloud Trace 側)。
--   BQ サマリは event 単位の boundary 集計に絞る (Phase 3 lesson 「log と span の責務分離」)。

-- stdout / stderr テーブルの jsonPayload STRUCT は同型ではない (= stderr 側に
-- `err RECORD` 等の error 専用 field がある、bq query で UNION ALL 時に
-- "Column 2 in UNION ALL has incompatible types: STRUCT<...>, STRUCT<...>"
-- エラー発生)。UNION ALL は同型必須のため、jsonPayload 全体ではなく **集計に
-- 必要な primitive field だけ** を SELECT してから UNION ALL する。両 table とも
-- jsonPayload.event / jsonPayload.component は STRING 型で存在確認済
-- (= 2026-06-28 Phase 4 verify 実機検証)。
WITH unioned AS (
  SELECT
    timestamp,
    jsonPayload.event AS event,
    jsonPayload.component AS component
  FROM `<PROJECT_ID>.<DATASET_ID>.stdout`
  WHERE DATE(timestamp, 'Asia/Tokyo') = CURRENT_DATE('Asia/Tokyo')
  UNION ALL
  SELECT
    timestamp,
    jsonPayload.event AS event,
    jsonPayload.component AS component
  FROM `<PROJECT_ID>.<DATASET_ID>.stderr`
  WHERE DATE(timestamp, 'Asia/Tokyo') = CURRENT_DATE('Asia/Tokyo')
)
SELECT
  COUNT(*)                            AS hit_count,
  MAX(timestamp)                      AS latest_ts,
  COUNTIF(event LIKE 'biblio.%')      AS biblio_event_count,
  ANY_VALUE(component)                AS sample_component,
  'M4A_OK'                            AS marker
FROM unioned
WHERE TIMESTAMP_TRUNC(timestamp, HOUR) >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR);

-- ─── 操作用補助クエリ (= Phase 3 deliverable の event/outcome 別 GROUP BY) ───
-- 実行時は WITH 句を再利用するか、直接以下を貼る (placeholders を sed 置換):
--
-- SELECT
--   jsonPayload.event     AS event,
--   jsonPayload.outcome   AS outcome,
--   jsonPayload.component AS component,
--   jsonPayload.action    AS action,
--   COUNT(*)              AS hit_count,
--   MAX(timestamp)        AS latest_ts
-- FROM `<PROJECT_ID>.<DATASET_ID>.stdout`
-- WHERE DATE(timestamp, 'Asia/Tokyo') = CURRENT_DATE('Asia/Tokyo')
--   AND jsonPayload.event IS NOT NULL
-- GROUP BY event, outcome, component, action
-- ORDER BY hit_count DESC;
--
-- 特定 trace の全境界ログ (= 1 trace 串刺し、trace はトップレベルカラム):
-- ... WHERE trace = 'projects/<PROJECT_ID>/traces/<TRACE_ID>' ORDER BY timestamp ASC
