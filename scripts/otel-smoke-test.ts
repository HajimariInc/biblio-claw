/** OTel 疎通確認: dummy span を 1 つ生成 → shutdown で flush 待ち → trace ID stdout
 *  使い方: pnpm run otel-smoke-test (= tsx --import ./src/instrumentation.ts scripts/otel-smoke-test.ts)
 *  検証: 出力された trace ID を Cloud Trace UI / gcloud trace list で確認 */
import { getTracer, shutdownOtel } from '../src/observability/index.js';

async function main(): Promise<void> {
  const tracer = getTracer('otel-smoke-test');
  let traceId = '';
  await tracer.startActiveSpan('otel.smoke-test', async (span) => {
    span.setAttribute('biblio.phase', 'm4-a.phase-1.otel-foundation');
    span.setAttribute('biblio.env', process.env.DEPLOY_ENV ?? 'local');
    traceId = span.spanContext().traceId;
    span.end();
  });
  console.log(`RESULT={"trace_id":"${traceId}"}`);
  await shutdownOtel();
}

main().catch((err) => {
  console.error('[fail]', err);
  process.exit(1);
});
