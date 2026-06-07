import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Follow the codebase convention for redirecting the data root in tests:
// mock config so DATA_DIR (the env-overridable data root) points at a fixed
// value. LocalDsnProvider derives every path from config.DATA_DIR.
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/custom/root' };
});

import { _resetDsnProviderForTesting, getDsnProvider } from './index.js';
import { LocalDsnProvider } from './local.js';

describe('LocalDsnProvider', () => {
  it('derives the central DB path from the (env-overridable) data root', () => {
    expect(new LocalDsnProvider().centralDbPath()).toBe('/custom/root/v2.db');
  });

  it('derives the sessions base dir from the data root', () => {
    expect(new LocalDsnProvider().sessionsBaseDir()).toBe('/custom/root/v2-sessions');
  });

  it('composes per-session DB paths under the sessions base dir', () => {
    const p = new LocalDsnProvider();
    expect(p.sessionDir('g1', 's1')).toBe(path.join('/custom/root/v2-sessions', 'g1', 's1'));
    expect(p.inboundDbPath('g1', 's1')).toBe(path.join('/custom/root/v2-sessions', 'g1', 's1', 'inbound.db'));
    expect(p.outboundDbPath('g1', 's1')).toBe(path.join('/custom/root/v2-sessions', 'g1', 's1', 'outbound.db'));
  });

  it('exposes name "local"', () => {
    expect(new LocalDsnProvider().name).toBe('local');
  });
});

describe('getDsnProvider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    _resetDsnProviderForTesting();
  });

  it('returns a local provider by default and memoizes it', () => {
    const a = getDsnProvider();
    expect(a.name).toBe('local');
    expect(getDsnProvider()).toBe(a);
  });

  it('throws on an unknown DSN_PROVIDER value', () => {
    _resetDsnProviderForTesting();
    vi.stubEnv('DSN_PROVIDER', 'bogus');
    expect(() => getDsnProvider()).toThrow(/Unknown DSN_PROVIDER: bogus/);
  });
});
