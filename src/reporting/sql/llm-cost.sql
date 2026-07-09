-- biblio-claw 週次レポート: LLM 呼出 (vertex.call) の tokens 集計 (直近 @window_days 日、JST 基準)
--
-- Source event: src/biblio/vertex-client.ts:499-507 + :670-677 の log.info('vertex.call', {...})
--   Fields: model / tokens_in / tokens_out / outcome / latency_ms / request_id / session_id / ...
--   outcome=success のみ集計 (failed 呼出はコスト計上しない)。
--
-- キャッシュ関連の欠落 (spec deviation):
-- - Anthropic semconv では gen_ai.usage.input_tokens は
--   `input + cache_read + cache_creation` の合算値だが、biblio-claw の現行 log emit は
--   Anthropic response の生 `input_tokens` のみ (cache_read/cache_creation は span attribute のみ)。
-- - cost-calculator.ts 側で cache_creation が undefined の場合 warnings を返し、
--   Slack DM 本文に「cache 書込分は未捕捉、過小推定」と注記する。
-- - 将来 Cloud Logging に cache_read/cache_creation を emit する PRD で
--   本 SQL に SUM(...) 列を追加する (現状は COALESCE(0) 相当が formatter 側で有効)。
--
-- Placeholders:
--   <PROJECT_ID>   sed 置換
--   <DATASET_ID>   sed 置換 (default "llm_observability")
--   @window_days   BQ parameterized query (int64)
SELECT
  jsonPayload.model                          AS model,
  COUNT(*)                                   AS call_count,
  SUM(CAST(jsonPayload.tokens_in  AS INT64)) AS total_tokens_in,
  SUM(CAST(jsonPayload.tokens_out AS INT64)) AS total_tokens_out
FROM `<PROJECT_ID>.<DATASET_ID>.stdout`
WHERE
  DATE(timestamp, 'Asia/Tokyo') >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL @window_days DAY)
  AND jsonPayload.event = 'vertex.call'
  AND jsonPayload.outcome = 'success'
GROUP BY model
ORDER BY call_count DESC;
