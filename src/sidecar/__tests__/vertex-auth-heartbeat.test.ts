import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { schedulerStart, schedulerStop, warnCalls, infoCalls, errorCalls, fatalCalls, vertexClientCreate } = vi.hoisted(
  () => ({
    schedulerStart: vi.fn(),
    schedulerStop: vi.fn(),
    warnCalls: [] as unknown[],
    infoCalls: [] as unknown[],
    errorCalls: [] as unknown[],
    fatalCalls: [] as unknown[],
    vertexClientCreate: vi.fn(),
  }),
);

vi.mock('../../adapters/scheduler/index.js', () => ({
  getSchedulerProvider: () => ({ name: 'mock', start: schedulerStart, stop: schedulerStop }),
}));

vi.mock('../../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: (...args: unknown[]) => infoCalls.push(args),
    warn: (...args: unknown[]) => warnCalls.push(args),
    error: (...args: unknown[]) => errorCalls.push(args),
    fatal: (...args: unknown[]) => fatalCalls.push(args),
  },
}));

vi.mock('@anthropic-ai/vertex-sdk', () => ({
  AnthropicVertex: vi.fn(function (this: { messages: { create: unknown } }) {
    this.messages = { create: vertexClientCreate };
  }),
}));

// forensic payload builder は snapshot 依存で pure 化しにくいため mock で決定化。
vi.mock('../../adk/vertex-forensic.js', () => ({
  buildVertexForensicPayload: (input: Record<string, unknown>) => ({
    event: 'vertex.401.forensic_dump',
    outcome: 'failure',
    ...input,
    err_message: (input.err as Error)?.message ?? '',
  }),
}));

// google-auth-library GoogleAuth は mock (test 環境で ADC 解決を試みない)。
vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(),
}));

// module-level state (consecutiveFailures) が test 間で漏れないよう、各 test で
// isolate module を fresh import する (vi.resetModules + dynamic import)。
type HeartbeatModule = typeof import('../vertex-auth-heartbeat.js');
let mod: HeartbeatModule;

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'test-project';
  process.env.CLOUD_ML_REGION = 'global';
  schedulerStart.mockClear();
  schedulerStop.mockClear();
  warnCalls.length = 0;
  infoCalls.length = 0;
  errorCalls.length = 0;
  fatalCalls.length = 0;
  vertexClientCreate.mockReset();
  vi.resetModules();
  mod = await import('../vertex-auth-heartbeat.js');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mod?.stopVertexAuthHeartbeat();
});

describe('vertex-auth-heartbeat', () => {
  it('両経路 probe 成功時、consecutive failures が 0 に維持される', async () => {
    vertexClientCreate.mockResolvedValue({ content: [] });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);

    await mod.heartbeatTick();
    const counts = mod.getVertexAuthHeartbeatFailureCounts();
    expect(counts.adk).toBe(0);
    expect(counts.onecli).toBe(0);
    // 両経路とも heartbeat_ok event が出ている
    const okAdk = infoCalls.some((call) => {
      const payload = (call as unknown[])[1] as { channel?: string } | undefined;
      return payload?.channel === 'adk';
    });
    const okOnecli = infoCalls.some((call) => {
      const payload = (call as unknown[])[1] as { channel?: string } | undefined;
      return payload?.channel === 'onecli';
    });
    expect(okAdk).toBe(true);
    expect(okOnecli).toBe(true);
  });

  it('ADK 経路 429 は fatal counter に含めない (rate_limited event 発火)', async () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    vertexClientCreate.mockRejectedValue(err);
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);

    await mod.heartbeatTick();
    const counts = mod.getVertexAuthHeartbeatFailureCounts();
    expect(counts.adk).toBe(0);
    const rateLimited = warnCalls.some((call) => {
      const payload = (call as unknown[])[1] as { outcome?: string; channel?: string } | undefined;
      return payload?.outcome === 'rate_limited' && payload?.channel === 'adk';
    });
    expect(rateLimited).toBe(true);
  });

  it('ADK 経路 non-429 失敗は consecutive カウントされる', async () => {
    const err = Object.assign(new Error('401'), { status: 401 });
    vertexClientCreate.mockRejectedValue(err);
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);

    await mod.heartbeatTick();
    expect(mod.getVertexAuthHeartbeatFailureCounts().adk).toBe(1);
    await mod.heartbeatTick();
    expect(mod.getVertexAuthHeartbeatFailureCounts().adk).toBe(2);
  });

  it('3 回連続失敗で log.fatal 発火 (threshold escalation)', async () => {
    const err = Object.assign(new Error('401'), { status: 401 });
    vertexClientCreate.mockRejectedValue(err);
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);

    await mod.heartbeatTick();
    await mod.heartbeatTick();
    await mod.heartbeatTick();

    expect(mod.getVertexAuthHeartbeatFailureCounts().adk).toBe(3);
    const fatal = fatalCalls.some((call) => {
      const payload = (call as unknown[])[1] as { channel?: string; consecutive_failures?: number } | undefined;
      return payload?.channel === 'adk' && payload?.consecutive_failures === 3;
    });
    expect(fatal).toBe(true);
  });

  it('OneCLI 経路 fetch 失敗も consecutive カウントされる (別独立)', async () => {
    vertexClientCreate.mockResolvedValue({ content: [] });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response);

    await mod.heartbeatTick();
    expect(mod.getVertexAuthHeartbeatFailureCounts().adk).toBe(0);
    expect(mod.getVertexAuthHeartbeatFailureCounts().onecli).toBe(1);
  });
});
