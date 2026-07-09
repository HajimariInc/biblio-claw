-- biblio-claw 週次レポート: 検品分布 (biblio.inspect の verdict × reason × dangerous 3 軸集計)
--
-- Source event: src/biblio/inspect-action.ts:77-96 の
--   log.info('inspect_biblio done', {event, outcome, verdict, reason, dangerous, ...})
--
--   実際の verdict × reason 対応表 (inspect.ts の全 fail() 経路実測):
--     - ACCEPT + reason=NULL (安全と判定された)
--     - HOLD + reason=inspect_error (Vertex/Gemini 呼出失敗、応答崩れ、quarantine 不可 = システム障害)
--     - HOLD + reason=license_denied / license_unknown (ルーティンなポリシー保留)
--     - REJECT + reason=schema_invalid (plugin metadata 不備)
--     - REJECT + reason=dangerous_code (LLM で危険コード検出 = dangerous=true 唯一)
--   注意: REJECT + inspect_error はコード上発生しない (`inspect_error` は常に `HOLD` に倒れる、
--         M4-C Phase 2 review R6 で修正、旧誤コメントは削除済み)。
--
--   dangerous は boolean = `verdict === 'REJECT' && reason === 'dangerous_code'` で判定。
--     - REJECT + dangerous_code → dangerous=true
--     - それ以外 → dangerous=false (schema_invalid / inspect_error / license_* / ACCEPT / HOLD)
--
--   `jsonPayload.dangerous` は BOOL 型で BQ export される (Cloud Logging boolean 保持)。
--   `CAST(... AS STRING)` で `'true'`/`'false'` に正規化して集計軸として扱う。
--   `jsonPayload.reason` は STRING (or NULL for ACCEPT)。NULL は 'ACCEPT' として集計軸に載せる。
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
-- defensive access (2026-07-10 M4-C Phase 2 verify で判明): `jsonPayload.dangerous` は
-- Phase 2 emit 追加 (`inspect-action.ts`) 直後 = BQ export schema に field 未反映な期間が
-- 存在 = `Field name dangerous does not exist in STRUCT<...>` runtime error で query 全滅。
-- `JSON_VALUE(TO_JSON_STRING(jsonPayload), '$.<field>')` 経由なら field 不在時に NULL を
-- 返し query 続行可能 (schema evolve までの過渡期でも集計成立、field 存在後は同値)。
-- verdict / reason は Phase 1 以前から emit されているため defensive 不要 = 既存経路のまま。
WITH raw AS (
  SELECT
    jsonPayload.verdict                                                                AS verdict,
    COALESCE(jsonPayload.reason, 'none')                                               AS reason,
    JSON_VALUE(TO_JSON_STRING(jsonPayload), '$.dangerous')                             AS dangerous
  FROM `<PROJECT_ID>.<DATASET_ID>.stdout`
  WHERE
    DATE(timestamp, 'Asia/Tokyo') >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL @window_days DAY)
    AND jsonPayload.event = 'biblio.inspect'
)
SELECT verdict, reason, dangerous, COUNT(*) AS cnt
FROM raw
WHERE verdict IN ('ACCEPT', 'HOLD', 'REJECT')
GROUP BY verdict, reason, dangerous
ORDER BY verdict, reason, dangerous;
