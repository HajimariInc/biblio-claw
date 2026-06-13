import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { batchApi, informer, kubeConfigCtor, makeInformerFn, infoCalls } = vi.hoisted(() => {
  const informer = {
    on: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  const batchApi = {
    listNamespacedJob: vi.fn().mockResolvedValue({ items: [] }),
    createNamespacedJob: vi.fn(),
    deleteNamespacedJob: vi.fn().mockResolvedValue({}),
  };
  // Use `function(this)` so `new kubeConfigCtor()` populates the instance —
  // arrow `mockImplementation(() => obj)` doesn't work as a constructor.
  const kubeConfigCtor = vi.fn(function (this: { loadFromCluster: () => void; makeApiClient: () => unknown }) {
    this.loadFromCluster = vi.fn();
    this.makeApiClient = vi.fn().mockReturnValue(batchApi);
  });
  return {
    batchApi,
    informer,
    kubeConfigCtor,
    makeInformerFn: vi.fn().mockReturnValue(informer),
    infoCalls: [] as unknown[],
  };
});

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: kubeConfigCtor,
  BatchV1Api: vi.fn(),
  makeInformer: makeInformerFn,
}));

vi.mock('../../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: (...args: unknown[]) => infoCalls.push(args),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { K8sJobContainerRuntimeProvider } from './k8s.js';
import type { AgentSpawnSpec } from './types.js';

function makeSpec(overrides: Partial<AgentSpawnSpec> = {}): AgentSpawnSpec {
  return {
    agentGroupId: 'group-1',
    agentGroupName: 'Test Group',
    agentGroupFolder: 'test-group',
    sessionId: 'session-1',
    image: 'asia-northeast1-docker.pkg.dev/proj/repo/nanoclaw-agent:m1-p1',
    mounts: [
      { hostPath: '/data/v2-sessions/group-1/session-1', containerPath: '/workspace', readonly: false },
      { hostPath: '/app/skills', containerPath: '/app/skills', readonly: true },
    ],
    env: [
      { name: 'TZ', value: 'Asia/Tokyo' },
      { name: 'NODE_ENV', value: 'production' },
    ],
    onecliApplyArgs: [
      '-e',
      'HTTPS_PROXY=http://biblio-onecli.biblio-claw.svc:10255',
      '-e',
      'NODE_EXTRA_CA_CERTS=/etc/ssl/onecli.pem',
      '-v',
      '/var/lib/onecli/ca.pem:/etc/ssl/onecli.pem:ro',
      '-v',
      '/tmp/onecli-combined-ca.pem:/tmp/onecli-combined-ca.pem:ro',
    ],
    command: ['-c', 'exec bun run /app/src/index.ts'],
    containerName: 'unused-on-k8s',
    runAsUser: null,
    agentIdentifier: 'group-1',
    ...overrides,
  };
}

beforeEach(() => {
  batchApi.listNamespacedJob.mockClear();
  batchApi.createNamespacedJob.mockReset();
  batchApi.deleteNamespacedJob.mockClear();
  informer.on.mockReset();
  informer.start.mockClear();
  makeInformerFn.mockClear();
  kubeConfigCtor.mockClear();
  infoCalls.length = 0;
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('K8sJobContainerRuntimeProvider.ensureRuntime', () => {
  it('loads in-cluster kubeconfig and starts a label-filtered informer', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    expect(kubeConfigCtor).toHaveBeenCalled();
    expect(batchApi.listNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'biblio-claw', limit: 1 }),
    );
    expect(makeInformerFn).toHaveBeenCalledWith(
      expect.anything(),
      '/apis/batch/v1/namespaces/biblio-claw/jobs',
      expect.any(Function),
      'app.kubernetes.io/component=agent',
    );
    expect(informer.start).toHaveBeenCalled();
  });

  it('throws when the K8s API is unreachable', async () => {
    batchApi.listNamespacedJob.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const p = new K8sJobContainerRuntimeProvider();
    await expect(p.ensureRuntime()).rejects.toThrow(/K8s API not reachable/);
  });

  it('honors BIBLIO_NAMESPACE env override', async () => {
    vi.stubEnv('BIBLIO_NAMESPACE', 'other-ns');
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    expect(batchApi.listNamespacedJob).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'other-ns' }));
  });
});

