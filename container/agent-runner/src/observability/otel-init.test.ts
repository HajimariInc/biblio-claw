// issue #104 root cause fix (2026-07-03) — HeadersFactory 経路の behavior contract を固定する。
// host 側 (`src/observability/__tests__/otel.test.ts`) と対称の contract test。
// refresh integration (fake timer + advance 45min) は host 側で end-to-end カバー済 +
// auth.ts が host/agent 対称のため、agent 側は factory contract のみに絞る (bun:test の
// fake timer API 差異を避けるための判断)。
import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';

const exporterInstances: Array<{ headersConfig: unknown }> = [];
let cachedTokenValue: string | null = null;
const logWarnCalls: Array<[string, Record<string, unknown> | undefined]> = [];

mock.module('../log.js', () => ({
  log: {
    debug: () => {},
    info: () => {},
    warn: (msg: string, ctx?: Record<string, unknown>) => {
      logWarnCalls.push([msg, ctx]);
    },
    error: () => {},
    fatal: () => {},
  },
}));

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
    logWarnCalls.length = 0;
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

// issue #104 review Wave 1 対応 — cachedToken null 時の警告経路 (host 側 test と対称)。
// shutdown 順序 regression は host 側 (`src/observability/__tests__/otel.test.ts`) で
// NodeSDK.onShutdown hook 経由で検証済 = 実装が host / agent 対称のため drift 検知に十分。
describe('OTel headers factory null cachedToken warn (agent, issue #104 review)', () => {
  beforeEach(async () => {
    const { shutdownOtel } = await import('./otel-init.js');
    await shutdownOtel();
    exporterInstances.length = 0;
    cachedTokenValue = null;
    logWarnCalls.length = 0;
  });

  afterEach(async () => {
    const { shutdownOtel } = await import('./otel-init.js');
    await shutdownOtel();
  });

  it('warns exactly once when cachedToken is null across multiple factory calls', async () => {
    const { startOtel } = await import('./otel-init.js');
    await startOtel();

    const last = exporterInstances[exporterInstances.length - 1];
    const factory = last.headersConfig as () => Promise<Record<string, string>>;

    cachedTokenValue = null;
    await factory();
    await factory();
    await factory();

    const nullWarnCalls = logWarnCalls.filter(
      ([msg]) => msg === 'OTel headers factory: cachedToken is null, sending empty Bearer',
    );
    expect(nullWarnCalls).toHaveLength(1);
    expect(nullWarnCalls[0][1]).toMatchObject({
      event: 'otel.headers.cached_token_null',
      outcome: 'degraded',
    });
  });

  it('does not warn when cachedToken is non-null', async () => {
    const { startOtel } = await import('./otel-init.js');
    await startOtel();

    const last = exporterInstances[exporterInstances.length - 1];
    const factory = last.headersConfig as () => Promise<Record<string, string>>;

    cachedTokenValue = 'tok-valid';
    await factory();
    await factory();

    const nullWarnCalls = logWarnCalls.filter(
      ([msg]) => msg === 'OTel headers factory: cachedToken is null, sending empty Bearer',
    );
    expect(nullWarnCalls).toHaveLength(0);
  });
});
