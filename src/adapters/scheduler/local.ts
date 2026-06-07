import { log } from '../../log.js';
import type { SchedulerProvider } from './types.js';

/** Default sweep cadence — one tick per minute (was host-sweep's SWEEP_INTERVAL_MS). */
export const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Local scheduler: a recursive `setTimeout` loop (NOT `setInterval`). The next
 * tick is only armed after the previous one resolves, so a slow sweep can never
 * overlap itself — preserving the single-in-flight property the host sweep
 * relied on.
 */
export class LocalScheduler implements SchedulerProvider {
  readonly name = 'local';
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly intervalMs: number = DEFAULT_INTERVAL_MS) {}

  start(tick: () => Promise<void>): void {
    if (this.running) return;
    this.running = true;

    const loop = async (): Promise<void> => {
      if (!this.running) return;
      try {
        await tick();
      } catch (err) {
        // `tick` is expected to be self-contained (host-sweep's sweepOnce
        // swallows its own errors), but the SchedulerProvider contract allows
        // a rejecting tick. Log instead of letting `void loop()` surface an
        // unhandledRejection, and keep the loop alive — one bad tick must not
        // silently kill the sweep.
        log.error('Scheduler tick threw', { err });
      } finally {
        // Re-check: stop() may have fired while the tick was in flight.
        if (this.running) {
          this.timer = setTimeout(loop, this.intervalMs);
        }
      }
    };

    // Fire the first tick immediately, matching the old startHostSweep().
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
