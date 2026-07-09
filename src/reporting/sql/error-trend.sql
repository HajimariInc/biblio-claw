-- biblio-claw 週次レポート: エラー傾向 (severity=ERROR の日次分布 + latency 分位)
--
-- Source: Cloud Logging BQ export の stderr table + top-level severity column。
--   severity は BQ export の top-level column (`jsonPayload.severity` は不在、runbook §Cloud
--   Logging BQ 実装知見 参照)。severity='ERROR' の event 別 + 日次 bucket を集計。
--   latency_ms が emit されている log の分位を APPROX_QUANTILES で単一 pass 算出する。
--
-- APPROX_QUANTILES 使い方:
--   APPROX_QUANTILES(x, 100 IGNORE NULLS)[OFFSET(k)] → k-th percentile (0..100)
--   ORDER BY 全件ソート禁止 (BQ の shuffle 爆発を避ける)。
--   latency_ms が emit されない event (biblio.* 系) は NULL → IGNORE NULLS で分位計算から除外。
--
-- Placeholders:
--   <PROJECT_ID>   sed 置換
--   <DATASET_ID>   sed 置換
--   @window_days   BQ parameterized query (int64)
WITH errors AS (
  SELECT
    DATE(timestamp, 'Asia/Tokyo')                                 AS day,
    jsonPayload.event                                             AS event,
    SAFE_CAST(jsonPayload.latency_ms AS INT64)                    AS latency_ms
  FROM `<PROJECT_ID>.<DATASET_ID>.stderr`
  WHERE
    DATE(timestamp, 'Asia/Tokyo') >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL @window_days DAY)
    AND severity = 'ERROR'
)
SELECT
  day,
  event,
  COUNT(*)                                                        AS cnt,
  APPROX_QUANTILES(latency_ms, 100 IGNORE NULLS)[OFFSET(50)]      AS p50_ms,
  APPROX_QUANTILES(latency_ms, 100 IGNORE NULLS)[OFFSET(95)]      AS p95_ms,
  APPROX_QUANTILES(latency_ms, 100 IGNORE NULLS)[OFFSET(99)]      AS p99_ms
FROM errors
GROUP BY day, event
ORDER BY day DESC, cnt DESC;
