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

const OTLP_ENDPOINT = 'https://telemetry.googleapis.com/v1/traces';

let provider: BasicTracerProvider | null = null;
let exporterRef: OTLPTraceExporter | null = null;
let headerRefreshTimer: ReturnType<typeof setInterval> | null = null;

export async function startOtel(): Promise<BasicTracerProvider> {
  if (provider) return provider;

  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.ANTHROPIC_VERTEX_PROJECT_ID;
  if (!projectId) {
    throw new Error('GOOGLE_CLOUD_PROJECT or ANTHROPIC_VERTEX_PROJECT_ID required for OTel');
  }

  const initialToken = await initTokenRefresh();
  const exporter = new OTLPTraceExporter({
    url: OTLP_ENDPOINT,
    headers: {
      Authorization: `Bearer ${initialToken}`,
      'x-goog-user-project': projectId,
    },
    timeoutMillis: 30_000,
  });
  exporterRef = exporter;

  headerRefreshTimer = setInterval(() => {
    const token = getCachedToken();
    const exp = exporterRef as unknown as { _headers?: Record<string, string> };
    if (token && exp?._headers) exp._headers.Authorization = `Bearer ${token}`;
  }, 60 * 1000);
  if ((headerRefreshTimer as unknown as { unref?: () => void })?.unref) {
    (headerRefreshTimer as unknown as { unref: () => void }).unref();
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'biblio-claw-agent',
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
  if (headerRefreshTimer) {
    clearInterval(headerRefreshTimer);
    headerRefreshTimer = null;
  }
  stopTokenRefresh();
  if (!provider) return;
  await provider.shutdown();
  provider = null;
  exporterRef = null;
}

export function getTracer(name = 'biblio-claw-agent'): Tracer {
  return trace.getTracer(name);
}

// side-effect: top-level await で SDK 起動。failure 時は continue without telemetry
// (= polling loop を生かす、絶対停止より degraded)。
await startOtel().catch((err) => {
  console.warn('[otel] init failed, continuing without telemetry', err);
});
