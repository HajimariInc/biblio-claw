-- Vertex 401 発生 request と直近 rotator rotation の相関を JOIN (issue #136 D、経路別 4 分類自動判定)
--
-- 使い方 (runbook §M4-B の観察手順 1):
--   sed -e "s/<PROJECT_ID>/${GCP_PROJECT_ID}/g" -e "s/<DATASET_ID>/${BQ_DATASET_ID}/g" \
--     src/reporting/sql/vertex-401-correlation.sql | bq query --nouse_legacy_sql
--
-- 4 分類 (経路別、CASE で自動判定):
--   A: SDK/google-auth-library cache 問題 (経路 1)
--      = ADK 経路で sdk_token_hash ≠ rotator_token_hash (rotator 新 token を SDK が反映せず)
--   A2: SDK Authorization capture 失敗 (経路 1)
--      = ADK 経路で sdk_token_hash が空 (pre-flight capture 経路で auth_capture_error 発生)
--   B: Rotator sidecar 死亡 (経路 2)
--      = OneCLI 経路で最終 rotator emit から 45min+ 経過している (rotation 間隔 40min の 1.125 倍)
--   C: OneCLI secret 消失 (経路 2)
--      = OneCLI 経路で snapshot found=false (secret が意図せず削除された経路)
--   D: Google 側障害
--      = rotator 直後 5min 以内で 401 (rotator は成功しているが Google 側が拒否)
--   E: 未分類 (手動調査)
--
-- 出力は Cloud Trace UI (`chat <model>` span or `biblio.<action>` span) との相関を保つため
-- `trace` 列 (Cloud Logging → BQ sink で自動昇格される top-level `projects/<PROJECT_ID>/traces/<32-hex>`)
-- を含めない (=jsonPayload.logging.googleapis.com/trace の 32-hex を利用する場合は別途 JOIN)。
-- 本 SQL は request_id / error_at / channel / category を返す一次判定用。

WITH vertex_401 AS (
  SELECT
    timestamp AS error_at,
    jsonPayload.channel AS channel,
    jsonPayload.request_id AS request_id,
    jsonPayload.auth_token_hash AS sdk_token_hash,
    CAST(jsonPayload.age_since_iat_sec AS INT64) AS age_since_iat_sec,
    jsonPayload.onecli_snapshot_id AS onecli_secret_id,
    CAST(jsonPayload.onecli_snapshot_updated_at_epoch AS INT64) AS onecli_updated_at_epoch,
    jsonPayload.onecli_snapshot_found AS onecli_snapshot_found,
    CAST(jsonPayload.pod_age_sec AS INT64) AS pod_age_sec
  FROM `<PROJECT_ID>.<DATASET_ID>.stderr`
  WHERE jsonPayload.event = 'vertex.401.forensic_dump'
    AND DATE(timestamp, 'Asia/Tokyo') = CURRENT_DATE('Asia/Tokyo')
),
recent_rotations AS (
  SELECT
    timestamp AS rotation_at,
    jsonPayload.token_hash AS rotator_token_hash,
    CAST(jsonPayload.token_exp AS INT64) AS rotator_token_exp,
    CAST(jsonPayload.token_iat AS INT64) AS rotator_token_iat
  FROM `<PROJECT_ID>.<DATASET_ID>.stderr`
  WHERE jsonPayload.event = 'vertex.rotator.token_injected'
    AND DATE(timestamp, 'Asia/Tokyo') = CURRENT_DATE('Asia/Tokyo')
)
SELECT
  v.error_at,
  v.channel,
  v.request_id,
  v.pod_age_sec,
  v.age_since_iat_sec,
  v.sdk_token_hash,
  r.rotator_token_hash,
  r.rotation_at,
  TIMESTAMP_DIFF(v.error_at, r.rotation_at, SECOND) AS sec_since_rotation,
  CASE
    WHEN v.channel = 'adk' AND v.sdk_token_hash != ''
         AND r.rotator_token_hash IS NOT NULL AND r.rotator_token_hash != ''
         AND v.sdk_token_hash != r.rotator_token_hash
      THEN 'A: SDK/google-auth-library cache 問題 (rotator 新 token 反映せず)'
    WHEN v.channel = 'adk' AND (v.sdk_token_hash IS NULL OR v.sdk_token_hash = '')
      THEN 'A2: SDK Authorization capture 失敗 (probe route)'
    WHEN v.channel = 'onecli' AND r.rotator_token_hash IS NOT NULL
         AND TIMESTAMP_DIFF(v.error_at, r.rotation_at, SECOND) > 2700
      THEN 'B: Rotator sidecar 死亡 (>45min 経過)'
    WHEN v.channel = 'onecli' AND (v.onecli_secret_id IS NULL OR v.onecli_secret_id = '')
      THEN 'C: OneCLI secret 消失 (snapshot found=false)'
    WHEN r.rotator_token_hash IS NOT NULL
         AND TIMESTAMP_DIFF(v.error_at, r.rotation_at, SECOND) BETWEEN 0 AND 300
      THEN 'D: Google 側障害 (rotator 直後 5min 以内で 401)'
    ELSE 'E: 未分類 (要手動調査)'
  END AS category
FROM vertex_401 v
LEFT JOIN recent_rotations r
  ON r.rotation_at < v.error_at
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY v.request_id, v.error_at ORDER BY r.rotation_at DESC
) = 1
ORDER BY v.error_at DESC
LIMIT 100;
