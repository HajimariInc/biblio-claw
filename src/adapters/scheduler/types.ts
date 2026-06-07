/**
 * Scheduler provider contract.
 *
 * Abstracts the source of the periodic "tick" that drives the host sweep so
 * the cadence mechanism is env-swappable. Phase 1 ships a local in-process
 * recursive-setTimeout loop; Phase 2 can drive ticks from an external trigger
 * without touching `host-sweep.ts`.
 */
export interface SchedulerProvider {
  readonly name: string;
  /**
   * Begin invoking `tick` on the provider's cadence. Idempotent — a second
   * call while already running is a no-op.
   */
  start(tick: () => Promise<void>): void;
  /** Stop the loop. Safe to call before `start` (no-op). */
  stop(): void;
}
