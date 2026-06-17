/**
 * DockerContainerRuntimeProvider — wraps `docker` CLI for local dev.
 *
 * `docker info` pre-flight and the orphan sweep stay synchronous (`execSync`)
 * so the host startup sequence never `await`s on a daemon probe.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from '../../config.js';
import { log } from '../../log.js';
import type { AgentExitInfo, AgentHandle, AgentSpawnSpec, ContainerRuntimeProvider } from './types.js';

const CONTAINER_RUNTIME_BIN = 'docker';

/** Resolve `host.docker.internal` to the host gateway on Linux (no-op on macOS/Windows). */
function hostGatewayArgs(): string[] {
  return os.platform() === 'linux' ? ['--add-host=host.docker.internal:host-gateway'] : [];
}

function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

class DockerAgentHandle implements AgentHandle {
  readonly id: string;
  private readonly process: ChildProcess;
  private readonly exitPromise: Promise<AgentExitInfo>;
  private killed = false;

  constructor(containerName: string, child: ChildProcess) {
    this.id = containerName;
    this.process = child;
    this.exitPromise = new Promise<AgentExitInfo>((resolve) => {
      child.once('close', (code) => {
        const reason: AgentExitInfo['reason'] = this.killed ? 'killed' : code === 0 ? 'complete' : 'failed';
        resolve({ code, reason });
      });
      child.once('error', (err) => {
        log.error('Docker spawn error', { containerName, err });
        resolve({ code: null, reason: 'failed' });
      });
    });
  }

  waitForExit(): Promise<AgentExitInfo> {
    return this.exitPromise;
  }

  async kill(): Promise<void> {
    this.killed = true;
    try {
      stopContainer(this.id);
    } catch (err) {
      log.warn('docker stop failed, falling back to SIGKILL', {
        containerName: this.id,
        err,
      });
      const killed = this.process.kill('SIGKILL');
      if (!killed) {
        log.warn('SIGKILL failed (process likely already exited)', {
          containerName: this.id,
        });
      }
    }
  }
}

export class DockerContainerRuntimeProvider implements ContainerRuntimeProvider {
  readonly name = 'docker' as const;

  ensureRuntime(): Promise<void> {
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} info`, { stdio: 'pipe', timeout: 10_000 });
      log.debug('Container runtime already running');
    } catch (err) {
      log.error('Failed to reach container runtime', { err });
      console.error('\n╔════════════════════════════════════════════════════════════════╗');
      console.error('║  FATAL: Container runtime failed to start                      ║');
      console.error('║                                                                ║');
      console.error('║  Agents cannot run without a container runtime. To fix:        ║');
      console.error('║  1. Ensure Docker is installed and running                     ║');
      console.error('║  2. Run: docker info                                           ║');
      console.error('║  3. Restart NanoClaw                                           ║');
      console.error('╚════════════════════════════════════════════════════════════════╝\n');
      return Promise.reject(new Error('Container runtime is required but failed to start', { cause: err }));
    }
    return Promise.resolve();
  }

  cleanupOrphans(): Promise<void> {
    try {
      const output = execSync(
        `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
      );
      const orphans = output.trim().split('\n').filter(Boolean);
      for (const name of orphans) {
        try {
          stopContainer(name);
        } catch (err) {
          // "No such container" = already gone (GC'd / stopped) — expected,
          // skip quietly. Anything else (daemon perms, malformed name) gets a
          // warn so a partial cleanup isn't mistaken for a complete one.
          const msg = String((err as { stderr?: Buffer | string }).stderr ?? err);
          if (!msg.includes('No such container')) {
            log.warn('docker stop failed during orphan cleanup', { containerName: name, err });
          }
        }
      }
      if (orphans.length > 0) {
        log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
      }
    } catch (err) {
      log.warn('Failed to clean up orphaned containers', { err });
    }
    return Promise.resolve();
  }

  spawn(spec: AgentSpawnSpec): Promise<AgentHandle> {
    if (!spec.containerName) {
      throw new Error('DockerContainerRuntimeProvider requires spec.containerName (assign one in container-runner)');
    }
    const containerName = spec.containerName;
    const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

    for (const { name, value } of spec.env) {
      args.push('-e', `${name}=${value}`);
    }

    // OneCLI gateway flags (raw `-e` / `-v` / `--add-host` mix). Docker can
    // accept them as-is; K8sJobProvider has to parse the same blob.
    args.push(...spec.onecliApplyArgs);

    args.push(...hostGatewayArgs());

    if (spec.runAsUser) {
      args.push('--user', `${spec.runAsUser.uid}:${spec.runAsUser.gid ?? ''}`);
      args.push('-e', 'HOME=/home/node');
    }

    for (const mount of spec.mounts) {
      if (mount.readonly) {
        args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
      } else {
        args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
      }
    }

    args.push('--entrypoint', 'bash');
    args.push(spec.image);
    args.push(...spec.command);

    log.info('Docker spawn', {
      containerName,
      agentGroup: spec.agentGroupName,
      sessionId: spec.sessionId,
    });

    const child = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    child.stderr?.on('data', (data) => {
      for (const line of data.toString().trim().split('\n')) {
        if (line) log.debug(line, { container: spec.agentGroupFolder });
      }
    });
    child.stdout?.on('data', () => {});

    return Promise.resolve(new DockerAgentHandle(containerName, child));
  }
}
