/**
 * K8sJobContainerRuntimeProvider — runs each agent as a K8s Batch v1 Job.
 *
 * Selected on GKE via `CONTAINER_PROVIDER=k8s`. Reads `BIBLIO_NAMESPACE` and
 * `HOSTNAME` from env, and the in-cluster KSA token via `loadFromCluster()`.
 * The agent image comes through `spec.image` (resolved by container-runner
 * from the `CONTAINER_IMAGE` env or per-group override).
 *
 * Spawn flow:
 *   1. Build a V1Job body — `generateName` (avoid create/delete races),
 *      labels for NetworkPolicy match (`app.kubernetes.io/component=agent`),
 *      podAffinity to the orchestrator pod (RWO PVC needs same node),
 *      securityContext lockdown.
 *   2. Translate the AgentSpawnSpec — env stays as env, `spec.mounts` under
 *      `/data` become PVC subPath volumeMounts (same-node co-tenancy via
 *      podAffinity lets the orchestrator's RWO PVC be shared; Phase 2.5
 *      replaced hostPath here to clear the Autopilot Warden deny).
 *      `spec.onecliApplyArgs` is parsed: `-e` → env, `--add-host` →
 *      hostAliases, `-v` (OneCLI host-side CA paths) are dropped — the CA is
 *      delivered via the `biblio-onecli-ca` Secret mount instead.
 *   3. createNamespacedJob, register a deferred in `pending[jobName]`.
 *   4. Informer (one per provider instance, namespace-scoped, label-filtered)
 *      watches Job conditions; `add`/`update` resolve on `Complete`/`Failed`,
 *      `delete` resolves any pending entry that hasn't fired yet (background
 *      cascade can remove the Job before its condition update arrives).
 *
 * `spec.mounts` whose hostPath is outside `/data` are intentionally skipped
 * — orchestrator image-layer files (e.g. `/app/src`, `/app/skills`) aren't
 * reachable from another pod via hostPath. The agent image already ships
 * the same files at the same paths. Group dirs (`<cwd>/groups/<folder>`)
 * are also skipped — they live on the orchestrator's local FS. Future
 * dynamic-group support has to either move groups under DATA_DIR or use a
 * shared Volume.
 */
import * as k8s from '@kubernetes/client-node';

import { log } from '../../log.js';
import type { AgentExitInfo, AgentHandle, AgentSpawnSpec, ContainerRuntimeProvider } from './types.js';

// Cluster / informer config
const DEFAULT_NAMESPACE = 'biblio-claw';
const DEFAULT_ORCHESTRATOR_POD = 'biblio-orchestrator-0';
const INFORMER_RECONNECT_MS = 5_000;

// Shared PVC — agent Pod rides the orchestrator's RWO PVC via subPath mounts
// (Phase 2.5; GKE Autopilot Warden denies hostPath).
const DEFAULT_AGENT_PVC_NAME = 'data-biblio-orchestrator-0';
const SHARED_PVC_VOLUME_NAME = 'vol-shared';
const AGENT_FS_GROUP = 1000; // node:22-slim `node` UID/GID — aligns PVC group ownership (PoC-17)

// OneCLI CA Secret mount. The Secret content is auto-upserted by the OneCLI
// sidecar + src/sidecar/ca-secret-sync.ts (M2 PRD A Phase 3); this provider
// only consumes it as a plain Secret volume.
const DEFAULT_ONECLI_CA_SECRET_NAME = 'biblio-onecli-ca';
const ONECLI_CA_VOLUME_NAME = 'onecli-ca';
const ONECLI_CA_MOUNT_PATH = '/etc/ssl/certs/onecli';
const ONECLI_COMBINED_CA_PATH = `${ONECLI_CA_MOUNT_PATH}/onecli-combined-ca.pem`;

