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
   *
   * Implementations MUST NOT overlap ticks — the next tick is armed only after
   * the previous one resolves (or rejects). This single-in-flight property is
   * load-bearing for the host sweep, which is not designed to run concurrently
   * with itself. A naive `setInterval`-based implementation would break this;
   * the local provider uses a recursive `setTimeout` to enforce it.
   */
  start(tick: () => Promise<void>): void;
  /** Stop the loop. Safe to call before `start` (no-op). */
  stop(): void;
}
