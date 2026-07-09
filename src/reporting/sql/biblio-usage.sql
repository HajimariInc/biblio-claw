-- biblio-claw 週次レポート: biblio.* action 集計 (直近 @window_days 日、JST 基準)
--
-- Source event: src/biblio/action-helpers.ts の withBiblioActionSpan (`biblio.<action>`)
--   action は BiblioActionName union = 10 値 (acquire/inspect/categorize/shelve/
--   shelve_multi/list/enkin/shokyaku/config/equip)
-- Fields: jsonPayload.action / jsonPayload.outcome / COUNT(*)
--
-- スキーマ実装知見 (詳細 terraform/m4-a-observability/sql/summary.sql:37-44 参照):
-- - jsonPayload は STRUCT 型、ドット記法で参照 (`jsonPayload.action`)。JSON_VALUE 不使用。
-- - DATE(timestamp, 'Asia/Tokyo') で JST 基準評価 (Asia/Tokyo 明示、UTC デフォルト差分回避)。
-- - biblio.* は severity=info → stdout table のみ (stderr 側は error/warn 系)。
--
-- Placeholders:
--   <PROJECT_ID>   sed 置換 (Node script 側の reporting-cronjob.ts で)
--   <DATASET_ID>   同 (default "llm_observability")
--   @window_days   BQ parameterized query 経由 (int64)
SELECT
  jsonPayload.action  AS action,
  jsonPayload.outcome AS outcome,
  COUNT(*)            AS cnt
FROM `<PROJECT_ID>.<DATASET_ID>.stdout`
WHERE
  DATE(timestamp, 'Asia/Tokyo') >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL @window_days DAY)
  AND STARTS_WITH(jsonPayload.event, 'biblio.')
  AND jsonPayload.action IN (
    'acquire','inspect','categorize','shelve','shelve_multi',
    'list','enkin','shokyaku','config','equip'
  )
GROUP BY action, outcome
ORDER BY action, outcome;
