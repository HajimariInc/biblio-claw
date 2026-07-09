/**
 * Scheduler provider factory. Selected by `SCHEDULER_PROVIDER` (default
 * `local`). Not memoized — the single consumer (host-sweep) holds its own
 * instance for the process lifetime.
 */
import { LocalScheduler } from './local.js';
import type { SchedulerProvider } from './types.js';

export type { SchedulerProvider } from './types.js';

export function getSchedulerProvider(intervalMs?: number): SchedulerProvider {
  const name = process.env.SCHEDULER_PROVIDER || 'local';
  switch (name) {
    case 'local':
      // intervalMs 未指定は LocalScheduler の DEFAULT_INTERVAL_MS (= 60_000) 経路。
      // issue #136 で新設した vertex-secret-snapshot (30s) / vertex-auth-heartbeat (5min)
      // が sidecar 固有の interval を指定する必要があり optional 引数として拡張した。
      return intervalMs != null ? new LocalScheduler(intervalMs) : new LocalScheduler();
    default:
      throw new Error(`Unknown SCHEDULER_PROVIDER: ${name}. Known: local`);
  }
}
