import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const { getAccessTokenMock, getClientMock, logWarnMock } = vi.hoisted(() => {
  const getAccessTokenMock = vi.fn();
  const getClientMock = vi.fn(async () => ({ getAccessToken: getAccessTokenMock }));
  const logWarnMock = vi.fn();
  return { getAccessTokenMock, getClientMock, logWarnMock };
});

vi.mock('google-auth-library', () => {
  function GoogleAuth() {
    return { getClient: getClientMock };
  }
  return { GoogleAuth };
});

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: logWarnMock, error: vi.fn(), fatal: vi.fn() },
}));

import { fetchAccessToken, initTokenRefresh, getCachedToken, stopTokenRefresh } from '../auth.js';

describe('auth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getAccessTokenMock.mockReset();
    getClientMock.mockClear();
    logWarnMock.mockClear();
    stopTokenRefresh();
  });

  afterEach(() => {
    stopTokenRefresh();
    vi.useRealTimers();
  });

  it('fetchAccessToken returns the token from GoogleAuth', async () => {
    getAccessTokenMock.mockResolvedValue({ token: 'tok-1' });
    expect(await fetchAccessToken()).toBe('tok-1');
  });

  it('fetchAccessToken throws when GoogleAuth returns no token', async () => {
    getAccessTokenMock.mockResolvedValue({ token: null });
    await expect(fetchAccessToken()).rejects.toThrow(/no token/);
  });

  it('initTokenRefresh caches the initial token and refreshes every 45 minutes', async () => {
    getAccessTokenMock
      .mockResolvedValueOnce({ token: 'tok-initial' })
      .mockResolvedValueOnce({ token: 'tok-refresh-1' });

    const initial = await initTokenRefresh();
    expect(initial).toBe('tok-initial');
    expect(getCachedToken()).toBe('tok-initial');

    await vi.advanceTimersByTimeAsync(45 * 60 * 1000);
    expect(getCachedToken()).toBe('tok-refresh-1');
  });

  it('initTokenRefresh continues with stale token if refresh throws', async () => {
    getAccessTokenMock.mockResolvedValueOnce({ token: 'tok-initial' }).mockRejectedValueOnce(new Error('network'));

    await initTokenRefresh();
    await vi.advanceTimersByTimeAsync(45 * 60 * 1000);
    expect(getCachedToken()).toBe('tok-initial');
  });

  it('stopTokenRefresh clears cached token', async () => {
    getAccessTokenMock.mockResolvedValue({ token: 'tok-x' });
    await initTokenRefresh();
    expect(getCachedToken()).toBe('tok-x');
    stopTokenRefresh();
    expect(getCachedToken()).toBeNull();
  });
});

// issue #104 root cause fix (2026-07-03) — 45min refresh loop で更新される cachedToken が
// OTLPTraceExporter の HeadersFactory に届くことを end-to-end で確認する。
// 旧実装 (`_headers` hack) が SDK@0.219.0 で silent no-op になり、45min ごとの refresh が
// 起きていても exporter は起動時 Bearer で 1h 後に全 span が 401 で drop していた。
// 本 describe block はその再発を検知する回帰テスト。
const exporterInstances: Array<{ headersConfig: unknown }> = [];
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => {
  class OTLPTraceExporter {
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
  }
  return { OTLPTraceExporter };
});

vi.mock('@opentelemetry/sdk-node', () => {
  class NodeSDK {
    constructor(_opts: unknown) {}
    start() {}
    async shutdown() {}
  }
  return { NodeSDK };
});

vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: () => [],
}));

// otel.ts の import は describe 内で dynamic import する (mock 順序を保つ)。
describe('token refresh → OTLPTraceExporter HeadersFactory integration (issue #104)', () => {
  const ORIG_ENV = process.env;

  beforeEach(() => {
    vi.useFakeTimers();
    getAccessTokenMock.mockReset();
    getClientMock.mockClear();
    logWarnMock.mockClear();
    exporterInstances.length = 0;
    stopTokenRefresh();
    process.env = { ...ORIG_ENV, GOOGLE_CLOUD_PROJECT: 'test-proj' };
  });

  afterEach(async () => {
    const { shutdownOtel } = await import('../otel.js');
    await shutdownOtel();
    stopTokenRefresh();
    process.env = ORIG_ENV;
    vi.useRealTimers();
  });

  it('reflects refreshed token in the exporter headers factory across two refresh intervals', async () => {
    getAccessTokenMock
      .mockResolvedValueOnce({ token: 'tok-1' })
      .mockResolvedValueOnce({ token: 'tok-2' })
      .mockResolvedValueOnce({ token: 'tok-3' });

    const { startOtel } = await import('../otel.js');
    await startOtel();
    const factory = exporterInstances[0].headersConfig as () => Promise<Record<string, string>>;

    expect((await factory()).Authorization).toBe('Bearer tok-1');

    await vi.advanceTimersByTimeAsync(45 * 60 * 1000);
    expect((await factory()).Authorization).toBe('Bearer tok-2');

    await vi.advanceTimersByTimeAsync(45 * 60 * 1000);
    expect((await factory()).Authorization).toBe('Bearer tok-3');
  });

  it('uses stale token in the factory when refresh fails (degraded fallback + warn log)', async () => {
    getAccessTokenMock.mockResolvedValueOnce({ token: 'tok-initial' }).mockRejectedValueOnce(new Error('network'));

    const { startOtel } = await import('../otel.js');
    await startOtel();
    const factory = exporterInstances[0].headersConfig as () => Promise<Record<string, string>>;

    expect((await factory()).Authorization).toBe('Bearer tok-initial');

    await vi.advanceTimersByTimeAsync(45 * 60 * 1000);
    // refresh 失敗時は cachedToken を温存 (auth.ts:29 の warn + throw なし経路)。
    expect((await factory()).Authorization).toBe('Bearer tok-initial');
    expect(logWarnMock).toHaveBeenCalledWith(
      'OTel token refresh failed',
      expect.objectContaining({ error: expect.stringContaining('network') }),
    );
  });
});
