/**
 * Mount helpers shared between container-runner and the K8s provider.
 *
 * Phase 2.5 split out `subPathOf` from `container-runner.ts:buildMounts` so
 * it can also be applied to `additionalMounts` / provider-contributed mounts
 * (previously they pushed without `subPath`, which made K8s silently drop
 * them) and so the boundary cases (`..`-prefixed relpath, absolute relpath,
 * empty string) are covered by unit tests independent of buildMounts.
 */
import path from 'node:path';

/**
 * Compute the PVC subPath for a host-side absolute path, relative to
 * `dataDir`.
 *
 * Returns the relative path if `hostPath` is a strict subpath of `dataDir`.
 * Returns `undefined` when `hostPath` is outside `dataDir` — caused by either
 *
 *   1. An image-layer path (e.g. `<cwd>/container/CLAUDE.md`) that is
 *      intentionally outside `DATA_DIR` because the agent image bakes it in.
 *   2. A configuration mistake — most commonly `GROUPS_DIR` not being
 *      env-overridden to a `DATA_DIR` subdirectory (`/data/groups`) on GKE,
 *      leaving it at the local default (`<cwd>/groups`).
 *
 * On the K8s job spawn path, `undefined` makes the provider skip the mount
 * entirely — the agent Pod won't see that path through the shared PVC.
 * Callers that *expect* `hostPath` to be inside `DATA_DIR` (session dir,
 * group dir, .claude shared) should treat `undefined` as a configuration
 * error and surface it (see `container-runner.ts:expectInDataDir`).
 *
 * `dataDir` is passed in (not imported from `config.js`) so unit tests can
 * exercise boundary cases without stubbing the env-overridable constant.
 */
export function subPathOf(hostPath: string, dataDir: string): string | undefined {
  const rel = path.relative(dataDir, hostPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel;
}
