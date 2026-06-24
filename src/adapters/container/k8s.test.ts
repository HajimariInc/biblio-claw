import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { batchApi, informer, kubeConfigCtor, makeInformerFn, infoCalls, warnCalls } = vi.hoisted(() => {
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
    warnCalls: [] as unknown[],
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
    warn: (...args: unknown[]) => warnCalls.push(args),
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
      {
        hostPath: '/data/v2-sessions/group-1/session-1',
        subPath: 'v2-sessions/group-1/session-1',
        containerPath: '/workspace',
        readonly: false,
      },
      // image-layer mount carries no subPath — K8s path must skip it because
      // the agent image already ships `/app/skills` at the same path.
      { hostPath: '/app/skills', containerPath: '/app/skills', readonly: true },
    ],
    env: [
      { name: 'TZ', value: 'Asia/Tokyo' },
      { name: 'NODE_ENV', value: 'production' },
    ],
    // OneCLI SDK always returns Docker-flavoured values from
    // applyContainerConfig (host.docker.internal + /tmp host-side CA path).
    // translateSpec post-processes them into K8s equivalents; tests below
    // assert the rewritten form.
    onecliApplyArgs: [
      '-e',
      'HTTPS_PROXY=http://x:aoc_token@host.docker.internal:10255',
      '-e',
      'HTTP_PROXY=http://x:aoc_token@host.docker.internal:10255',
      '-e',
      'https_proxy=http://x:aoc_token@host.docker.internal:10255',
      '-e',
      'http_proxy=http://x:aoc_token@host.docker.internal:10255',
      '-e',
      'NODE_EXTRA_CA_CERTS=/tmp/onecli-gateway-ca.pem',
      '-e',
      'SSL_CERT_FILE=/tmp/onecli-combined-ca.pem',
      '-v',
      '/tmp/onecli-proxy-ca.pem:/tmp/onecli-proxy-ca.pem:ro',
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
  warnCalls.length = 0;
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

  it('sets pod-level fsGroup=1000 so the shared PVC subPath is owned by the agent user', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(makeSpec());
    const podSpec = batchApi.createNamespacedJob.mock.calls[0][0].body.spec.template.spec;
    expect(podSpec.securityContext).toEqual({ fsGroup: 1000 });
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
  it('maps subPath mounts onto a single shared PVC volume; skips subPath-less (image-layer) mounts', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(makeSpec());
    const podSpec = batchApi.createNamespacedJob.mock.calls[0][0].body.spec.template.spec;
    const sharedVol = podSpec.volumes.find((v: { name: string }) => v.name === 'vol-shared');
    expect(sharedVol).toBeDefined();
    expect(sharedVol.persistentVolumeClaim).toEqual({ claimName: 'data-biblio-orchestrator-0' });
    // Exactly one entry per subPath mount in the spec — `/workspace` should
    // land via `vol-shared` + the relative subPath.
    const workspace = podSpec.containers[0].volumeMounts.filter(
      (m: { mountPath: string }) => m.mountPath === '/workspace',
    );
    expect(workspace).toEqual([
      {
        name: 'vol-shared',
        mountPath: '/workspace',
        subPath: 'v2-sessions/group-1/session-1',
        readOnly: false,
      },
    ]);
    // image-layer mount carried no subPath, so it must NOT be projected onto the PVC.
    const skills = podSpec.containers[0].volumeMounts.find((m: { mountPath: string }) => m.mountPath === '/app/skills');
    expect(skills).toBeUndefined();
  });

  it('mounts the OneCLI CA Secret at /etc/ssl/certs/onecli regardless of OneCLI -v args', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(makeSpec());
    const podSpec = batchApi.createNamespacedJob.mock.calls[0][0].body.spec.template.spec;
    const caVol = podSpec.volumes.find((v: { name: string }) => v.name === 'onecli-ca');
    expect(caVol).toBeDefined();
    expect(caVol.secret).toEqual({ secretName: 'biblio-onecli-ca' });
    const caMount = podSpec.containers[0].volumeMounts.find(
      (m: { mountPath: string }) => m.mountPath === '/etc/ssl/certs/onecli',
    );
    expect(caMount).toEqual({
      name: 'onecli-ca',
      mountPath: '/etc/ssl/certs/onecli',
      readOnly: true,
    });
  });

  it('drops OneCLI `-v HOST:CONT:ro` host-path mounts (Warden denies them; CA Secret covers the same need)', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(makeSpec());
    const podSpec = batchApi.createNamespacedJob.mock.calls[0][0].body.spec.template.spec;
    // The two `-v` entries in makeSpec must NOT surface as additional mounts.
    const onecliPem = podSpec.containers[0].volumeMounts.find(
      (m: { mountPath: string }) => m.mountPath === '/etc/ssl/onecli.pem',
    );
    expect(onecliPem).toBeUndefined();
    const combined = podSpec.containers[0].volumeMounts.find(
      (m: { mountPath: string }) => m.mountPath === '/tmp/onecli-combined-ca.pem',
    );
    expect(combined).toBeUndefined();
    // And no hostPath volumes at all — Warden's `autogke-no-write-mode-hostpath`
    // constraint blocks any of them on Autopilot.
    const hostPathVols = podSpec.volumes.filter((v: { hostPath?: unknown }) => v.hostPath !== undefined);
    expect(hostPathVols).toEqual([]);
  });

  it('parses OneCLI `-e KEY=VAL` into the env list (proxy host rewritten for K8s)', async () => {
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
    // OneCLI hands us `host.docker.internal` (Docker-only DNS); the K8s
    // post-process points it at the in-cluster Service DNS.
    expect(proxy.value).toBe('http://x:aoc_token@biblio-onecli.biblio-claw.svc.cluster.local:10255');
  });

  it('rewrites OneCLI Docker-flavoured HTTP(S)_PROXY + NODE_EXTRA_CA_CERTS to K8s equivalents', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(makeSpec());
    const env = batchApi.createNamespacedJob.mock.calls[0][0].body.spec.template.spec.containers[0].env;
    const serviceHost = 'biblio-onecli.biblio-claw.svc.cluster.local';
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
      const e = env.find((x: { name: string }) => x.name === name);
      expect(e, `${name} should be present`).toBeDefined();
      expect(e.value, `${name} should target the in-cluster Service DNS`).toContain(serviceHost);
      expect(e.value, `${name} must not keep host.docker.internal`).not.toContain('host.docker.internal');
    }
    const ca = env.find((x: { name: string }) => x.name === 'NODE_EXTRA_CA_CERTS');
    expect(ca.value).toBe('/etc/ssl/certs/onecli/onecli-combined-ca.pem');
    // SSL_CERT_FILE は Go バイナリ (gh CLI 等) が trust bundle を解決するための env。
    // /tmp/ hostPath は Warden が drop するため、Secret mount 済みの K8s path に
    // rewrite されないと agent Pod 内 gh CLI の TLS 検証が失敗する。
    const sslCertFile = env.find((x: { name: string }) => x.name === 'SSL_CERT_FILE');
    expect(sslCertFile.value).toBe('/etc/ssl/certs/onecli/onecli-combined-ca.pem');
  });

  it('honours ONECLI_SERVICE_HOST env to override the in-cluster Service DNS for proxy URLs', async () => {
    vi.stubEnv('ONECLI_SERVICE_HOST', 'biblio-onecli.alt-ns.svc.cluster.local');
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(makeSpec());
    const env = batchApi.createNamespacedJob.mock.calls[0][0].body.spec.template.spec.containers[0].env;
    const proxy = env.find((e: { name: string }) => e.name === 'HTTPS_PROXY');
    expect(proxy.value).toBe('http://x:aoc_token@biblio-onecli.alt-ns.svc.cluster.local:10255');
  });

  it('honours AGENT_PVC_NAME env to override the shared PVC claim name', async () => {
    vi.stubEnv('AGENT_PVC_NAME', 'alternate-pvc');
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(makeSpec());
    const podSpec = batchApi.createNamespacedJob.mock.calls[0][0].body.spec.template.spec;
    const sharedVol = podSpec.volumes.find((v: { name: string }) => v.name === 'vol-shared');
    expect(sharedVol.persistentVolumeClaim).toEqual({ claimName: 'alternate-pvc' });
  });

  it('honours ONECLI_CA_SECRET_NAME env to override the CA bundle Secret name', async () => {
    vi.stubEnv('ONECLI_CA_SECRET_NAME', 'alt-ca-secret');
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(makeSpec());
    const podSpec = batchApi.createNamespacedJob.mock.calls[0][0].body.spec.template.spec;
    const caVol = podSpec.volumes.find((v: { name: string }) => v.name === 'onecli-ca');
    expect(caVol.secret).toEqual({ secretName: 'alt-ca-secret' });
  });

  it('skips mounts that carry no subPath when running on K8s', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(
      makeSpec({
        mounts: [
          // No subPath — agent image already ships this path, K8s must skip it.
          { hostPath: '/app/src', containerPath: '/app/src', readonly: true },
          {
            hostPath: '/data/groups/foo',
            subPath: 'groups/foo',
            containerPath: '/workspace/agent',
            readonly: false,
          },
        ],
      }),
    );
    const podSpec = batchApi.createNamespacedJob.mock.calls[0][0].body.spec.template.spec;
    const sharedMounts = podSpec.containers[0].volumeMounts.filter((m: { name: string }) => m.name === 'vol-shared');
    expect(sharedMounts).toHaveLength(1);
    expect(sharedMounts[0].mountPath).toBe('/workspace/agent');
    expect(sharedMounts[0].subPath).toBe('groups/foo');
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

  it('injects HOME=/home/node when runAsUser is set (parity with the Docker path)', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(makeSpec({ runAsUser: { uid: 1000, gid: 1000 } }));
    const env = batchApi.createNamespacedJob.mock.calls[0][0].body.spec.template.spec.containers[0].env;
    expect(env.find((e: { name: string }) => e.name === 'HOME')?.value).toBe('/home/node');
  });

  it('warns and keeps the value when a proxy env does not carry the Docker host (SDK format drift)', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(makeSpec({ onecliApplyArgs: ['-e', 'HTTPS_PROXY=http://x:tok@localhost:10255'] }));
    const env = batchApi.createNamespacedJob.mock.calls[0][0].body.spec.template.spec.containers[0].env;
    const proxy = env.find((e: { name: string }) => e.name === 'HTTPS_PROXY');
    // Not rewritten — surfaced instead of silently producing an unreachable URL.
    expect(proxy.value).toBe('http://x:tok@localhost:10255');
    expect(warnCalls.some((c) => String((c as unknown[])[0]).includes('proxy env value'))).toBe(true);
  });

  it('warns and drops a malformed OneCLI `-e` arg (no KEY=VALUE) instead of swallowing it', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: { name: 'biblio-agent-abc' } });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.spawn(makeSpec({ onecliApplyArgs: ['-e', 'JUST_A_FLAG'] }));
    const env = batchApi.createNamespacedJob.mock.calls[0][0].body.spec.template.spec.containers[0].env;
    expect(env.find((e: { name: string }) => e.name === 'JUST_A_FLAG')).toBeUndefined();
    expect(warnCalls.some((c) => String((c as unknown[])[0]).includes('malformed OneCLI -e'))).toBe(true);
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

  it('throws when createNamespacedJob returns a body without metadata.name', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] });
    batchApi.createNamespacedJob.mockResolvedValueOnce({ metadata: {} });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await expect(p.spawn(makeSpec())).rejects.toThrow(/missing metadata\.name/);
  });
});

