/**
 * DSN provider factory. Selected by the `DSN_PROVIDER` env var (default
 * `local`). Memoized — the host resolves a single provider for the process.
 *
 * No self-registration registry: with only local (Phase 1) and a future GCP
 * (Phase 2) implementation, an env switch is simpler and the known set stays
 * explicit (ARCHITECT decision, see plan §補足).
 */
import { LocalDsnProvider } from './local.js';
import type { DsnProvider } from './types.js';

export type { DsnProvider } from './types.js';

const KNOWN_PROVIDERS = ['local'];

let instance: DsnProvider | null = null;

export function getDsnProvider(): DsnProvider {
  if (instance) return instance;
  const name = process.env.DSN_PROVIDER || 'local';
  switch (name) {
    case 'local':
      instance = new LocalDsnProvider();
      break;
    default:
      throw new Error(`Unknown DSN_PROVIDER: ${name}. Known: ${KNOWN_PROVIDERS.join(', ')}`);
  }
  return instance;
}

/** Test-only: clear the memoized singleton so env changes re-resolve. */
export function _resetDsnProviderForTesting(): void {
  instance = null;
}
