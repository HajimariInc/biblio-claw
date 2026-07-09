-- biblio-claw 週次レポート: biblio.* action 集計 (直近 @window_days 日、JST 基準)
--
-- Source event: src/biblio/action-helpers.ts の withBiblioActionSpan は Cloud Trace 側の
--   span 属性 (`biblio.action`) には値を設定するが、Cloud Logging には出力しない。
--   実際の log emit は各 delivery action handler
--   (`src/biblio/{acquire,inspect,categorize,shelve,list-biblio,config,enkin,shokyaku,multi-shelve,equip}-action.ts`)
--   が `log.info` / `log.error` で行い、`event: 'biblio.<action>'` + `outcome: 'success'|'failure'|...`
--   を持つ。action verb 単独のフィールドは emit されない (Cloud Trace 側の設計原則
--   「log と span の責務分離」= terraform/m4-a-observability/sql/summary.sql:35-36 参照)。
--   したがって action verb は event 文字列から `REGEXP_EXTRACT` で抽出する。
--
-- スキーマ実装知見 (詳細 terraform/m4-a-observability/sql/summary.sql:37-44 参照):
-- - jsonPayload は STRUCT 型、ドット記法で参照 (`jsonPayload.event`)。JSON_VALUE 不使用。
-- - DATE(timestamp, 'Asia/Tokyo') で JST 基準評価 (Asia/Tokyo 明示、UTC デフォルト差分回避)。
-- - biblio.* は severity=info → stdout table のみ (stderr 側は error/warn 系)。
--
-- Placeholders:
--   <PROJECT_ID>   sed 置換 (Node script 側の reporting-cronjob.ts で)
--   <DATASET_ID>   同 (default "llm_observability")
--   @window_days   BQ parameterized query 経由 (int64)
WITH raw AS (
  SELECT
    REGEXP_EXTRACT(jsonPayload.event, r'^biblio\.(\w+)$') AS action,
    jsonPayload.outcome                                   AS outcome
  FROM `<PROJECT_ID>.<DATASET_ID>.stdout`
  WHERE
    DATE(timestamp, 'Asia/Tokyo') >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL @window_days DAY)
    AND STARTS_WITH(jsonPayload.event, 'biblio.')
)
SELECT
  action,
  outcome,
  COUNT(*) AS cnt
FROM raw
WHERE
  action IN (
    'acquire','inspect','categorize','shelve','shelve_multi',
    'list','enkin','shokyaku','config','equip'
  )
GROUP BY action, outcome
ORDER BY action, outcome;
