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
let exporterRef: OTLPTraceExporter | null = null;
let headerRefreshTimer: ReturnType<typeof setInterval> | null = null;

// SDK 内部の private field `_headers` を直接書き換える hack。
// 詳細は host 側 src/observability/otel.ts startHeaderRefresh の WHY コメント参照
// (= dynamic header 公式 API 不在 / SDK upgrade 後の silent fail 検知用)。
let headerRefreshWarned = false;

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
    if (!token || !exporterRef) return;
    const exp = exporterRef as unknown as { _headers?: Record<string, string> };
    if (exp._headers) {
      exp._headers.Authorization = `Bearer ${token}`;
    } else if (!headerRefreshWarned) {
      log.warn('OTel header refresh skipped: _headers not accessible on exporter', {
        event: 'otel.header_refresh.skipped',
        outcome: 'degraded',
      });
      headerRefreshWarned = true;
    }
  }, 60 * 1000);
  // Bun の setInterval 戻り値は NodeJS.Timeout 型を持たないため .unref() を型安全に
  // 呼べない。unref() は daemon 化防止 (= プロセス終了を妨げない) のためだけなので、
  // 存在しない場合は no-op で問題ない。
  (headerRefreshTimer as unknown as { unref?: () => void }).unref?.();

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
  headerRefreshWarned = false;
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
await startOtel().catch((err: unknown) => {
  log.warn('OTel init failed, continuing without telemetry', { error: String(err) });
});
