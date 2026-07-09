-- Phase 1 雛形: エラー傾向 (severity=ERROR/CRITICAL の event 別 time-series)
--
-- Phase 2 で完成予定: stderr table の event 別 + hourly/daily time-bucket 集計。
-- gate.blocked / vertex.call failed / *.error 等の傾向を Slack DM で patron 目視できる形。
-- Phase 1 は empty result を返す minimal SELECT で Slack 通知経路を通す。
--
-- Placeholders: <PROJECT_ID>, <DATASET_ID>, @window_days (Phase 2 完成版で使用)
SELECT 0 AS placeholder LIMIT 0;
