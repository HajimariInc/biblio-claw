import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const { getAccessTokenMock, getClientMock, cachedTokenRef, logWarnMock } = vi.hoisted(() => {
  const getAccessTokenMock = vi.fn();
  const getClientMock = vi.fn(async () => ({ getAccessToken: getAccessTokenMock }));
  const cachedTokenRef: { value: string | null } = { value: null };
  const logWarnMock = vi.fn();
  return { getAccessTokenMock, getClientMock, cachedTokenRef, logWarnMock };
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
// NodeSDK.shutdown() の onShutdown hook は shutdownOtel の順序 regression test 用。
// BatchSpanProcessor._flushAll() 中に headers factory が呼ばれる状況を simulate する。
vi.mock('@opentelemetry/sdk-node', () => {
  class NodeSDK {
    onShutdown?: () => void | Promise<void>;
    constructor(_opts: unknown) {}
    start() {}
    async shutdown() {
      if (this.onShutdown) await this.onShutdown();
    }
  }
  return { NodeSDK };
});

vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: () => [],
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: logWarnMock, error: vi.fn(), fatal: vi.fn() },
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
    logWarnMock.mockClear();
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

// issue #104 対応 — shutdownOtel の呼び出し順序 regression 検知。
// stopTokenRefresh() を sdkInstance.shutdown() より先に呼ぶと、BatchSpanProcessor._flushAll()
// の最終 flush 中に headers factory が空 Bearer を返して 401 → 直近 span が silent drop する。
describe('OTel shutdown flush order (issue #104 review)', () => {
  const ORIG_ENV = process.env;

  beforeEach(() => {
    getAccessTokenMock.mockReset();
    logWarnMock.mockClear();
    exporterInstances.length = 0;
    cachedTokenRef.value = null;
    process.env = { ...ORIG_ENV, GOOGLE_CLOUD_PROJECT: 'test-proj' };
  });

  afterEach(async () => {
    await shutdownOtel();
    process.env = ORIG_ENV;
  });

  it('preserves valid token during final BatchSpanProcessor flush (regression test)', async () => {
    getAccessTokenMock.mockResolvedValue({ token: 'tok-init' });
    const sdk = await startOtel();
    const factory = exporterInstances[0].headersConfig as () => Promise<Record<string, string>>;

    // sdk.shutdown() 中 (= _flushAll → exporter.export → headers() 相当) に factory を呼び、
    // その時点の Authorization をキャプチャする。実装が
    //   `stopTokenRefresh(); await sdkInstance.shutdown();` の順だと cachedToken は null になっているので
    // Authorization が空 Bearer になる = test 失敗。
    let flushHeaders: Record<string, string> | null = null;
    (sdk as unknown as { onShutdown: () => Promise<void> }).onShutdown = async () => {
      flushHeaders = await factory();
    };

    await shutdownOtel();

    expect(flushHeaders).not.toBeNull();
    expect(flushHeaders!.Authorization).not.toBe('Bearer ');
    expect(flushHeaders!.Authorization).toBe('Bearer tok-init');
  });
});

// issue #104 対応 — cachedToken null 時の警告経路。
// 旧 _headers hack と同じ「無音で 401 drop」を再現する経路になり得るため、
// factory が空 Bearer を返す条件で 1 回だけ warn を発火する最終防衛線。
describe('OTel headers factory null cachedToken warn (issue #104 review)', () => {
  const ORIG_ENV = process.env;

  beforeEach(() => {
    getAccessTokenMock.mockReset();
    logWarnMock.mockClear();
    exporterInstances.length = 0;
    cachedTokenRef.value = null;
    process.env = { ...ORIG_ENV, GOOGLE_CLOUD_PROJECT: 'test-proj' };
  });

  afterEach(async () => {
    await shutdownOtel();
    process.env = ORIG_ENV;
  });

  it('warns exactly once when cachedToken is null across multiple factory calls', async () => {
    getAccessTokenMock.mockResolvedValue({ token: 'tok-init' });
    await startOtel();
    const factory = exporterInstances[0].headersConfig as () => Promise<Record<string, string>>;

    // null に強制 → factory を 3 回呼出 → warn は 1 回のみ発火
    cachedTokenRef.value = null;
    await factory();
    await factory();
    await factory();

    const nullWarnCalls = logWarnMock.mock.calls.filter(
      (call) => call[0] === 'OTel headers factory: cachedToken is null, sending empty Bearer',
    );
    expect(nullWarnCalls).toHaveLength(1);
    expect(nullWarnCalls[0][1]).toMatchObject({
      event: 'otel.headers.cached_token_null',
      outcome: 'degraded',
    });
  });

  it('does not warn when cachedToken is non-null', async () => {
    getAccessTokenMock.mockResolvedValue({ token: 'tok-init' });
    await startOtel();
    const factory = exporterInstances[0].headersConfig as () => Promise<Record<string, string>>;

    cachedTokenRef.value = 'tok-valid';
    await factory();
    await factory();

    const nullWarnCalls = logWarnMock.mock.calls.filter(
      (call) => call[0] === 'OTel headers factory: cachedToken is null, sending empty Bearer',
    );
    expect(nullWarnCalls).toHaveLength(0);
  });
});
