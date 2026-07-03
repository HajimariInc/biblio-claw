// Bun 1.3.x は NodeSDK 非互換 → BasicTracerProvider + BatchSpanProcessor + OTLP HTTP exporter 直接
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  AlwaysOnSampler,
} from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { context, propagation, trace, type Tracer } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { initTokenRefresh, getCachedToken, stopTokenRefresh } from './auth.js';
import { log } from '../log.js';

const OTLP_ENDPOINT = 'https://telemetry.googleapis.com/v1/traces';

let provider: BasicTracerProvider | null = null;
// factory 内で cachedToken null を検知した際、1 回だけ warn を出すための flag。
// abnormal 状態を無音で流さないための最終防衛線 (host / agent 対称)。
let cachedTokenNullWarned = false;

export async function startOtel(): Promise<BasicTracerProvider> {
  if (provider) return provider;

  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.ANTHROPIC_VERTEX_PROJECT_ID;
  if (!projectId) {
    throw new Error('GOOGLE_CLOUD_PROJECT or ANTHROPIC_VERTEX_PROJECT_ID required for OTel');
  }

  // initTokenRefresh は auth.ts の 45min refresh loop を起動し、初回 token を返す。
  // 空文字 (invalid ADC 等) は fail-fast で init 失敗を上位に伝える。
  const initialToken = await initTokenRefresh();
  if (!initialToken) {
    throw new Error('OTel init token empty');
  }

  const exporter = new OTLPTraceExporter({
    url: OTLP_ENDPOINT,
    // host 側 src/observability/otel.ts と同じ HeadersFactory 経路。
    // SDK 内部の HttpExporterTransport.send が毎リクエスト await headers() で評価する。
    // static object に戻すと _headers hack が silent no-op に退化し 1h 経過後に全 span drop する
    // (issue #104 の root cause)。host / agent 対称のためロジックは一致させる (auth.ts §「対のファイル」)。
    headers: async () => {
      const token = getCachedToken();
      if (!token && !cachedTokenNullWarned) {
        log.warn('OTel headers factory: cachedToken is null, sending empty Bearer', {
          event: 'otel.headers.cached_token_null',
          outcome: 'degraded',
        });
        cachedTokenNullWarned = true;
      }
      return {
        Authorization: `Bearer ${token ?? ''}`,
        'x-goog-user-project': projectId,
      };
    },
    timeoutMillis: 30_000,
  });

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'biblio-claw-agent',
    // Cloud Trace OTLP 経路は Resource に gcp.project_id が必須
    // (= 詳細根拠は host 側 src/observability/otel.ts の同コメント参照)。
    'gcp.project_id': projectId,
  });
  provider = new BasicTracerProvider({
    resource,
    sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        maxQueueSize: 256,
        maxExportBatchSize: 64,
        scheduledDelayMillis: 2000,
        exportTimeoutMillis: 10000,
      }),
    ],
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  return provider;
}

export async function shutdownOtel(): Promise<void> {
  // 順序が重要 — stopTokenRefresh() を先に呼ぶと cachedToken = null に落ち、
  // BatchSpanProcessor._flushAll() の最終 flush 中に headers factory が空 Bearer を返して
  // 401 → 直近 span (max maxQueueSize=256 件) が silent drop する。provider.shutdown() で
  // pending span を flush してから token を破棄する。issue #104 review Wave 1 で発見。
  if (!provider) {
    stopTokenRefresh();
    cachedTokenNullWarned = false;
    return;
  }
  await provider.shutdown();
  provider = null;
  stopTokenRefresh();
  cachedTokenNullWarned = false;
}

export function getTracer(name = 'biblio-claw-agent'): Tracer {
  return trace.getTracer(name);
}

// side-effect: top-level await で SDK 起動。failure 時は continue without telemetry
// (= polling loop を生かす、絶対停止より degraded)。
await startOtel().catch((err: unknown) => {
  log.warn('OTel init failed, continuing without telemetry', { error: String(err) });
});
