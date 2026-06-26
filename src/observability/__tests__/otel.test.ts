import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const { getAccessTokenMock, getClientMock } = vi.hoisted(() => {
  const getAccessTokenMock = vi.fn();
  const getClientMock = vi.fn(async () => ({ getAccessToken: getAccessTokenMock }));
  return { getAccessTokenMock, getClientMock };
});

vi.mock('google-auth-library', () => {
  function GoogleAuth() {
    return { getClient: getClientMock };
  }
  return { GoogleAuth };
});

// OTLP exporter をモックして実 export / shutdown timeout を回避
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => {
  class OTLPTraceExporter {
    _headers: Record<string, string> = {};
    constructor(opts?: { headers?: Record<string, string> }) {
      this._headers = { ...(opts?.headers ?? {}) };
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
