import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const { getAccessTokenMock, getClientMock, cachedTokenRef } = vi.hoisted(() => {
  const getAccessTokenMock = vi.fn();
  const getClientMock = vi.fn(async () => ({ getAccessToken: getAccessTokenMock }));
  const cachedTokenRef: { value: string | null } = { value: null };
  return { getAccessTokenMock, getClientMock, cachedTokenRef };
});

vi.mock('google-auth-library', () => {
  function GoogleAuth() {
    return { getClient: getClientMock };
  }
  return { GoogleAuth };
});

// auth.js は partial mock — initTokenRefresh / stopTokenRefresh は本物を使い、
// getCachedToken だけを test 側から制御可能にする (factory 経路の assertion 用)。
// initTokenRefresh が cachedTokenRef.value を書き換えるので、test 内では
// initTokenRefresh 後に上書き制御して factory の戻り値変化を観察する。
vi.mock('../auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.js')>();
  return {
    ...actual,
    getCachedToken: () => cachedTokenRef.value,
    initTokenRefresh: async () => {
      const token = await actual.fetchAccessToken();
      cachedTokenRef.value = token;
      return token;
    },
    stopTokenRefresh: () => {
      cachedTokenRef.value = null;
      actual.stopTokenRefresh();
    },
  };
});

// OTLP exporter をモックして実 export / shutdown timeout を回避 + constructor 引数
// (特に headers) をキャプチャして factory 経路の assertion を可能にする。
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

// NodeSDK 全体をモック (= 本物起動は auto-instrumentations の register/unregister
// で数秒〜10s+ かかるためテスト不向き。Plan の Task 17 要件は「start/shutdown が
// 例外 throw しない / 2 回 start で同一 instance」までで、実 SDK 挙動の検証は
// Level 4 smoke-test の責務)
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

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { startOtel, shutdownOtel, getTracer } from '../otel.js';

describe('startOtel/shutdownOtel', () => {
  const ORIG_ENV = process.env;

  beforeEach(() => {
    getAccessTokenMock.mockReset();
    getAccessTokenMock.mockResolvedValue({ token: 'tok-test' });
    exporterInstances.length = 0;
    cachedTokenRef.value = null;
    process.env = { ...ORIG_ENV, GOOGLE_CLOUD_PROJECT: 'test-proj' };
  });

  afterEach(async () => {
    await shutdownOtel();
    process.env = ORIG_ENV;
  });

  it('starts the SDK without throwing', async () => {
    await expect(startOtel()).resolves.toBeDefined();
  });

  it('returns the same SDK instance on a second call', async () => {
    const first = await startOtel();
    const second = await startOtel();
    expect(second).toBe(first);
  });

  it('throws when no project id is available', async () => {
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID;
    await expect(startOtel()).rejects.toThrow(/GOOGLE_CLOUD_PROJECT/);
  });

  it('shutdown is safe to call without prior start', async () => {
    await expect(shutdownOtel()).resolves.toBeUndefined();
  });

  it('getTracer returns a Tracer regardless of start state', () => {
    expect(getTracer('x').startSpan).toBeTypeOf('function');
  });
});

// issue #104 root cause fix (2026-07-03) — HeadersFactory 経路の behavior contract を固定する。
// SDK バージョンアップで headers 呼出頻度が変わったり、static object へ回帰した場合に
// 検知できるようにする。旧 _headers hack は SDK@0.219.0 で silent no-op に退化していた。
describe('OTel exporter headers factory (issue #104 fix)', () => {
  const ORIG_ENV = process.env;

  beforeEach(() => {
    getAccessTokenMock.mockReset();
    exporterInstances.length = 0;
    cachedTokenRef.value = null;
    process.env = { ...ORIG_ENV, GOOGLE_CLOUD_PROJECT: 'test-proj' };
  });

  afterEach(async () => {
    await shutdownOtel();
    process.env = ORIG_ENV;
  });

  it('passes a function (HeadersFactory) to OTLPTraceExporter.headers, not a static object', async () => {
    getAccessTokenMock.mockResolvedValue({ token: 'tok-init' });
    await startOtel();

    expect(exporterInstances).toHaveLength(1);
    expect(typeof exporterInstances[0].headersConfig).toBe('function');
  });

  it('factory returns fresh token from getCachedToken on each call (not the init-time token)', async () => {
    getAccessTokenMock.mockResolvedValue({ token: 'tok-init' });
    await startOtel();

    const factory = exporterInstances[0].headersConfig as () => Promise<Record<string, string>>;

    cachedTokenRef.value = 'tok-A';
    const first = await factory();
    expect(first).toEqual({
      Authorization: 'Bearer tok-A',
      'x-goog-user-project': 'test-proj',
    });

    cachedTokenRef.value = 'tok-B';
    const second = await factory();
    expect(second.Authorization).toBe('Bearer tok-B');
    expect(second['x-goog-user-project']).toBe('test-proj');
  });

  it('factory falls back to empty Bearer when cachedToken is null (no throw)', async () => {
    getAccessTokenMock.mockResolvedValue({ token: 'tok-init' });
    await startOtel();

    const factory = exporterInstances[0].headersConfig as () => Promise<Record<string, string>>;

    cachedTokenRef.value = null;
    await expect(factory()).resolves.toEqual({
      Authorization: 'Bearer ',
      'x-goog-user-project': 'test-proj',
    });
  });
});
