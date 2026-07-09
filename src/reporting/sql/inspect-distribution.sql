-- biblio-claw 週次レポート: 検品分布 (biblio.inspect の verdict × dangerous 2 軸集計)
--
-- Source event: src/biblio/inspect-action.ts:77-90 の
--   log.info('inspect_biblio done', {event, outcome, verdict, dangerous, ...})
--
--   verdict は inspect result (ACCEPT / HOLD / REJECT の 3 値)。
--   dangerous は boolean = `verdict === 'REJECT' && reason === 'dangerous_code'` で判定。
--     - ACCEPT → dangerous=false (安全と判定された)
--     - HOLD → dangerous=false (判定保留、危険性は不明)
--     - REJECT + reason=dangerous_code → dangerous=true (危険コード検出)
--     - REJECT + reason=schema_invalid / inspect_error → dangerous=false (schema 不正 / システム失敗)
--
--   `jsonPayload.dangerous` は BOOL 型で BQ export される (Cloud Logging boolean 保持)。
--   `CAST(... AS STRING)` で `'true'`/`'false'` に正規化して集計軸として扱う。
--
-- スキーマ実装知見 (biblio-usage.sql と同型):
-- - jsonPayload は STRUCT 型、ドット記法で参照。
-- - DATE(timestamp, 'Asia/Tokyo') で JST 基準評価。
-- - biblio.inspect は severity=info → stdout table のみ。
-- - Plan Task 6 逸脱: `outcome = 'success'` フィルタは ACCEPT のみに絞る形になり分布集計の
--   意味を失うため、`verdict IN ('ACCEPT', 'HOLD', 'REJECT')` の WHERE を主 filter として全 outcome
--   (success/hold/failure) を集計する。verdict emit が無い intermediate log (`inspect_biblio from agent`
--   等) は verdict IS NULL で自動除外される。
--
-- Placeholders:
--   <PROJECT_ID>   sed 置換
--   <DATASET_ID>   sed 置換
--   @window_days   BQ parameterized query (int64)
WITH raw AS (
  SELECT
    jsonPayload.verdict                            AS verdict,
    CAST(jsonPayload.dangerous AS STRING)          AS dangerous
  FROM `<PROJECT_ID>.<DATASET_ID>.stdout`
  WHERE
    DATE(timestamp, 'Asia/Tokyo') >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL @window_days DAY)
    AND jsonPayload.event = 'biblio.inspect'
)
SELECT verdict, dangerous, COUNT(*) AS cnt
FROM raw
WHERE verdict IN ('ACCEPT', 'HOLD', 'REJECT')
GROUP BY verdict, dangerous
ORDER BY verdict, dangerous;
