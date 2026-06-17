/**
 * Container runtime provider factory. Selected by `CONTAINER_PROVIDER` env
 * var (default `docker`). Memoized — the host resolves a single provider
 * for the process. Mirrors the DSN / Secret factories.
 */
import { DockerContainerRuntimeProvider } from './docker.js';
import { K8sJobContainerRuntimeProvider } from './k8s.js';
import type { ContainerProviderName, ContainerRuntimeProvider } from './types.js';

export type {
  AgentExitInfo,
  AgentExitReason,
  AgentHandle,
  AgentSpawnSpec,
  ContainerProviderName,
  ContainerRuntimeProvider,
  VolumeMount,
} from './types.js';

let instance: ContainerRuntimeProvider | null = null;

const PROVIDER_FACTORIES: Record<ContainerProviderName, () => ContainerRuntimeProvider> = {
  docker: () => new DockerContainerRuntimeProvider(),
  k8s: () => new K8sJobContainerRuntimeProvider(),
};

export function getContainerRuntimeProvider(): ContainerRuntimeProvider {
  if (instance) return instance;
  const name = process.env.CONTAINER_PROVIDER || 'docker';
  const factory = PROVIDER_FACTORIES[name as ContainerProviderName];
  if (!factory) {
    throw new Error(`Unknown CONTAINER_PROVIDER: ${name}. Known: ${Object.keys(PROVIDER_FACTORIES).join(', ')}`);
  }
  instance = factory();
  return instance;
}

export function _resetContainerRuntimeProviderForTesting(): void {
  instance = null;
}
