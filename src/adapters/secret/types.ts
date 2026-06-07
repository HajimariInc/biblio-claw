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
  CreateAgentInput,
  EnsureAgentResponse,
  ManualApprovalHandle,
} from '@onecli-sh/sdk';

/** Manual-approval callback — mirrors OneCLI's ManualApprovalCallback. */
export type ApprovalCallback = (request: ApprovalRequest) => Promise<'approve' | 'deny'>;

export interface SecretProvider {
  readonly name: string;

  /** Ensure the per-agent vault identity exists (idempotent). */
  ensureAgent(input: CreateAgentInput): Promise<EnsureAgentResponse>;

  /**
   * Inject the gateway proxy + CA into a container's docker `args`.
   *
   * ⚠ MUTATES the `args` array in place (appends `-e`/`-v` flags). Returns
   * false if the gateway couldn't be applied — the caller decides whether to
   * refuse the spawn (responsibility stays with container-runner).
   */
  applyContainerSecrets(args: string[], options?: ApplyContainerConfigOptions): Promise<boolean>;

  /** Register the manual-approval callback. Returns a handle to stop it. */
  configureManualApproval(callback: ApprovalCallback): ManualApprovalHandle;
}
