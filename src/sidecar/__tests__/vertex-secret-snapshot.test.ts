import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { schedulerStart, schedulerStop, warnCalls, infoCalls } = vi.hoisted(() => ({
  schedulerStart: vi.fn(),
  schedulerStop: vi.fn(),
  warnCalls: [] as unknown[],
  infoCalls: [] as unknown[],
}));

vi.mock('../../adapters/scheduler/index.js', () => ({
  getSchedulerProvider: () => ({ name: 'mock', start: schedulerStart, stop: schedulerStop }),
}));

vi.mock('../../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: (...args: unknown[]) => infoCalls.push(args),
    warn: (...args: unknown[]) => warnCalls.push(args),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// module-level state (lastSnapshot) が test 間で漏れないよう、各 test で isolate。
type SnapshotModule = typeof import('../vertex-secret-snapshot.js');
let mod: SnapshotModule;

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  schedulerStart.mockClear();
  schedulerStop.mockClear();
  warnCalls.length = 0;
  infoCalls.length = 0;
  vi.resetModules();
  mod = await import('../vertex-secret-snapshot.js');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mod?.stopVertexSecretSnapshot();
});

describe('vertex-secret-snapshot', () => {
  it('snapshotOnce: 200 + Vertex secret 存在時、lastSnapshot に success 状態が入る', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 'abc-123',
          name: 'biblio-claw-vertex',
          hostPattern: 'aiplatform.googleapis.com',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    } as Response);

    await mod.snapshotOnce();
    const snap = mod.getLastVertexSecretSnapshot();
    expect(snap).not.toBeNull();
    expect(snap?.found).toBe(true);
    expect(snap?.secret_id).toBe('abc-123');
    expect(snap?.host_pattern).toBe('aiplatform.googleapis.com');
    expect(snap?.updated_at_epoch).toBe(Math.floor(Date.parse('2024-01-01T00:00:00Z') / 1000));
  });

  it('snapshotOnce: 200 + Vertex secret 不在時、lastSnapshot.found=false + warn 発火 (silent 化しない)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ id: 'other-1', name: 'not-biblio-vertex' }],
    } as Response);

    await mod.snapshotOnce();
    const snap = mod.getLastVertexSecretSnapshot();
    expect(snap?.found).toBe(false);
    expect(snap?.secret_id).toBe('');
    expect(warnCalls.length).toBeGreaterThan(0);
    // warn payload に event: 'vertex.onecli.secret_snapshot' が入る
    const found = warnCalls.some((call) => {
      const payload = (call as unknown[])[1] as { event?: string; outcome?: string } | undefined;
      return payload?.event === 'vertex.onecli.secret_snapshot' && payload?.outcome === 'not_found';
    });
    expect(found).toBe(true);
  });

  it('snapshotOnce: fetch throw 時、lastSnapshot は更新されず warn だけ残る (直近成功時の state 保持)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ id: 'seed-1', name: 'biblio-claw-vertex' }],
    } as Response);
    await mod.snapshotOnce();
    const seededSnap = mod.getLastVertexSecretSnapshot();
    expect(seededSnap?.secret_id).toBe('seed-1');

    // 次 tick で fetch throw = lastSnapshot は seed のまま
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network error'));
    await mod.snapshotOnce();
    const afterThrow = mod.getLastVertexSecretSnapshot();
    expect(afterThrow?.secret_id).toBe('seed-1'); // 保持
    // warn が発火している
    const warn = warnCalls.some((call) => {
      const payload = (call as unknown[])[1] as { outcome?: string } | undefined;
      return payload?.outcome === 'failure';
    });
    expect(warn).toBe(true);
  });

  it('startVertexSecretSnapshot 2 回目は skip (log.warn "called twice")', () => {
    mod.startVertexSecretSnapshot();
    expect(schedulerStart).toHaveBeenCalledTimes(1);
    mod.startVertexSecretSnapshot();
    // 2 回目は schedulerStart 呼ばれない
    expect(schedulerStart).toHaveBeenCalledTimes(1);
    const twiceWarn = warnCalls.some((call) => {
      const msg = (call as unknown[])[0];
      return typeof msg === 'string' && msg.includes('called twice');
    });
    expect(twiceWarn).toBe(true);
  });
});