describe('K8sJobContainerRuntimeProvider.spawn — job body assembly', () => {
  it('builds a Job with the labels required by the agent egress NetworkPolicy', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-xyz' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(makeSpec());
    const body = batchApi.createNamespacedJob.mock.calls[0][0].body;
    expect(body.metadata.labels['app.kubernetes.io/name']).toBe('biblio-claw');
    expect(body.metadata.labels['app.kubernetes.io/component']).toBe('agent');
    expect(body.metadata.labels['biblio.agent-group-id']).toBe('group-1');
    expect(body.metadata.labels['biblio.session-id']).toBe('session-1');
    // Same labels MUST be on the Pod template for the NetworkPolicy to match.
    expect(body.spec.template.metadata.labels).toEqual(body.metadata.labels);
  });

  it('uses generateName so spawn() never races with delete-then-create', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(makeSpec());
    const body = batchApi.createNamespacedJob.mock.calls[0][0].body;
    expect(body.metadata.generateName).toBe('biblio-agent-');
    expect(body.metadata.name).toBeUndefined();
  });

  it('forces co-location with the orchestrator via podAffinity', async () => {
    vi.stubEnv('HOSTNAME', 'biblio-orchestrator-0');
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(makeSpec());
    const affinity = batchApi.createNamespacedJob.mock.calls[0][0].body.spec.template.spec.affinity;
    const term = affinity.podAffinity.requiredDuringSchedulingIgnoredDuringExecution[0];
    expect(term.topologyKey).toBe('kubernetes.io/hostname');
    expect(term.labelSelector.matchLabels['statefulset.kubernetes.io/pod-name']).toBe('biblio-orchestrator-0');
  });

  it('locks down the agent container (no priv-escalation, no capabilities, Never restart)', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(makeSpec());
    const podSpec = batchApi.createNamespacedJob.mock.calls[0][0].body.spec.template.spec;
    expect(podSpec.restartPolicy).toBe('Never');
    const sc = podSpec.containers[0].securityContext;
    expect(sc.allowPrivilegeEscalation).toBe(false);
    expect(sc.capabilities.drop).toEqual(['ALL']);
  });

  it('sets backoffLimit=0 (host re-spawns) and ttlSecondsAfterFinished=120 (debug grace)', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(makeSpec());
    const jobSpec = batchApi.createNamespacedJob.mock.calls[0][0].body.spec;
    expect(jobSpec.backoffLimit).toBe(0);
    expect(jobSpec.ttlSecondsAfterFinished).toBe(120);
  });
});

describe('K8sJobContainerRuntimeProvider.spawn — spec translation', () => {
  it('converts /data hostPath mounts into K8s volumes; skips non-/data mounts', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(makeSpec());
    const podSpec = batchApi.createNamespacedJob.mock.calls[0][0].body.spec.template.spec;
    const dataMounts = podSpec.containers[0].volumeMounts.filter(
      (m: { mountPath: string }) => m.mountPath === '/workspace',
    );
    expect(dataMounts).toHaveLength(1);
    // /app/skills mount is image-internal — must NOT appear as a hostPath mount.
    const skillsMount = podSpec.containers[0].volumeMounts.find(
      (m: { mountPath: string }) => m.mountPath === '/app/skills',
    );
    expect(skillsMount).toBeUndefined();
  });

  it('parses OneCLI `-e KEY=VAL` into the env list', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(makeSpec());
    const env = batchApi.createNamespacedJob.mock.calls[0][0].body.spec.template.spec.containers[0].env;
    const names = env.map((e: { name: string }) => e.name);
    expect(names).toContain('TZ');
    expect(names).toContain('HTTPS_PROXY');
    expect(names).toContain('NODE_EXTRA_CA_CERTS');
    const proxy = env.find((e: { name: string }) => e.name === 'HTTPS_PROXY');
    expect(proxy.value).toBe('http://biblio-onecli.biblio-claw.svc:10255');
  });

  it('parses OneCLI `-v HOST:CONT:ro` into hostPath volume + readOnly volumeMount', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(makeSpec());
    const podSpec = batchApi.createNamespacedJob.mock.calls[0][0].body.spec.template.spec;
    const caMount = podSpec.containers[0].volumeMounts.find(
      (m: { mountPath: string }) => m.mountPath === '/etc/ssl/onecli.pem',
    );
    expect(caMount).toBeDefined();
    expect(caMount.readOnly).toBe(true);
    const caVol = podSpec.volumes.find((v: { name: string }) => v.name === caMount.name);
    expect(caVol.hostPath.path).toBe('/var/lib/onecli/ca.pem');
    expect(caVol.hostPath.type).toBe('File');
  });

  it('runs the entry point as `bash -c <script>`', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(makeSpec());
    const c = batchApi.createNamespacedJob.mock.calls[0][0].body.spec.template.spec.containers[0];
    expect(c.command).toEqual(['bash']);
    expect(c.args).toEqual(['-c', 'exec bun run /app/src/index.ts']);
    expect(c.imagePullPolicy).toBe('Always');
  });
});

