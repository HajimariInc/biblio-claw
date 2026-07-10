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
import { log } from '../../log.js';
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
    image: 'test-agent:latest',
    mounts: [],
    env: [{ name: 'TZ', value: 'UTC' }],
    onecliApplyArgs: [],
    command: ['-c', 'exec bun run /app/src/index.ts'],
    containerName: 'test-container-1',
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

  it('stays quiet when a stop fails with "No such container" (already gone)', async () => {
    execSyncMock
      .mockReturnValueOnce('orphan-a\n') // ps
      .mockImplementationOnce(() => {
        throw new Error('Error response from daemon: No such container: orphan-a');
      });
    const p = new DockerContainerRuntimeProvider();
    await p.cleanupOrphans();
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  it('warns (does not swallow) when a stop fails for another reason', async () => {
    execSyncMock
      .mockReturnValueOnce('orphan-a\n') // ps
      .mockImplementationOnce(() => {
        throw new Error('permission denied while talking to docker daemon');
      });
    const p = new DockerContainerRuntimeProvider();
    await p.cleanupOrphans();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'docker stop failed during orphan cleanup',
      expect.objectContaining({ containerName: 'orphan-a' }),
    );
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
      'test-container-1',
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
    expect(args).toContain('test-agent:latest');
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

  it('ignores VolumeMount.subPath on the Docker path and keeps the hostPath:containerPath bind mount', async () => {
    const p = new DockerContainerRuntimeProvider();
    await p.spawn(
      makeSpec({
        mounts: [
          {
            hostPath: '/data/groups/foo',
            // subPath is honoured only on K8s — Docker uses hostPath as-is.
            subPath: 'groups/foo',
            containerPath: '/workspace/agent',
            readonly: false,
          },
        ],
      }),
    );
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-v');
    expect(args).toContain('/data/groups/foo:/workspace/agent');
    expect(args.join(' ')).not.toContain('subPath');
    // The bind mount must come from the absolute hostPath, never a relative
    // subPath-only form like `groups/foo:/workspace/agent`.
    expect(args).not.toContain('groups/foo:/workspace/agent');
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

describe('DockerAgentHandle stderr capture on unexpected exit', () => {
  // silent fail 隠蔽解消 (= docker run の exit !=0 / signal 終了で
  // stderr buffer を warn として吐く設計) の回帰テスト。旧実装は child stderr を
  // log.debug にのみ流していたため LOG_LEVEL=info で完全に隠蔽されていた
  // (docker run exit 125 の "invalid characters for local volume name" 等)。
  it('exit !=0 かつ kill 経由でないとき、捕捉した stderr 付きで warn を吐く', async () => {
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = new DockerContainerRuntimeProvider();
    const handle = await p.spawn(makeSpec({ containerName: 'test-exit125' }));
    const promise = handle.waitForExit();

    child.stderr.emit('data', Buffer.from('docker: Error response from daemon: invalid volume name\n'));
    child.emit('close', 125);
    await promise;

    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'Container exited with non-zero code — captured stderr:',
      expect.objectContaining({
        containerName: 'test-exit125',
        exitCode: 125,
        stderr: expect.stringContaining('invalid volume name'),
      }),
    );
  });

  it('kill 経由の非ゼロ exit (= 通常運用の SIGKILL) では warn を吐かない', async () => {
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = new DockerContainerRuntimeProvider();
    const handle = await p.spawn(makeSpec({ containerName: 'test-killed' }));
    const exitPromise = handle.waitForExit();

    child.stderr.emit('data', Buffer.from('shutdown\n'));
    execSyncMock.mockReturnValueOnce(''); // docker stop success
    await handle.kill();
    child.emit('close', 137);
    await exitPromise;

    expect(vi.mocked(log.warn)).not.toHaveBeenCalledWith(
      'Container exited with non-zero code — captured stderr:',
      expect.anything(),
    );
    expect(vi.mocked(log.warn)).not.toHaveBeenCalledWith(
      'Container exited unexpectedly (no stderr captured)',
      expect.anything(),
    );
  });

  it('code === null (= signal 終了) かつ kill 経由でないとき、stderr 空でも warn を吐く', async () => {
    // 想定経路: OOM killer / GKE node eviction / 外部 SIGKILL 等。旧実装は
    // `code !== null` ガードでこの経路を黙っていた。
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = new DockerContainerRuntimeProvider();
    const handle = await p.spawn(makeSpec({ containerName: 'test-oom' }));
    const promise = handle.waitForExit();

    // stderr buffer 空のまま signal 終了 (code=null)
    child.emit('close', null);
    await promise;

    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'Container exited unexpectedly (no stderr captured)',
      expect.objectContaining({
        containerName: 'test-oom',
        exitCode: null,
      }),
    );
  });
});

describe('DockerAgentHandle.kill', () => {
  it('runs `docker stop` for the container name', async () => {
    const p = new DockerContainerRuntimeProvider();
    const handle = await p.spawn(makeSpec({ containerName: 'test-killable' }));
    execSyncMock.mockReturnValueOnce(''); // docker stop success
    await handle.kill();
    expect(execSyncMock).toHaveBeenCalledWith('docker stop -t 1 test-killable', expect.any(Object));
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
