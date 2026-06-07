/**
 * Phase 1 adapter resolution smoke (called by scripts/verify-phase-1.sh).
 *
 * Resolves the three environment-difference factories and asserts they fall
 * back to their local/onecli defaults with sane derived values. Exits non-zero
 * on any mismatch so the verify script fails loudly.
 */
import { getDsnProvider, getSchedulerProvider, getSecretProvider } from '../src/adapters/index.js';

function fail(msg: string): never {
  console.error('adapters smoke failed:', msg);
  process.exit(1);
}

const dsn = getDsnProvider();
const scheduler = getSchedulerProvider();
const secret = getSecretProvider();

if (dsn.name !== 'local') fail(`dsn.name=${dsn.name}`);
if (scheduler.name !== 'local') fail(`scheduler.name=${scheduler.name}`);
if (secret.name !== 'onecli') fail(`secret.name=${secret.name}`);
if (!dsn.centralDbPath().endsWith('v2.db')) fail(`centralDbPath=${dsn.centralDbPath()}`);

console.log('factories ok:', dsn.name, scheduler.name, secret.name);
