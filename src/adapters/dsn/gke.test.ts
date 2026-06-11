import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GkeDsnProvider } from './gke.js';
import { _resetDsnProviderForTesting, getDsnProvider } from './index.js';

describe('GkeDsnProvider', () => {
  // Constructor reads process.env.DATA_DIR directly; cover both unset and
  // overridden cases without going through config.ts (GKE does not use the
  // <PROJECT_ROOT>/data fallback that LocalDsnProvider relies on).
  let originalDataDir: string | undefined;
  beforeEach(() => {
    originalDataDir = process.env.DATA_DIR;
  });
  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it('uses /data as the default data root when DATA_DIR is unset', () => {
    delete process.env.DATA_DIR;
    const p = new GkeDsnProvider();
    expect(p.centralDbPath()).toBe('/data/v2.db');
    expect(p.sessionsBaseDir()).toBe('/data/v2-sessions');
  });

  it('honours an overridden DATA_DIR', () => {
    process.env.DATA_DIR = '/custom';
    const p = new GkeDsnProvider();
    expect(p.centralDbPath()).toBe('/custom/v2.db');
    expect(p.sessionsBaseDir()).toBe('/custom/v2-sessions');
  });

  it('composes per-session DB paths under the sessions base dir', () => {
    delete process.env.DATA_DIR;
    const p = new GkeDsnProvider();
    expect(p.sessionDir('g1', 's1')).toBe(path.join('/data/v2-sessions', 'g1', 's1'));
    expect(p.inboundDbPath('g1', 's1')).toBe(path.join('/data/v2-sessions', 'g1', 's1', 'inbound.db'));
    expect(p.outboundDbPath('g1', 's1')).toBe(path.join('/data/v2-sessions', 'g1', 's1', 'outbound.db'));
  });

  it('exposes name "gke"', () => {
    expect(new GkeDsnProvider().name).toBe('gke');
  });
});

describe('getDsnProvider with DSN_PROVIDER=gke', () => {
  beforeEach(() => {
    _resetDsnProviderForTesting();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetDsnProviderForTesting();
  });

  it('returns a GKE provider when DSN_PROVIDER=gke and memoizes it', () => {
    vi.stubEnv('DSN_PROVIDER', 'gke');
    const a = getDsnProvider();
    expect(a.name).toBe('gke');
    expect(getDsnProvider()).toBe(a);
  });

  it('rejects an unknown DSN_PROVIDER and lists both known values', () => {
    vi.stubEnv('DSN_PROVIDER', 'bogus');
    expect(() => getDsnProvider()).toThrow(/Unknown DSN_PROVIDER: bogus.*Known: local, gke/);
  });
});