describe('K8sJobContainerRuntimeProvider.cleanupOrphans', () => {
  it('deletes done (Complete/Failed) Jobs and leaves running ones', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] }); // ensureRuntime probe
    batchApi.listNamespacedJob.mockResolvedValueOnce({
      items: [
        { metadata: { name: 'done-job' }, status: { conditions: [{ type: 'Complete', status: 'True' }] } },
        { metadata: { name: 'running-job' }, status: { conditions: [] } },
      ],
    });
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await p.cleanupOrphans();
    expect(batchApi.deleteNamespacedJob).toHaveBeenCalledTimes(1);
    expect(batchApi.deleteNamespacedJob.mock.calls[0][0].name).toBe('done-job');
  });

  it('swallows a listNamespacedJob failure (best-effort, never throws)', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] }); // ensureRuntime probe
    batchApi.listNamespacedJob.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await expect(p.cleanupOrphans()).resolves.toBeUndefined();
    expect(warnCalls.some((c) => String((c as unknown[])[0]).includes('orphan cleanup'))).toBe(true);
  });

  it('warns but keeps going when an individual Job delete fails', async () => {
    batchApi.listNamespacedJob.mockResolvedValueOnce({ items: [] }); // ensureRuntime probe
    batchApi.listNamespacedJob.mockResolvedValueOnce({
      items: [{ metadata: { name: 'done-job' }, status: { conditions: [{ type: 'Failed', status: 'True' }] } }],
    });
    batchApi.deleteNamespacedJob.mockRejectedValueOnce(new Error('404 already gone'));
    const p = new K8sJobContainerRuntimeProvider();
    await p.ensureRuntime();
    await expect(p.cleanupOrphans()).resolves.toBeUndefined();
    expect(warnCalls.some((c) => String((c as unknown[])[0]).includes('Job delete failed'))).toBe(true);
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

  it('CONTAINER_PROVIDER unset defaults to the Docker provider', async () => {
    vi.stubEnv('CONTAINER_PROVIDER', '');
    const { _resetContainerRuntimeProviderForTesting, getContainerRuntimeProvider } = await import('./index.js');
    _resetContainerRuntimeProviderForTesting();
    const p = getContainerRuntimeProvider();
    expect(p.name).toBe('docker');
    _resetContainerRuntimeProviderForTesting();
  });

  it('CONTAINER_PROVIDER with an unknown value throws (parity with DSN/Scheduler factories)', async () => {
    vi.stubEnv('CONTAINER_PROVIDER', 'k8s-job');
    const { _resetContainerRuntimeProviderForTesting, getContainerRuntimeProvider } = await import('./index.js');
    _resetContainerRuntimeProviderForTesting();
    expect(() => getContainerRuntimeProvider()).toThrow(/Unknown CONTAINER_PROVIDER: k8s-job/);
    _resetContainerRuntimeProviderForTesting();
  });
});
