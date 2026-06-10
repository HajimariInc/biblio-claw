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
/**
 * Threshold at which "tick has been throwing for too long" becomes an
 * operationally meaningful event. 5 consecutive failures at the 60s default
 * interval = 5 minutes of dead sweep — long enough to be a real outage,
 * short enough that the first FATAL fires before the on-call window closes.
 */
export const FATAL_FAILURE_THRESHOLD = 5;

export class LocalScheduler implements SchedulerProvider {
  readonly name = 'local';
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  // Consecutive tick failures since the last success. Reset on every successful
  // tick. Surfaced via log.fatal at FATAL_FAILURE_THRESHOLD so the loop being
  // "alive but dead" (process up, but every sweep throwing) becomes observable
  // rather than buried in a stream of log.error entries (PR #6 review P7).
  private consecutiveFailures = 0;

  constructor(private readonly intervalMs: number = DEFAULT_INTERVAL_MS) {}

  start(tick: () => Promise<void>): void {
    if (this.running) return;
    this.running = true;
    this.consecutiveFailures = 0;

    const loop = async (): Promise<void> => {
      if (!this.running) return;
      try {
        await tick();
        this.consecutiveFailures = 0;
      } catch (err) {
        // `tick` is expected to be self-contained (host-sweep's sweepOnce
        // swallows its own errors), but the SchedulerProvider contract allows
        // a rejecting tick. Log instead of letting `void loop()` surface an
        // unhandledRejection, and keep the loop alive — one bad tick must not
        // silently kill the sweep.
        this.consecutiveFailures += 1;
        log.error('Scheduler tick threw', {
          err,
          consecutiveFailures: this.consecutiveFailures,
        });
        if (this.consecutiveFailures === FATAL_FAILURE_THRESHOLD) {
          // Escalate exactly once at the threshold. The loop keeps running —
          // we don't crash the host because a transient outage (network /
          // OneCLI restart) shouldn't take down the whole process. The fatal
          // log entry is the on-call signal.
          log.fatal(
            `Scheduler has failed ${FATAL_FAILURE_THRESHOLD} ticks in a row — sweep is effectively dead. Investigate immediately.`,
            { consecutiveFailures: this.consecutiveFailures, err },
          );
        }
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