// OneCLI env rewrite — SDK's applyContainerConfig returns Docker-flavoured
// values (`...@host.docker.internal:10255`, `/tmp/onecli-gateway-ca.pem`)
// that don't resolve inside a Pod; rewrite to cluster-native equivalents.
const ONECLI_DOCKER_HOST = 'host.docker.internal';
const DEFAULT_ONECLI_SERVICE_HOST = 'biblio-onecli.biblio-claw.svc.cluster.local';
const ONECLI_PROXY_ENV_NAMES = new Set(['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']);

interface Pending {
  resolve: (info: AgentExitInfo) => void;
  killed: boolean;
}

interface ParsedNative {
  env: k8s.V1EnvVar[];
  volumes: k8s.V1Volume[];
  volumeMounts: k8s.V1VolumeMount[];
  hostAliases: k8s.V1HostAlias[];
}

export class K8sJobContainerRuntimeProvider implements ContainerRuntimeProvider {
  readonly name = 'k8s' as const;

  private kc?: k8s.KubeConfig;
  private batchApi?: k8s.BatchV1Api;
  private informer?: k8s.Informer<k8s.V1Job> & k8s.ObjectCache<k8s.V1Job>;
  private readonly namespace = process.env.BIBLIO_NAMESPACE || DEFAULT_NAMESPACE;
  private readonly orchestratorPodName = process.env.HOSTNAME || DEFAULT_ORCHESTRATOR_POD;
  private readonly pending = new Map<string, Pending>();

  async ensureRuntime(): Promise<void> {
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromCluster();
    this.batchApi = this.kc.makeApiClient(k8s.BatchV1Api);
    try {
      await this.batchApi.listNamespacedJob({ namespace: this.namespace, limit: 1 });
    } catch (err) {
      throw new Error(`K8s API not reachable in namespace ${this.namespace}`, { cause: err });
    }
    await this.startInformer();
    log.info('K8s container runtime ready', {
      namespace: this.namespace,
      orchestratorPod: this.orchestratorPodName,
    });
  }

  async cleanupOrphans(): Promise<void> {
    if (!this.batchApi) return;
    try {
      const list = await this.batchApi.listNamespacedJob({
        namespace: this.namespace,
        labelSelector: 'app.kubernetes.io/component=agent',
      });
      for (const job of list.items ?? []) {
        const conds = job.status?.conditions ?? [];
        const done = conds.some((c) => (c.type === 'Complete' || c.type === 'Failed') && c.status === 'True');
        if (done && job.metadata?.name) {
          const jobName = job.metadata.name;
          await this.batchApi
            .deleteNamespacedJob({
              name: jobName,
              namespace: this.namespace,
              propagationPolicy: 'Background',
            })
            .catch((err) => {
              log.warn('K8s Job delete failed during orphan cleanup', { jobName, err });
            });
        }
      }
    } catch (err) {
      log.warn('K8s orphan cleanup failed', { err });
    }
  }

