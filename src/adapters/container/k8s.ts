/**
 * K8sJobContainerRuntimeProvider — runs each agent as a K8s Batch v1 Job.
 *
 * Selected on GKE via `CONTAINER_PROVIDER=k8s`. Reads its config from env
 * (BIBLIO_NAMESPACE, BIBLIO_AGENT_IMAGE, HOSTNAME) and the in-cluster KSA
 * token (loadFromCluster).
 *
 * Spawn flow:
 *   1. Build a V1Job body — generateName, labels for NetworkPolicy match
 *      (`app.kubernetes.io/component=agent`), podAffinity to the orchestrator
 *      pod (RWO PVC needs them on the same node), securityContext lockdown.
 *   2. Translate the AgentSpawnSpec — env stays as env, mounts under `/data`
 *      become hostPath volumes (same-node guarantee → same backing PVC),
 *      OneCLI raw args parse out into env / hostPath volumes / hostAliases.
 *   3. createNamespacedJob, register a deferred in `pending[jobName]`.
 *   4. Informer (one per provider instance, namespace-scoped, label-filtered)
 *      watches Job conditions; on Complete/Failed it resolves the deferred.
 *
 * Mounts under non-/data paths are *intentionally skipped* — they refer to
 * orchestrator image-layer files (e.g. `/app/src`, `/app/skills`) that aren't
 * reachable from another pod via hostPath. The agent image already ships the
 * same files at the same paths, so the agent finds them natively. Group dirs
 * (`<cwd>/groups/<folder>`) are also skipped today since M2 Phase 1 verifies
 * spawn against a test fixture, not a real agent group; dynamic-group support
 * is Phase 2+ scope and will move groups under DATA_DIR or to a Volume.
 */
import * as k8s from '@kubernetes/client-node';

import { log } from '../../log.js';
import type { AgentExitInfo, AgentHandle, AgentSpawnSpec, ContainerRuntimeProvider, VolumeMount } from './types.js';

const DEFAULT_NAMESPACE = 'biblio-claw';
const DEFAULT_AGENT_IMAGE = 'nanoclaw-agent:latest';
const DEFAULT_ORCHESTRATOR_POD = 'biblio-orchestrator-0';
const INFORMER_RECONNECT_MS = 5_000;

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
  private readonly agentImage = process.env.BIBLIO_AGENT_IMAGE || DEFAULT_AGENT_IMAGE;
  private readonly orchestratorPodName = process.env.HOSTNAME || DEFAULT_ORCHESTRATOR_POD;
  private readonly pending = new Map<string, Pending>();
  private informerStopping = false;

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
      agentImage: this.agentImage,
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
          await this.batchApi
            .deleteNamespacedJob({
              name: job.metadata.name,
              namespace: this.namespace,
              propagationPolicy: 'Background',
            })
            .catch(() => undefined);
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
    informer.on('error', async (err) => {
      if (this.informerStopping) return;
      log.warn('K8s informer error, restarting', { err });
      try {
        await informer.stop();
      } catch {
        /* ignore */
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

    let volIdx = 0;
    const addHostPathMount = (m: VolumeMount, type?: string): void => {
      const name = `vol-${volIdx++}`;
      volumes.push({ name, hostPath: { path: m.hostPath, ...(type ? { type } : {}) } });
      volumeMounts.push({ name, mountPath: m.containerPath, readOnly: m.readonly });
    };

    for (const m of spec.mounts) {
      if (!m.hostPath.startsWith('/data/') && m.hostPath !== '/data') continue;
      addHostPathMount(m, 'Directory');
    }

    if (spec.runAsUser) {
      env.push({ name: 'HOME', value: '/home/node' });
    }

    for (let i = 0; i < spec.onecliApplyArgs.length; i++) {
      const a = spec.onecliApplyArgs[i];
      if (a === '-e' && i + 1 < spec.onecliApplyArgs.length) {
        const kv = spec.onecliApplyArgs[++i];
        const eq = kv.indexOf('=');
        if (eq > 0) env.push({ name: kv.substring(0, eq), value: kv.substring(eq + 1) });
      } else if (a === '-v' && i + 1 < spec.onecliApplyArgs.length) {
        const v = spec.onecliApplyArgs[++i];
        const parts = v.split(':');
        const readOnly = parts.length >= 3 && parts[parts.length - 1] === 'ro';
        const hostPath = parts[0];
        const containerPath = parts[1];
        if (!hostPath || !containerPath) continue;
        const isFile = /\.(pem|crt|json|conf|cert)$/.test(hostPath);
        const name = `vol-${volIdx++}`;
        volumes.push({
          name,
          hostPath: { path: hostPath, type: isFile ? 'File' : 'Directory' },
        });
        volumeMounts.push({ name, mountPath: containerPath, readOnly });
      } else if (a === '--add-host' && i + 1 < spec.onecliApplyArgs.length) {
        const mapping = spec.onecliApplyArgs[++i];
        const [hostname, ip] = mapping.split(':');
        if (hostname && ip) hostAliases.push({ ip, hostnames: [hostname] });
      }
    }

    return { env, volumes, volumeMounts, hostAliases };
  }
}
