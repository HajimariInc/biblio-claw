import { EventEmitter } from 'events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execSyncMock, spawnMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: execSyncMock,
  spawn: spawnMock,
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  CONTAINER_INSTALL_LABEL: 'nanoclaw-install=test-slug',
}));

import { DockerContainerRuntimeProvider } from './docker.js';
import type { AgentSpawnSpec } from './types.js';

function makeChild(): EventEmitter & { stderr: EventEmitter; stdout: EventEmitter; kill: (sig: string) => void } {
  const ee = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    stdout: EventEmitter;
    kill: (sig: string) => void;
  };
  ee.stderr = new EventEmitter();
  ee.stdout = new EventEmitter();
  ee.kill = vi.fn();
  return ee;
}

function makeSpec(overrides: Partial<AgentSpawnSpec> = {}): AgentSpawnSpec {
  return {
    agentGroupId: 'g1',
    agentGroupName: 'Test Group',
    agentGroupFolder: 'test-group',
    sessionId: 's1',
    image: 'nanoclaw-agent:latest',
    mounts: [],
    env: [{ name: 'TZ', value: 'UTC' }],
    onecliApplyArgs: [],
    command: ['-c', 'exec bun run /app/src/index.ts'],
    containerName: 'nanoclaw-test-1',
    runAsUser: null,
    agentIdentifier: 'g1',
    ...overrides,
  };
}

beforeEach(() => {
  execSyncMock.mockReset();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => makeChild());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('DockerContainerRuntimeProvider.ensureRuntime', () => {
  it('calls `docker info` and resolves when daemon is up', async () => {
    execSyncMock.mockReturnValueOnce('');
    const p = new DockerContainerRuntimeProvider();
    await expect(p.ensureRuntime()).resolves.toBeUndefined();
    expect(execSyncMock).toHaveBeenCalledWith(
      'docker info',
      expect.objectContaining({ stdio: 'pipe', timeout: 10_000 }),
    );
  });

  it('rejects when `docker info` throws', async () => {
    execSyncMock.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });
    const p = new DockerContainerRuntimeProvider();
    await expect(p.ensureRuntime()).rejects.toThrow(/Container runtime is required/);
  });
});

describe('DockerContainerRuntimeProvider.cleanupOrphans', () => {
  it('stops every container that carries our install label', async () => {
    execSyncMock
      .mockReturnValueOnce('orphan-a\norphan-b\n') // ps --filter label=...
      .mockReturnValueOnce('') // stop orphan-a
      .mockReturnValueOnce(''); // stop orphan-b
    const p = new DockerContainerRuntimeProvider();
    await p.cleanupOrphans();
    expect(execSyncMock).toHaveBeenCalledWith(
      "docker ps --filter label=nanoclaw-install=test-slug --format '{{.Names}}'",
      expect.any(Object),
    );
    expect(execSyncMock).toHaveBeenCalledWith('docker stop -t 1 orphan-a', expect.any(Object));
    expect(execSyncMock).toHaveBeenCalledWith('docker stop -t 1 orphan-b', expect.any(Object));
  });

  it('swallows ps failures (best-effort)', async () => {
    execSyncMock.mockImplementationOnce(() => {
      throw new Error('docker daemon gone');
    });
    const p = new DockerContainerRuntimeProvider();
    await expect(p.cleanupOrphans()).resolves.toBeUndefined();
  });
});

describe('DockerContainerRuntimeProvider.spawn', () => {
  it('passes the spec through to `docker run` with the expected flags', async () => {
    const p = new DockerContainerRuntimeProvider();
    const spec = makeSpec({
      env: [
        { name: 'TZ', value: 'Asia/Tokyo' },
        { name: 'NODE_ENV', value: 'test' },
      ],
      mounts: [
        { hostPath: '/tmp/sess', containerPath: '/workspace', readonly: false },
        { hostPath: '/etc/skill', containerPath: '/app/skills', readonly: true },
      ],
      onecliApplyArgs: ['-e', 'HTTPS_PROXY=http://onecli:10255', '-v', '/tmp/ca.pem:/tmp/ca.pem:ro'],
    });

    await p.spawn(spec);
    expect(spawnMock).toHaveBeenCalledOnce();
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('docker');
    expect(args.slice(0, 6)).toEqual([
      'run',
      '--rm',
      '--name',
      'nanoclaw-test-1',
      '--label',
      'nanoclaw-install=test-slug',
    ]);
    expect(args).toContain('-e');
    expect(args).toContain('TZ=Asia/Tokyo');
    expect(args).toContain('NODE_ENV=test');
    expect(args).toContain('HTTPS_PROXY=http://onecli:10255');
    expect(args).toContain('-v');
    expect(args).toContain('/tmp/sess:/workspace');
    expect(args).toContain('/etc/skill:/app/skills:ro');
    expect(args).toContain('/tmp/ca.pem:/tmp/ca.pem:ro');
    expect(args).toContain('--entrypoint');
    expect(args).toContain('bash');
    expect(args).toContain('nanoclaw-agent:latest');
    expect(args).toContain('-c');
    expect(args).toContain('exec bun run /app/src/index.ts');
  });

  it('adds --user when runAsUser is set', async () => {
    const p = new DockerContainerRuntimeProvider();
    await p.spawn(makeSpec({ runAsUser: { uid: 1234, gid: 1234 } }));
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('--user');
    expect(args).toContain('1234:1234');
    expect(args).toContain('HOME=/home/node');
  });

  it('skips --user when runAsUser is null', async () => {
    const p = new DockerContainerRuntimeProvider();
    await p.spawn(makeSpec({ runAsUser: null }));
    const [, args] = spawnMock.mock.calls[0];
    expect(args).not.toContain('--user');
  });
});

describe('DockerAgentHandle.waitForExit', () => {
  it('resolves with reason=complete on exit code 0', async () => {
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = new DockerContainerRuntimeProvider();
    const handle = await p.spawn(makeSpec());
    const promise = handle.waitForExit();
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ code: 0, reason: 'complete' });
  });

  it('resolves with reason=failed on non-zero exit', async () => {
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = new DockerContainerRuntimeProvider();
    const handle = await p.spawn(makeSpec());
    const promise = handle.waitForExit();
    child.emit('close', 137);
    await expect(promise).resolves.toEqual({ code: 137, reason: 'failed' });
  });
});

describe('DockerAgentHandle.kill', () => {
  it('runs `docker stop` for the container name', async () => {
    const p = new DockerContainerRuntimeProvider();
    const handle = await p.spawn(makeSpec({ containerName: 'nanoclaw-killable' }));
    execSyncMock.mockReturnValueOnce(''); // docker stop success
    await handle.kill();
    expect(execSyncMock).toHaveBeenCalledWith('docker stop -t 1 nanoclaw-killable', expect.any(Object));
  });

  it('falls back to SIGKILL when `docker stop` throws', async () => {
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = new DockerContainerRuntimeProvider();
    const handle = await p.spawn(makeSpec());
    execSyncMock.mockImplementationOnce(() => {
      throw new Error('container already gone');
    });
    await handle.kill();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('flips waitForExit reason to killed', async () => {
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = new DockerContainerRuntimeProvider();
    const handle = await p.spawn(makeSpec());
    const exitPromise = handle.waitForExit();
    execSyncMock.mockReturnValueOnce('');
    await handle.kill();
    child.emit('close', 137);
    await expect(exitPromise).resolves.toEqual({ code: 137, reason: 'killed' });
  });
});
