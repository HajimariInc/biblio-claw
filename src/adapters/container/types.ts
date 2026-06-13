/**
 * Container runtime provider contract.
 *
 * Abstracts *how* an agent container is launched so the host body can swap
 * Docker (local) and Kubernetes Job (GKE) by flipping `CONTAINER_PROVIDER` env.
 * Mirrors the DsnProvider / SecretProvider shape (factory + singleton + env
 * switch).
 *
 * Scope is launch + lifecycle (start / wait / kill / orphan cleanup). Mount /
 * env preparation stays in container-runner so both providers share the same
 * pre-spawn setup. The provider receives a fully-resolved AgentSpawnSpec and
 * translates it to its native form (CLI args for Docker, Job body for K8s).
 */
import type { VolumeMount } from '../../providers/provider-container-registry.js';

export type { VolumeMount };

/** Reason the container exited, surfaced via AgentHandle.waitForExit(). */
export type AgentExitReason = 'complete' | 'failed' | 'killed';

export interface AgentExitInfo {
  /** Native exit code (Docker) or Job condition (K8s). Null when not known. */
  code: number | null;
  reason: AgentExitReason;
}

/**
 * One agent container's launch spec. Built by container-runner once per
 * spawn; consumed by exactly one Provider.spawn() call.
 */
export interface AgentSpawnSpec {
  agentGroupId: string;
  agentGroupName: string;
  agentGroupFolder: string;
  sessionId: string;
  /** Container image tag (Docker) or fully-qualified ref (K8s). */
  image: string;
  /** Mounts in the order container-runner built them. */
  mounts: ReadonlyArray<VolumeMount>;
  /**
   * Container-side env vars built by container-runner (TZ + provider
   * contribution). OneCLI env lands in `onecliApplyArgs` instead — Provider
   * implementations parse that raw blob to keep this list runtime-agnostic.
   */
  env: ReadonlyArray<{ name: string; value: string }>;
  /**
   * Raw Docker CLI args that OneCLI's `applyContainerConfig` appended in-place.
   * Mix of `-e KEY=VAL`, `-v HOST:CONTAINER:ro`, and (when addHostMapping)
   * `--add-host`. DockerProvider concatenates them; K8sJobProvider parses them
   * into env[] / volumes[] / hostAliases[]. Empty array = OneCLI was skipped.
   */
  onecliApplyArgs: ReadonlyArray<string>;
  /** Entrypoint command (shell + script). */
  command: ReadonlyArray<string>;
  /**
   * Container name hint. Docker uses it as `--name`; K8sJobProvider ignores it
   * and uses `metadata.generateName` instead (K8s Jobs need unique suffixes to
   * avoid create/delete races).
   */
  containerName?: string;
  /**
   * Host UID to run as, when non-root / non-1000. Null = use image default.
   * Docker maps this to `--user`; K8s maps it to securityContext.runAsUser.
   */
  runAsUser: { uid: number; gid: number | undefined } | null;
  /** OneCLI agent identifier (= agentGroupId). For approval routing. */
  agentIdentifier: string;
}

/**
 * Handle returned by Provider.spawn(). One handle per running container; the
 * host tracks them in container-runner's activeContainers map.
 */
export interface AgentHandle {
  /** Native identifier — Docker container name, K8s Job name. */
  readonly id: string;
  /** Resolves when the container exits (any reason). Never rejects. */
  waitForExit(): Promise<AgentExitInfo>;
  /**
   * Stop the container. Idempotent. Docker = `docker stop` then SIGKILL on
   * failure; K8s = delete Job (background cascade).
   */
  kill(): Promise<void>;
}

export interface ContainerRuntimeProvider {
  readonly name: 'docker' | 'k8s';
  /** Pre-flight check (docker info / k8s API reach). Throws on failure. */
  ensureRuntime(): Promise<void>;
  /** Stop orphan containers from this install. Best-effort, never throws. */
  cleanupOrphans(): Promise<void>;
  /** Launch a new agent container. Returns once the runtime accepted the spawn. */
  spawn(spec: AgentSpawnSpec): Promise<AgentHandle>;
}
