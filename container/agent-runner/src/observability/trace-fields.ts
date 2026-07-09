// NOTE: host (src/observability/trace-fields.ts) と agent
// (container/agent-runner/src/observability/trace-fields.ts) で同一実装を維持するファイル。
// 片方を編集したら必ずもう一方にも同じ変更を適用すること (= Phase 1 auth.ts / env-propagation.ts と同流儀、
// scripts/verify-m4-a.sh §7 で `diff -q` による drift 検知あり、byte-for-byte 一致が前提)。

import { trace, type Span } from '@opentelemetry/api';

/** Cloud Logging が top-level 昇格する reserved field を返す (active span 不在時は空)。
 *  詳細: https://cloud.google.com/trace/docs/trace-log-integration
 *  Preferred Format: trace_id alone (32-hex)。projects/<project>/traces/<id> の
 *  full path は Legacy 互換。Preferred を採用、projectId 解決ロジック不要。
 *
 *  実機検証済 (2026-07-03, issue #81): GKE `biblio-claw` namespace で Cloud Logging
 *  Console "View trace" リンクが Cloud Trace UI に正常遷移することを目視確認。BQ sink
 *  の top-level `trace` 列も `projects/<PROJECT_ID>/traces/<32-hex>` 形式に自動昇格
 *  される (Fluent Bit / Cloud Logging 取り込み層が projectId を補完)。scripts/verify-m4-a.sh
 *  Section 5.5 で regression 検知。詳細は docs/operations-runbook.md §M4-A Phase 2
 *  log↔trace 連携。
 *
 *  `spanArg` 省略時は `trace.getActiveSpan()` を使う従来動作 (backward compat)。
 *  `spanArg` 明示時 (issue #136 Step 0-a) は active context ではなく渡された span から
 *  traceId/spanId を抽出する。用途: `AnthropicVertexLlm.generateContentAsync` のように
 *  `context.with(spanCtx, ...)` の callback 外側で log emit する経路で、trace 相関を
 *  失わないための脱出弁。 */
export function getTraceLogFields(spanArg?: Span): Record<string, unknown> {
  const span = spanArg ?? trace.getActiveSpan();
  if (!span) return {};
  const ctx = span.spanContext();
  if (!ctx.traceId || ctx.traceId === '00000000000000000000000000000000') return {};
  return {
    'logging.googleapis.com/trace': ctx.traceId,
    'logging.googleapis.com/spanId': ctx.spanId,
    'logging.googleapis.com/trace_sampled': (ctx.traceFlags & 1) === 1,
  };
}
