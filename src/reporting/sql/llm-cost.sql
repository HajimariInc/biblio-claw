-- biblio-claw 週次レポート: LLM 呼出 (vertex.call) の tokens 集計 (直近 @window_days 日、JST 基準)
--
-- Source event: src/biblio/vertex-client.ts:508-527 + src/adk/AnthropicVertexLlm.ts:334-346 の
--   log.info('vertex.call', {...})
--   Fields: model / tokens_in / tokens_out / cache_read / cache_creation / outcome / latency_ms /
--     request_id / session_id / ...
--   outcome=success のみ集計 (failed 呼出はコスト計上しない)。
--
-- キャッシュ列 (M4-C Phase 2 で emit 追加済):
-- - Anthropic 経路 (`callVertexAnthropic` + `AnthropicVertexLlm.generateContentAsync`) は
--   `cache_read` / `cache_creation` を `?? 0` で unconditional emit (旧 log = emit 前は NULL)。
-- - Gemini 経路には cache 概念がなく、`vertex.call` payload に cache 列は含まれない = NULL 扱い。
-- - `CAST(... AS INT64)` は NULL 入力に対して NULL を返し、SUM は NULL を無視するため、
--   cache 未 emit 期間の row は SUM から silent に除外される (集計に影響しない設計)。
-- - cost-calculator.ts 側で cache_creation の undefined check が消えるのは、SQL 側で
--   `SUM(...) AS total_cache_creation` が非 undefined 値 (0 含む) を返してから。
--
-- Placeholders:
--   <PROJECT_ID>   sed 置換
--   <DATASET_ID>   sed 置換 (default "llm_observability")
--   @window_days   BQ parameterized query (int64)
-- defensive access (2026-07-10 M4-C Phase 2 verify で判明): `jsonPayload.cache_read` /
-- `cache_creation` / `cache_captured` は Phase 2 emit 追加 (`AnthropicVertexLlm.ts` /
-- `vertex-client.ts`) 直後 = BQ export schema に field 未反映な期間 = `Field name cache_read
-- does not exist in STRUCT<...>` runtime error で query 全滅。`JSON_VALUE(TO_JSON_STRING(
-- jsonPayload), '$.<field>')` 経由なら field 不在時に NULL を返し query 続行可能 (SUM(NULL)
-- は 0 集計、schema evolve までの過渡期でも集計成立、field 存在後は同値)。
-- model / tokens_in / tokens_out は Phase 1 以前から emit されているため defensive 不要。
SELECT
  jsonPayload.model                                                                              AS model,
  COUNT(*)                                                                                       AS call_count,
  SUM(CAST(jsonPayload.tokens_in       AS INT64))                                                AS total_tokens_in,
  SUM(CAST(jsonPayload.tokens_out      AS INT64))                                                AS total_tokens_out,
  SUM(CAST(JSON_VALUE(TO_JSON_STRING(jsonPayload), '$.cache_read') AS INT64))                    AS total_cache_read,
  SUM(CAST(JSON_VALUE(TO_JSON_STRING(jsonPayload), '$.cache_creation') AS INT64))                AS total_cache_creation,
  -- review R6 (I2): usage 欠落 (SDK 差 or 移行週の旧ログ) call 数を独立集計。
  -- cache_captured=false の call 数を SUM = cost 過小推定の可能性を patron に可視化。
  -- 旧ログ (Phase 2 未 deploy) では cache_captured 自体が NULL = false 判定に落ちず 0 に集計される
  -- (=既存の warning 経路と分離、独立指標として動作)。JSON_VALUE 経由で field 不在時も NULL 返し。
  SUM(CASE WHEN JSON_VALUE(TO_JSON_STRING(jsonPayload), '$.cache_captured') = 'false' THEN 1 ELSE 0 END) AS uncaptured_cache_calls
FROM `<PROJECT_ID>.<DATASET_ID>.stdout`
WHERE
  DATE(timestamp, 'Asia/Tokyo') >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL @window_days DAY)
  AND jsonPayload.event = 'vertex.call'
  AND jsonPayload.outcome = 'success'
GROUP BY model
ORDER BY call_count DESC;
