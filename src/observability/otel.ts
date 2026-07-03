import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { BatchSpanProcessor, ParentBasedSampler, AlwaysOnSampler } from '@opentelemetry/sdk-trace-base';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { trace, diag, DiagConsoleLogger, DiagLogLevel, type Tracer } from '@opentelemetry/api';
import { initTokenRefresh, getCachedToken, stopTokenRefresh } from './auth.js';

const OTLP_ENDPOINT = 'https://telemetry.googleapis.com/v1/traces';

let sdkInstance: NodeSDK | null = null;

export async function startOtel(): Promise<NodeSDK> {
  if (sdkInstance) return sdkInstance;

  if (process.env.OTEL_DIAG === 'true') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  }

  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.ANTHROPIC_VERTEX_PROJECT_ID;
  if (!projectId) {
    throw new Error('GOOGLE_CLOUD_PROJECT or ANTHROPIC_VERTEX_PROJECT_ID required for OTel');
  }

  // initTokenRefresh は auth.ts の 45min refresh loop を起動し、初回 token を返す。
  // 空文字が返る (invalid ADC 等) 場合は fail-fast で init 失敗を上位に伝える。
  const initialToken = await initTokenRefresh();
  if (!initialToken) {
    throw new Error('OTel init token empty');
  }

  const exporter = new OTLPTraceExporter({
    url: OTLP_ENDPOINT,
    // headers を HeadersFactory (= `() => Promise<Record<string, string>>`) で渡す。
    // SDK 内部の HttpExporterTransport.send が毎リクエスト await this._parameters.headers()
    // で評価するため、auth.ts の 45min refresh loop で更新される cachedToken が
    // 常に反映される。旧実装は static object を渡した上で SDK 内部の private field
    // `_headers` を setInterval で書き換える hack を持っていたが、
    // @opentelemetry/otlp-exporter-base@0.219.0 で `_headers` が消えたため silent no-op に退化し、
    // 起動時 Bearer で ~1h 稼働後に全 span が 401 で無音 drop していた (issue #104)。
    // static object に revert しないこと。
    headers: async () => ({
      Authorization: `Bearer ${getCachedToken() ?? ''}`,
      'x-goog-user-project': projectId,
    }),
    timeoutMillis: 30_000,
  });

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

export async function shutdownOtel(): Promise<void> {
  stopTokenRefresh();
  if (!sdkInstance) return;
  await sdkInstance.shutdown();
  sdkInstance = null;
}

export function getTracer(name = 'biblio-claw'): Tracer {
  return trace.getTracer(name);
}
