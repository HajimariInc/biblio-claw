-- biblio-claw 週次レポート: LLM 呼出 (vertex.call) の tokens 集計 (直近 @window_days 日、JST 基準)
--
-- Source event: src/biblio/vertex-client.ts:499-513 + src/adk/AnthropicVertexLlm.ts:316-328 の
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
SELECT
  jsonPayload.model                              AS model,
  COUNT(*)                                       AS call_count,
  SUM(CAST(jsonPayload.tokens_in       AS INT64)) AS total_tokens_in,
  SUM(CAST(jsonPayload.tokens_out      AS INT64)) AS total_tokens_out,
  SUM(CAST(jsonPayload.cache_read      AS INT64)) AS total_cache_read,
  SUM(CAST(jsonPayload.cache_creation  AS INT64)) AS total_cache_creation
FROM `<PROJECT_ID>.<DATASET_ID>.stdout`
WHERE
  DATE(timestamp, 'Asia/Tokyo') >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL @window_days DAY)
  AND jsonPayload.event = 'vertex.call'
  AND jsonPayload.outcome = 'success'
GROUP BY model
ORDER BY call_count DESC;