describe('K8sJobContainerRuntimeProvider Informer plumbing', () => {
  function captureCallbacks(): Record<string, (job: unknown) => void> {
    const map: Record<string, (job: unknown) => void> = {};
    for (const call of informer.on.mock.calls) {
      const [verb, cb] = call as [string, (job: unknown) => void];
      map[verb] = cb;
    }
    return map;
  }

  it('resolves waitForExit with reason=complete when Job condition Complete=True fires', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    const handle = await p.spawn(makeSpec());
    const cbs = captureCallbacks();
    const wait = handle.waitForExit();
    cbs.update({
      metadata: { name: 'biblio-agent-abc' },
      status: { conditions: [{ type: 'Complete', status: 'True' }], succeeded: 1 },
    });
    await expect(wait).resolves.toEqual({ code: 1, reason: 'complete' });
  });

  it('resolves waitForExit with reason=failed when Job condition Failed=True fires', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-fail' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    const handle = await p.spawn(makeSpec());
    const cbs = captureCallbacks();
    const wait = handle.waitForExit();
    cbs.update({
      metadata: { name: 'biblio-agent-fail' },
      status: { conditions: [{ type: 'Failed', status: 'True' }] },
    });
    await expect(wait).resolves.toMatchObject({ reason: 'failed' });
  });

  it('ignores updates for unknown job names (other namespaces / other handles)', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    const handle = await p.spawn(makeSpec());
    const cbs = captureCallbacks();
    let resolved = false;
    handle.waitForExit().then(() => {
      resolved = true;
    });
    cbs.update({
      metadata: { name: 'biblio-agent-OTHER' },
      status: { conditions: [{ type: 'Complete', status: 'True' }] },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);
  });

  it('resolves waitForExit on delete event when no Complete/Failed update arrived (background cascade race)', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-raced' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    const handle = await p.spawn(makeSpec());
    const cbs = captureCallbacks();
    const wait = handle.waitForExit();
    cbs.delete({ metadata: { name: 'biblio-agent-raced' }, status: {} });
    await expect(wait).resolves.toMatchObject({ reason: 'failed' });
  });

  it('resolves waitForExit with reason=killed when kill() preceded the delete event', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-killed' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    const handle = await p.spawn(makeSpec());
    const cbs = captureCallbacks();
    const wait = handle.waitForExit();
    await handle.kill();
    cbs.delete({ metadata: { name: 'biblio-agent-killed' }, status: {} });
    await expect(wait).resolves.toMatchObject({ reason: 'killed' });
  });

  it('on error: stops informer, schedules restart after RECONNECT_MS', async () => {
    vi.useFakeTimers();
    try {
      batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
      const p = new K8sJobContainerRuntimeProvider();
      await p.ensureRuntime();
      const cbs = captureCallbacks();
      informer.start.mockClear();
      informer.stop.mockClear();
      await cbs.error(new Error('410 Gone'));
      expect(informer.stop).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(informer.start).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('on error: when stop() itself throws, still schedules restart', async () => {
    vi.useFakeTimers();
    try {
      batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
      const p = new K8sJobContainerRuntimeProvider();
      await p.ensureRuntime();
      const cbs = captureCallbacks();
      informer.stop.mockRejectedValueOnce(new Error('stop blew up'));
      informer.start.mockClear();
      await cbs.error(new Error('connection reset'));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(informer.start).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('K8sJobContainerRuntimeProvider kill', () => {
  it('deletes the Job with background cascade', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-killme' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    const handle = await p.spawn(makeSpec());
    await handle.kill();
    expect(batchApi.deleteNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'biblio-agent-killme',
        namespace: 'biblio-claw',
        propagationPolicy: 'Background',
      }),
    );
  });
});

describe('K8sJobContainerRuntimeProvider spawn error path', () => {
  it('throws when createNamespacedJob fails (e.g. 403 Forbidden from missing RBAC)', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    const apiErr = Object.assign(new Error('Forbidden'), { statusCode: 403 });
    batchApi.createNamespacedJob.mockRejectedValueOnce(apiErr);
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await expect(p.spawn(makeSpec())).rejects.toThrow(/Forbidden/);
  });
});

describe('K8sJobContainerRuntimeProvider factory env', () => {
  it('CONTAINER_PROVIDER=k8s selects this provider', async () => {
    vi.stubEnv('CONTAINER_PROVIDER', 'k8s');
    const { _resetContainerRuntimeProviderForTesting, getContainerRuntimeProvider } = await import('./index.js');
    _resetContainerRuntimeProviderForTesting();
    const p = getContainerRuntimeProvider();
    expect(p.name).toBe('k8s');
    _resetContainerRuntimeProviderForTesting();
  });
});