  async spawn(spec: AgentSpawnSpec): Promise<AgentHandle> {
    if (!this.batchApi) {
      throw new Error('K8sJobContainerRuntimeProvider.spawn() called before ensureRuntime()');
    }
    const native = this.translateSpec(spec);
    const labels = this.commonLabels(spec);
    const jobBody: k8s.V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { generateName: 'biblio-agent-', namespace: this.namespace, labels },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 120,
        template: {
          metadata: { labels },
          spec: {
            restartPolicy: 'Never',
            affinity: this.podAffinityToOrchestrator(),
            // fsGroup aligns ownership on the shared PVC mount with the
            // container user (node:22-slim's `node`, UID/GID 1000). Without
            // it the subPath mounts come up root-owned and bun:sqlite can't
            // open the session DBs. PoC-17 used the same pattern (fsGroup:101
            // for the sqlite3 image); the value differs but the mechanism
            // does not.
            securityContext: { fsGroup: AGENT_FS_GROUP },
            ...(native.hostAliases.length > 0 ? { hostAliases: native.hostAliases } : {}),
            containers: [
              {
                name: 'agent',
                image: spec.image,
                imagePullPolicy: 'Always',
                command: ['bash'],
                args: [...spec.command],
                env: native.env,
                volumeMounts: native.volumeMounts,
                resources: { requests: { cpu: '250m', memory: '512Mi' } },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ['ALL'] },
                },
              },
            ],
            volumes: native.volumes,
          },
        },
      },
    };

    let created: k8s.V1Job;
    try {
      created = await this.batchApi.createNamespacedJob({
        namespace: this.namespace,
        body: jobBody,
      });
    } catch (err) {
      log.error('K8s createNamespacedJob failed', {
        agentGroup: spec.agentGroupName,
        sessionId: spec.sessionId,
        err,
      });
      throw err;
    }
    const jobName = created.metadata?.name;
    if (!jobName) {
      throw new Error('createNamespacedJob: response missing metadata.name');
    }

    log.info('K8s Job spawned', {
      jobName,
      agentGroup: spec.agentGroupName,
      sessionId: spec.sessionId,
    });

    const pending: Pending = { resolve: () => undefined, killed: false };
    const exitPromise = new Promise<AgentExitInfo>((resolve) => {
      pending.resolve = resolve;
    });
    this.pending.set(jobName, pending);

    return {
      id: jobName,
      waitForExit: () => exitPromise,
      kill: async () => {
        const entry = this.pending.get(jobName);
        if (entry) entry.killed = true;
        try {
          await this.batchApi!.deleteNamespacedJob({
            name: jobName,
            namespace: this.namespace,
            propagationPolicy: 'Background',
          });
        } catch (err) {
          log.warn('K8s Job delete failed', { jobName, err });
        }
      },
    };
  }

  private async startInformer(): Promise<void> {
    if (!this.kc || !this.batchApi) return;
    const labelSelector = 'app.kubernetes.io/component=agent';
    const listFn: k8s.ListPromise<k8s.V1Job> = () =>
      this.batchApi!.listNamespacedJob({ namespace: this.namespace, labelSelector });
    const informer = k8s.makeInformer<k8s.V1Job>(
      this.kc,
      `/apis/batch/v1/namespaces/${this.namespace}/jobs`,
      listFn,
      labelSelector,
    );
    informer.on('add', (job) => this.onJobUpdate(job));
    informer.on('update', (job) => this.onJobUpdate(job));
    // `delete` catches the case where a Job is removed before its terminal
    // condition reaches the informer — e.g. kill() via background cascade
    // delete, or `ttlSecondsAfterFinished` GC racing the update watch event.
    // Without this, `pending[jobName]` would never resolve and the host's
    // session bookkeeping (activeContainers / onExit) would leak.
    informer.on('delete', (job) => this.onJobDelete(job));
    informer.on('error', async (err) => {
      log.warn('K8s informer error, restarting', { err });
      try {
        await informer.stop();
      } catch (stopErr) {
        log.warn('K8s informer stop() failed during restart', { err: stopErr });
      }
      setTimeout(() => {
        informer.start().catch((e) => log.error('K8s informer restart failed', { err: e }));
      }, INFORMER_RECONNECT_MS);
    });
    this.informer = informer;
    await informer.start();
  }

  private onJobUpdate(job: k8s.V1Job): void {
    const jobName = job.metadata?.name;
    if (!jobName) return;
    const handle = this.pending.get(jobName);
    if (!handle) return;
    const conds = job.status?.conditions ?? [];
    const complete = conds.some((c) => c.type === 'Complete' && c.status === 'True');
    const failed = conds.some((c) => c.type === 'Failed' && c.status === 'True');
    if (complete || failed) {
      this.pending.delete(jobName);
      handle.resolve({
        code: job.status?.succeeded ?? null,
        reason: handle.killed ? 'killed' : failed ? 'failed' : 'complete',
      });
    }
  }

  private onJobDelete(job: k8s.V1Job): void {
    const jobName = job.metadata?.name;
    if (!jobName) return;
    const handle = this.pending.get(jobName);
    if (!handle) return;
    // The Job is gone before any condition reached us. If kill() was called,
    // honor that; otherwise treat the disappearance as a failed run (= the
    // host should not silently assume success).
    this.pending.delete(jobName);
    handle.resolve({
      code: job.status?.succeeded ?? null,
      reason: handle.killed ? 'killed' : 'failed',
    });
  }

  private commonLabels(spec: AgentSpawnSpec): Record<string, string> {
    // `name: biblio-claw` + `component: agent` together match the agent egress
    // NetworkPolicy (k8s/60-netpol-agent-egress.yaml). Drop either and the
    // pod loses the egress-restriction lockdown.
    return {
      'app.kubernetes.io/name': 'biblio-claw',
      'app.kubernetes.io/component': 'agent',
      'app.kubernetes.io/part-of': 'biblio-shelf',
      'biblio.agent-group-id': spec.agentGroupId,
      'biblio.session-id': spec.sessionId,
    };
  }

  private podAffinityToOrchestrator(): k8s.V1Affinity {
    return {
      podAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: [
          {
            topologyKey: 'kubernetes.io/hostname',
            labelSelector: {
              matchLabels: { 'statefulset.kubernetes.io/pod-name': this.orchestratorPodName },
            },
          },
        ],
      },
    };
  }

  private translateSpec(spec: AgentSpawnSpec): ParsedNative {
    const env: k8s.V1EnvVar[] = spec.env.map((e) => ({ name: e.name, value: e.value }));
    const volumes: k8s.V1Volume[] = [];
    const volumeMounts: k8s.V1VolumeMount[] = [];
    const hostAliases: k8s.V1HostAlias[] = [];

    // GKE Autopilot denies write-mode hostPath (Warden constraint
    // `autogke-no-write-mode-hostpath`), so every mount that backs onto the
    // host filesystem rides the orchestrator's RWO PVC instead. Same-node
    // co-tenancy is guaranteed by `podAffinityToOrchestrator()`, which lets
    // a single RWO PVC be shared between the StatefulSet pod and this Job
    // pod (per the GKE docs on RWO access mode).
    const pvcName = process.env.AGENT_PVC_NAME ?? DEFAULT_AGENT_PVC_NAME;
    const caSecretName = process.env.ONECLI_CA_SECRET_NAME ?? DEFAULT_ONECLI_CA_SECRET_NAME;

    let pvcVolumeAdded = false;
    for (const m of spec.mounts) {
      // image-layer mounts (no subPath) are baked into the agent image — the
      // Phase 2 `container/build.sh` step copies `container/CLAUDE.md`,
      // `container/agent-runner/src`, and `container/skills` to the same
      // paths the Docker bind mounts use. Skipping them keeps the K8s pod
      // spec hostPath-free.
      if (m.subPath === undefined) continue;
      if (!pvcVolumeAdded) {
        volumes.push({
          name: SHARED_PVC_VOLUME_NAME,
          persistentVolumeClaim: { claimName: pvcName },
        });
        pvcVolumeAdded = true;
      }
      volumeMounts.push({
        name: SHARED_PVC_VOLUME_NAME,
        mountPath: m.containerPath,
        subPath: m.subPath,
        readOnly: m.readonly,
      });
    }

    // OneCLI proxy CA bundle is mounted from the K8s Secret `biblio-onecli-ca`.
    // As of M2 PRD A Phase 3 that Secret is auto-upserted at startup + every 60s
    // by the OneCLI sidecar's emptyDir-shared CA via src/sidecar/ca-secret-sync.ts
    // (the Phase 2.5 manual `kubectl create secret` flow is retired). The agent
    // side stays a plain Secret mount, so this provider code is unchanged.
    // The volume is mounted regardless of whether OneCLI emitted `-v /tmp/...`
    // (we drop those above) so the agent always sees the certs at a stable path.
    volumes.push({
      name: ONECLI_CA_VOLUME_NAME,
      secret: { secretName: caSecretName },
    });
    volumeMounts.push({
      name: ONECLI_CA_VOLUME_NAME,
      mountPath: ONECLI_CA_MOUNT_PATH,
      readOnly: true,
    });

    if (spec.runAsUser) {
      env.push({ name: 'HOME', value: '/home/node' });
    }

    for (let i = 0; i < spec.onecliApplyArgs.length; i++) {
      const a = spec.onecliApplyArgs[i];
      if (a === '-e' && i + 1 < spec.onecliApplyArgs.length) {
        const kv = spec.onecliApplyArgs[++i];
        const eq = kv.indexOf('=');
        if (eq > 0) {
          env.push({ name: kv.substring(0, eq), value: kv.substring(eq + 1) });
        } else {
          // Malformed `-e` (no `=`, or `=` at index 0). OneCLI shouldn't emit
          // this, but dropping it silently would hide a future SDK format
          // change behind an agent that can't see its env. Surface it.
          log.warn('K8s: dropping malformed OneCLI -e arg (no "KEY=VALUE")', {
            arg: kv,
            agentGroup: spec.agentGroupName,
          });
        }
      } else if (a === '-v' && i + 1 < spec.onecliApplyArgs.length) {
        // `-v` from OneCLI's applyContainerConfig points at host-side
        // `/tmp/onecli-*.pem` paths that don't survive Warden. The Secret
        // mount above carries the same CA material in a Warden-compatible
        // way, so drop the OneCLI-supplied hostPath. Logged at debug so a
        // future OneCLI version that starts emitting non-CA `-v` args (e.g.
        // socket files, additional cert paths) is discoverable instead of
        // silently lost.
        const dropped = spec.onecliApplyArgs[++i];
        log.debug('K8s: dropping OneCLI -v hostPath mount (Warden deny; CA covered by Secret)', {
          dropped,
          agentGroup: spec.agentGroupName,
        });
        continue;
      } else if (a === '--add-host' && i + 1 < spec.onecliApplyArgs.length) {
        const mapping = spec.onecliApplyArgs[++i];
        const [hostname, ip] = mapping.split(':');
        if (hostname && ip) hostAliases.push({ ip, hostnames: [hostname] });
      }
    }

    this.rewriteOneCLIEnv(env, spec.agentGroupName);

    return { env, volumes, volumeMounts, hostAliases };
  }

  /**
   * Rewrite OneCLI's Docker-flavoured proxy + CA env values to K8s-native
   * equivalents. `applyContainerConfig` returns the same Docker host / path
   * regardless of runtime (the SDK has no K8s mode), so the provider must
   * translate after the fact. Override the in-cluster Service DNS via
   * `ONECLI_SERVICE_HOST` env if the namespace/name differs from default.
   */
  private rewriteOneCLIEnv(env: k8s.V1EnvVar[], agentGroupName: string): void {
    const serviceHost = process.env.ONECLI_SERVICE_HOST ?? DEFAULT_ONECLI_SERVICE_HOST;
    for (const e of env) {
      if (e.name === undefined || e.value === undefined) continue;

      if (ONECLI_PROXY_ENV_NAMES.has(e.name)) {
        if (!e.value.includes(ONECLI_DOCKER_HOST)) {
          // OneCLI changed its proxy host format (e.g. localhost / 127.0.0.1).
          // The value won't resolve inside a Pod, so surface it instead of
          // letting the agent fail later with timeouts.
          log.warn('K8s: proxy env value does not contain expected Docker host — not rewriting', {
            name: e.name,
            value: e.value,
            expected: ONECLI_DOCKER_HOST,
            agentGroup: agentGroupName,
          });
          continue;
        }
        e.value = e.value.split(ONECLI_DOCKER_HOST).join(serviceHost);
        continue;
      }

      // The `/tmp/` guard avoids clobbering a future K8s-native value (e.g.
      // a sidecar-managed colon-separated path that already includes the
      // system CA bundle).
      if (e.name === 'NODE_EXTRA_CA_CERTS' && e.value.includes('/tmp/')) {
        e.value = ONECLI_COMBINED_CA_PATH;
      }
    }
  }
}
