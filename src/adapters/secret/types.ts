/**
 * SecretProvider contract.
 *
 * Isolates credential/secret concerns (currently the OneCLI gateway) behind an
 * interface so Phase 2 can swap in a GCP Secret Manager implementation without
 * touching container-runner or the approvals bridge. The signatures mirror the
 * exact OneCLI surface the app already uses, so the local implementation is a
 * thin pass-through (minimal-wrap, see plan §補足).
 */
import type {
  ApplyContainerConfigOptions,
  ApprovalRequest,
  ContainerConfig,
  CreateAgentInput,
  EnsureAgentResponse,
  ManualApprovalHandle,
} from '@onecli-sh/sdk';

export type { ContainerConfig } from '@onecli-sh/sdk';

/** Manual-approval callback — mirrors OneCLI's ManualApprovalCallback. */
export type ApprovalCallback = (request: ApprovalRequest) => Promise<'approve' | 'deny'>;

/**
 * SecretProvider contract.
 *
 * IMPORTANT: the process must hold a single instance. `container-runner` and
 * `onecli-approvals` share state through the same underlying OneCLI client and
 * must observe the same `configureManualApproval` handle. Use
 * `getSecretProvider()` (in `./index.ts`) rather than constructing implementations
 * directly — the factory memoizes the instance to enforce this. Bypassing the
 * factory leads to silently duplicated approval callbacks and lost vault state.
 */
export interface SecretProvider {
  readonly name: string;

  /** Ensure the per-agent vault identity exists (idempotent). */
  ensureAgent(input: CreateAgentInput): Promise<EnsureAgentResponse>;

  /**
   * Inject the gateway proxy + CA into a container's docker `args`.
   *
   * ⚠ MUTATES the `args` array in place — the OneCLI gateway appends the docker
   * flags it needs (proxy env vars + CA cert volume; exact flags are the SDK's
   * concern). Returns false if the gateway couldn't be applied — the caller
   * decides whether to refuse the spawn (responsibility stays with
   * container-runner).
   */
  applyContainerSecrets(args: string[], options?: ApplyContainerConfigOptions): Promise<boolean>;

  /** Register the manual-approval callback. Returns a handle to stop it. */
  configureManualApproval(callback: ApprovalCallback): ManualApprovalHandle;

  /**
   * Fetch the gateway proxy env + CA bundle for an agent identifier.
   *
   * Unlike `applyContainerSecrets` (which mutates Docker CLI args for a spawned
   * *container*), this returns the raw `{ env, caCertificate }` so the host's
   * OWN child processes (`git`/`gh` in `src/biblio/host-proxy.ts`) can be
   * routed through the gateway for credential injection. Wraps the SDK's
   * `getContainerConfig(agent)` (which `SecretProvider` previously didn't
   * expose).
   */
  getProxyConfig(agentId: string): Promise<ContainerConfig>;
}
