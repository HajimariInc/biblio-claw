-- Phase 1 雛形: 検品分布 (biblio.inspect の verdict + dangerous 軸)
--
-- Phase 2 で完成予定: biblio.inspect event の verdict (ACCEPT/HOLD/REJECT) + dangerous
-- (true/false) 別分布集計。Phase 1 は empty result を返す minimal SELECT で Slack 通知
-- 経路を通す (formatter.ts が「Phase 2 で実装」に置換)。
--
-- Placeholders: <PROJECT_ID>, <DATASET_ID>, @window_days (Phase 2 完成版で使用)
SELECT 0 AS placeholder LIMIT 0;
