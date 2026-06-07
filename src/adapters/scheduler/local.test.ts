import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getSchedulerProvider } from './index.js';
import { LocalScheduler } from './local.js';

describe('LocalScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('fires the first tick immediately, then on each interval', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const s = new LocalScheduler(1000);
    s.start(tick);

    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(3);

    s.stop();
  });

  it('stops firing after stop()', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const s = new LocalScheduler(1000);
    s.start(tick);

    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    s.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('does not overlap ticks — next is armed only after the prior resolves (recursive setTimeout)', async () => {
    // Holder avoids TS narrowing `resolveTick` to never when assigned inside
    // the Promise executor closure.
    const deferred: { resolve: () => void } = { resolve: () => {} };
    const tick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    const s = new LocalScheduler(1000);
    s.start(tick);

    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    // Even after well over one interval, the second tick must NOT fire while
    // the first is still in flight (a setInterval would have fired it).
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(1);

    // Resolve the first tick; only then is the next one armed.
    deferred.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);

    s.stop();
    deferred.resolve();
  });

  it('keeps the loop alive when a tick rejects (logs instead of dying)', async () => {
    const tick = vi.fn().mockRejectedValueOnce(new Error('transient tick failure')).mockResolvedValue(undefined);
    const s = new LocalScheduler(1000);
    s.start(tick);

    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    // The rejected tick must not stop the loop — the next one is still armed.
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);

    s.stop();
  });

  it('stop() before start() is a no-op', () => {
    const s = new LocalScheduler();
    expect(() => s.stop()).not.toThrow();
  });

  it('start() is idempotent', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const s = new LocalScheduler(1000);
    s.start(tick);
    s.start(tick);
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    s.stop();
  });
});

describe('getSchedulerProvider', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns a local scheduler by default', () => {
    expect(getSchedulerProvider().name).toBe('local');
  });

  it('throws on an unknown SCHEDULER_PROVIDER value', () => {
    vi.stubEnv('SCHEDULER_PROVIDER', 'bogus');
    expect(() => getSchedulerProvider()).toThrow(/Unknown SCHEDULER_PROVIDER: bogus/);
  });
});
