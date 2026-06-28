// NOTE: host (src/observability/trace-fields.ts) と agent
// (container/agent-runner/src/observability/trace-fields.ts) で同一実装を維持するファイル。
// 片方を編集したら必ずもう一方にも同じ変更を適用すること (= Phase 1 auth.ts / env-propagation.ts と同流儀、
// scripts/verify-m4-a.sh §7 で `diff -q` による drift 検知あり、byte-for-byte 一致が前提)。

import { trace } from '@opentelemetry/api';

/** Cloud Logging が top-level 昇格する reserved field を返す (active span 不在時は空)。
 *  詳細: https://cloud.google.com/trace/docs/trace-log-integration
 *  Preferred Format: trace_id alone (32-hex)。projects/<project>/traces/<id> の
 *  full path は Legacy 互換。Preferred を採用、projectId 解決ロジック不要。 */
export function getTraceLogFields(): Record<string, unknown> {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const ctx = span.spanContext();
  if (!ctx.traceId || ctx.traceId === '00000000000000000000000000000000') return {};
  return {
    'logging.googleapis.com/trace': ctx.traceId,
    'logging.googleapis.com/spanId': ctx.spanId,
    'logging.googleapis.com/trace_sampled': (ctx.traceFlags & 1) === 1,
  };
}
