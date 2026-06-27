// NOTE: src/observability/trace-fields.ts (host) と対。実装は同一を維持すること。
// host 側で変更した場合は本ファイルにも同じ変更を適用する (= Phase 1 auth.ts / env-propagation.ts と同流儀)。

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
