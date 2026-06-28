/**
 * M4-A Phase 4 verify 用 test fixture。
 *
 * `withBiblioActionSpan('acquire', requestId, sessionId, fn)` を直接呼んで実 biblio action
 * と同じ span 構造で 1 リクエストを発射する。本番 acquire ロジック (= GitHub clone) は
 * 起こさない (= verify を decoupling、外部依存をパイプ疎通のみに絞る)。
 *
 * 使い方:
 *   pnpm exec tsx --import ./src/instrumentation.ts scripts/emit-test-span.ts
 *
 * 出力 (stdout、verify-m4-a.sh が `sed -n 's/^TRACE_ID=//p'` 等で抽出):
 *   TRACE_ID=<32 hex>
 *   REQUEST_ID=<uuid v4>
 *   SESSION_ID=verify-m4a-<unix>-<pid>
 *
 * shutdownOtel() で BatchSpanProcessor を flush しないと Cloud Trace に届かないため必須。
 */
import crypto from 'node:crypto';

import { withBiblioActionSpan } from '../src/biblio/action-helpers.js';
import { shutdownOtel } from '../src/observability/index.js';

async function main(): Promise<void> {
  const requestId = crypto.randomUUID();
  const sessionId = `verify-m4a-${Date.now()}-${process.pid}`;

  let traceId = '';
  await withBiblioActionSpan('acquire', requestId, sessionId, async (span) => {
    traceId = span.spanContext().traceId;
    span.setAttribute('biblio.test_fixture', true);
    span.addEvent('verify-m4-a.fixture.emitted');
    // 50ms で span duration が「点」にならないようにする (Cloud Trace UI 可読性)。
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  // OTel init failure 時 (= GOOGLE_CLOUD_PROJECT 等 未設定で instrumentation.ts が
  // degraded fallback に倒れた場合) は noop tracer が trace_id = '00..00' (32 zero) を
  // 返す。verify 側の `[0-9a-f]{32}` 正規表現は通ってしまうため、ここで fail させて
  // 「OTel が実際に起動していない」を early detect する。
  if (!traceId || /^0+$/.test(traceId)) {
    console.error(
      `[fail] emit-test-span: trace_id = '${traceId}' (OTel が初期化されていない可能性、` +
        `GOOGLE_CLOUD_PROJECT / ANTHROPIC_VERTEX_PROJECT_ID を確認)`,
    );
    process.exit(1);
  }

  console.log(`TRACE_ID=${traceId}`);
  console.log(`REQUEST_ID=${requestId}`);
  console.log(`SESSION_ID=${sessionId}`);

  await shutdownOtel();
}

main().catch((err) => {
  console.error('[fail] emit-test-span:', err);
  process.exit(1);
});
