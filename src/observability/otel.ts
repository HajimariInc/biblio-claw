import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { BatchSpanProcessor, ParentBasedSampler, AlwaysOnSampler } from '@opentelemetry/sdk-trace-base';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { trace, diag, DiagConsoleLogger, DiagLogLevel, type Tracer } from '@opentelemetry/api';
import { initTokenRefresh, getCachedToken, stopTokenRefresh } from './auth.js';
import { log } from '../log.js';

const OTLP_ENDPOINT = 'https://telemetry.googleapis.com/v1/traces';

let sdkInstance: NodeSDK | null = null;
let exporterRef: OTLPTraceExporter | null = null;
let headerRefreshTimer: NodeJS.Timeout | null = null;

export async function startOtel(): Promise<NodeSDK> {
  if (sdkInstance) return sdkInstance;

  if (process.env.OTEL_DIAG === 'true') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  }

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
  startHeaderRefresh();

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'biblio-claw',
    [ATTR_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION ?? '0.0.0',
    // Cloud Trace OTLP 経路は Resource に gcp.project_id が必須
    // (= 不在時 400 "Resource is missing required attribute"、
    // x-goog-user-project header だけでは不足、smoke-test で実測)。
    'gcp.project_id': projectId,
  });

  sdkInstance = new NodeSDK({
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
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });
  sdkInstance.start();
  return sdkInstance;
}

// SDK 内部の private field `_headers` を直接書き換える hack。
// OTLPTraceExporter は dynamic header 更新の公式 API を持たない
// (= opentelemetry-js#4017)。SDK バージョンアップで `_headers` が rename/
// 削除された場合は silent fail (= Authorization が初回 token で固定 → 1h で 401
// retry-loop) になるため、検知用に warn ログを 1 回だけ出す + SDK upgrade 後は
// smoke-test (scripts/otel-smoke-test.ts) を回して疎通確認すること。
let headerRefreshWarned = false;

function startHeaderRefresh(): void {
  if (headerRefreshTimer) return;
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
  if (headerRefreshTimer.unref) headerRefreshTimer.unref();
}

export async function shutdownOtel(): Promise<void> {
  if (headerRefreshTimer) {
    clearInterval(headerRefreshTimer);
    headerRefreshTimer = null;
  }
  headerRefreshWarned = false;
  stopTokenRefresh();
  if (!sdkInstance) return;
  await sdkInstance.shutdown();
  sdkInstance = null;
  exporterRef = null;
}

export function getTracer(name = 'biblio-claw'): Tracer {
  return trace.getTracer(name);
}
