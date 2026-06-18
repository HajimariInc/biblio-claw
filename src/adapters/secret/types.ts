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

/**
 * host プロセスが OneCLI proxy 経由で外部 HTTP を叩くために必要な設定。
 *
 * SDK の `ContainerConfig` (コンテナ向けの全設定) をそのまま露出させず、host が
 * 実際に使う `env` + `caCertificate` だけのドメイン型に絞る。これにより
 * `SecretProvider` の抽象バリアの外へ SDK 型が漏れず、Phase 2 で別実装
 * (GCP Secret Manager 等) に差し替えても呼び出し側 (`host-proxy.ts`) は無影響。
 */
export interface ProxyConfig {
  /** OneCLI gateway 由来の proxy env (`HTTPS_PROXY` 等)。 */
  env: Record<string, string>;
  /** proxy MITM の CA bundle (PEM)。未提供なら undefined。 */
  caCertificate?: string;
}

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
   * Fetch the gateway proxy env + CA bundle for an agent.
   *
   * Unlike `applyContainerSecrets` (which mutates Docker CLI args for a spawned
   * *container*), this returns a `ProxyConfig` so the host's OWN child processes
   * (`git`/`gh` in `src/biblio/host-proxy.ts`) can be routed through the gateway
   * for credential injection.
   *
   * `agentId` は `ensureAgent` に渡した `identifier` 値 (SDK の `getContainerConfig`
   * は引数名 `agent` だが identifier を受ける)。SDK 型ではなくドメイン型
   * `ProxyConfig` を返し、抽象バリア外への SDK 型漏出を避ける。
   */
  getProxyConfig(agentId: string): Promise<ProxyConfig>;
}
