import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { subPathOf } from './mounts.js';

describe('subPathOf', () => {
  it('returns the relative subpath when hostPath is inside dataDir', () => {
    expect(subPathOf('/data/v2-sessions/g1/s1', '/data')).toBe('v2-sessions/g1/s1');
    expect(subPathOf('/data/groups/foo/CLAUDE.md', '/data')).toBe('groups/foo/CLAUDE.md');
  });

  it('returns undefined when hostPath equals dataDir (empty relpath)', () => {
    // path.relative('/data', '/data') === '' — semantically there's no subPath
    // to use; the K8s provider must skip rather than mount the PVC root.
    expect(subPathOf('/data', '/data')).toBeUndefined();
  });

  it('returns undefined when hostPath sits above dataDir (rel starts with "..")', () => {
    // Triggers when DATA_DIR=<cwd>/data and GROUPS_DIR=<cwd>/groups (the local
    // defaults) on a K8s spawn — the silent skip we want to prevent.
    expect(subPathOf('/groups/foo', '/data')).toBeUndefined();
    expect(subPathOf('/var/lib/some-other-host-path', '/data')).toBeUndefined();
  });

  it('returns undefined when hostPath is on a different absolute root', () => {
    // path.relative may return an absolute path on Windows-style cross-drive
    // inputs; defend against that even on POSIX where it's near-impossible.
    const dataDir = path.resolve('/data');
    // Use an unrelated absolute path that path.relative computes to a
    // .. prefix (POSIX). The contract is: outside dataDir → undefined.
    expect(subPathOf('/opt/something', dataDir)).toBeUndefined();
  });

  it('handles trailing slashes in hostPath consistently with path.relative', () => {
    // path.relative normalises trailing slashes, so '/data/v2-sessions/g1/'
    // and '/data/v2-sessions/g1' both produce 'v2-sessions/g1'.
    expect(subPathOf('/data/v2-sessions/g1/', '/data')).toBe('v2-sessions/g1');
    expect(subPathOf('/data/v2-sessions/g1', '/data')).toBe('v2-sessions/g1');
  });

  it('respects a non-/data dataDir argument (callers pass DATA_DIR; not hardcoded)', () => {
    expect(subPathOf('/custom/root/v2-sessions/g1/s1', '/custom/root')).toBe('v2-sessions/g1/s1');
    expect(subPathOf('/data/v2-sessions/g1/s1', '/custom/root')).toBeUndefined();
  });
});
