/**
 * Scheduler provider factory. Selected by `SCHEDULER_PROVIDER` (default
 * `local`). Not memoized — the single consumer (host-sweep) holds its own
 * instance for the process lifetime.
 */
import { LocalScheduler } from './local.js';
import type { SchedulerProvider } from './types.js';

export type { SchedulerProvider } from './types.js';

const KNOWN_PROVIDERS = ['local'];

export function getSchedulerProvider(): SchedulerProvider {
  const name = process.env.SCHEDULER_PROVIDER || 'local';
  switch (name) {
    case 'local':
      return new LocalScheduler();
    default:
      throw new Error(`Unknown SCHEDULER_PROVIDER: ${name}. Known: ${KNOWN_PROVIDERS.join(', ')}`);
  }
}
