// issue #104 root cause fix (2026-07-03) — HeadersFactory 経路の behavior contract を固定する。
// host 側 (`src/observability/__tests__/otel.test.ts`) と対称の contract test。
// refresh integration (fake timer + advance 45min) は host 側で end-to-end カバー済 +
// auth.ts が host/agent 対称のため、agent 側は factory contract のみに絞る (bun:test の
// fake timer API 差異を避けるための判断)。
import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';

const exporterInstances: Array<{ headersConfig: unknown }> = [];
let cachedTokenValue: string | null = null;

mock.module('google-auth-library', () => ({
  GoogleAuth: class {
    async getClient() {
      return { getAccessToken: async () => ({ token: 'tok-init' }) };
    }
  },
}));

mock.module('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {
    headersConfig: unknown;
    constructor(opts?: { headers?: unknown }) {
      this.headersConfig = opts?.headers;
      exporterInstances.push(this);
    }
    export(_spans: unknown[], cb: (r: { code: number }) => void) {
      cb({ code: 0 });
    }
    async shutdown() {}
    async forceFlush() {}
  },
}));

// auth.js を partial mock — getCachedToken を test 側から制御可能にする。
mock.module('./auth.js', () => ({
  fetchAccessToken: async () => 'tok-init',
  initTokenRefresh: async () => {
    cachedTokenValue = 'tok-init';
    return 'tok-init';
  },
  getCachedToken: () => cachedTokenValue,
  stopTokenRefresh: () => {
    cachedTokenValue = null;
  },
}));

process.env.GOOGLE_CLOUD_PROJECT = 'test-proj';

describe('OTel exporter headers factory (agent, issue #104 fix)', () => {
  beforeEach(async () => {
    // top-level await で otel-init.ts 側の startOtel() が既に発火済のため、
    // shutdown してから test で explicit startOtel() を呼び直す。
    const { shutdownOtel } = await import('./otel-init.js');
    await shutdownOtel();
    exporterInstances.length = 0;
    cachedTokenValue = null;
  });

  afterEach(async () => {
    const { shutdownOtel } = await import('./otel-init.js');
    await shutdownOtel();
  });

  it('passes a function (HeadersFactory) to OTLPTraceExporter.headers, not a static object', async () => {
    const { startOtel } = await import('./otel-init.js');
    await startOtel();

    expect(exporterInstances.length).toBeGreaterThanOrEqual(1);
    const last = exporterInstances[exporterInstances.length - 1];
    expect(typeof last.headersConfig).toBe('function');
  });

  it('factory returns fresh token from getCachedToken on each call (not the init-time token)', async () => {
    const { startOtel } = await import('./otel-init.js');
    await startOtel();

    const last = exporterInstances[exporterInstances.length - 1];
    const factory = last.headersConfig as () => Promise<Record<string, string>>;

    cachedTokenValue = 'tok-A';
    const first = await factory();
    expect(first).toEqual({
      Authorization: 'Bearer tok-A',
      'x-goog-user-project': 'test-proj',
    });

    cachedTokenValue = 'tok-B';
    const second = await factory();
    expect(second.Authorization).toBe('Bearer tok-B');
    expect(second['x-goog-user-project']).toBe('test-proj');
  });

  it('factory falls back to empty Bearer when cachedToken is null (no throw)', async () => {
    const { startOtel } = await import('./otel-init.js');
    await startOtel();

    const last = exporterInstances[exporterInstances.length - 1];
    const factory = last.headersConfig as () => Promise<Record<string, string>>;

    cachedTokenValue = null;
    await expect(factory()).resolves.toEqual({
      Authorization: 'Bearer ',
      'x-goog-user-project': 'test-proj',
    });
  });
});
