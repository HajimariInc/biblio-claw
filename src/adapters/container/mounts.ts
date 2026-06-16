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
 * Returns the relative path of `hostPath` under `dataDir`, or `undefined`
 * if outside. On the K8s path, `undefined` makes the provider skip the mount
 * (= image-layer paths, or misconfigured GROUPS_DIR — see `expectInDataDir`
 * in `container-runner.ts` for the warn-on-surprise wrapper).
 *
 * `dataDir` is injected (not imported) so unit tests avoid stubbing env.
 */
export function subPathOf(hostPath: string, dataDir: string): string | undefined {
  const rel = path.relative(dataDir, hostPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel;
}
