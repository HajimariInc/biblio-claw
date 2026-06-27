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
