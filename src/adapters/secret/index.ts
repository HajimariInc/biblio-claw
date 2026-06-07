/**
 * SecretProvider factory. Selected by `SECRET_PROVIDER` (default `onecli`).
 *
 * Memoized — this MUST be a singleton: container-runner and onecli-approvals
 * both resolve through here and need to share the same OneCLI client (and its
 * one manual-approval long-poll handle).
 */
import { OneCLISecretProvider } from './onecli.js';
import type { SecretProvider } from './types.js';

export type { ApprovalCallback, SecretProvider } from './types.js';

const KNOWN_PROVIDERS = ['onecli'];

let instance: SecretProvider | null = null;

export function getSecretProvider(): SecretProvider {
  if (instance) return instance;
  const name = process.env.SECRET_PROVIDER || 'onecli';
  switch (name) {
    case 'onecli':
      instance = new OneCLISecretProvider();
      break;
    default:
      throw new Error(`Unknown SECRET_PROVIDER: ${name}. Known: ${KNOWN_PROVIDERS.join(', ')}`);
  }
  return instance;
}

/** Test-only: clear the memoized singleton so env changes re-resolve. */
export function _resetSecretProviderForTesting(): void {
  instance = null;
}
