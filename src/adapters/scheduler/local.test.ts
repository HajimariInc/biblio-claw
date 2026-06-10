import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from '../../log.js';
import { getSchedulerProvider } from './index.js';
import { FATAL_FAILURE_THRESHOLD, LocalScheduler } from './local.js';

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

  // PR #6 review P7: tick が連続失敗したときに on-call が気づける形で signal
  // を出す。閾値以下は log.error、閾値到達で 1 回だけ log.fatal、その後再成功
  // でカウンタがリセットされること。
  it('escalates to log.fatal once at the consecutive-failure threshold', async () => {
    const fatalSpy = vi.spyOn(log, 'fatal').mockImplementation(() => {});
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    const tick = vi.fn().mockRejectedValue(new Error('persistent failure'));
    const s = new LocalScheduler(1000);
    s.start(tick);

    // Advance through THRESHOLD ticks. Each one rejects.
    for (let i = 0; i < FATAL_FAILURE_THRESHOLD; i++) {
      await vi.advanceTimersByTimeAsync(i === 0 ? 0 : 1000);
    }
    expect(tick).toHaveBeenCalledTimes(FATAL_FAILURE_THRESHOLD);
    expect(fatalSpy).toHaveBeenCalledTimes(1);

    // Past the threshold, no further fatals (one signal is enough).
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fatalSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls.length).toBeGreaterThanOrEqual(FATAL_FAILURE_THRESHOLD);

    s.stop();
    fatalSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('resets the consecutive-failure counter after a successful tick', async () => {
    const fatalSpy = vi.spyOn(log, 'fatal').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});
    // Alternate fail / fail / success / fail / fail / fail / fail — never hits 5 in a row.
    const tick = vi
      .fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('3'))
      .mockRejectedValueOnce(new Error('4'))
      .mockRejectedValueOnce(new Error('5'))
      .mockRejectedValueOnce(new Error('6'));
    const s = new LocalScheduler(1000);
    s.start(tick);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    // Success reset → only 4 consecutive failures at the end → no fatal.
    expect(fatalSpy).not.toHaveBeenCalled();
    s.stop();
    vi.restoreAllMocks();
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
