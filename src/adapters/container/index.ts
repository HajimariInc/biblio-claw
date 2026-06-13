/**
 * Container runtime provider factory. Selected by `CONTAINER_PROVIDER` env
 * var (default `docker`). Memoized — the host resolves a single provider
 * for the process. Mirrors the DSN / Secret factories.
 */
import { DockerContainerRuntimeProvider } from './docker.js';
import { K8sJobContainerRuntimeProvider } from './k8s.js';
import type { ContainerRuntimeProvider } from './types.js';

export type {
  AgentExitInfo,
  AgentExitReason,
  AgentHandle,
  AgentSpawnSpec,
  ContainerRuntimeProvider,
  VolumeMount,
} from './types.js';

let instance: ContainerRuntimeProvider | null = null;

export function getContainerRuntimeProvider(): ContainerRuntimeProvider {
  if (instance) return instance;
  const name = process.env.CONTAINER_PROVIDER || 'docker';
  switch (name) {
    case 'docker':
      instance = new DockerContainerRuntimeProvider();
      break;
    case 'k8s':
      instance = new K8sJobContainerRuntimeProvider();
      break;
    default:
      throw new Error(`Unknown CONTAINER_PROVIDER: ${name}. Known: docker, k8s`);
  }
  return instance;
}

export function _resetContainerRuntimeProviderForTesting(): void {
  instance = null;
}
