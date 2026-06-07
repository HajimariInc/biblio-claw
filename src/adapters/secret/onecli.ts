import { OneCLI } from '@onecli-sh/sdk';
import type {
  ApplyContainerConfigOptions,
  CreateAgentInput,
  EnsureAgentResponse,
  ManualApprovalHandle,
} from '@onecli-sh/sdk';

import { ONECLI_API_KEY, ONECLI_URL } from '../../config.js';
import type { ApprovalCallback, SecretProvider } from './types.js';

/**
 * OneCLI-backed SecretProvider. Holds the single OneCLI client (previously
 * new'd separately in container-runner and onecli-approvals) and delegates the
 * three host-side credential operations to it.
 */
export class OneCLISecretProvider implements SecretProvider {
  readonly name = 'onecli';
  private readonly client = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

  ensureAgent(input: CreateAgentInput): Promise<EnsureAgentResponse> {
    return this.client.ensureAgent(input);
  }

  applyContainerSecrets(args: string[], options?: ApplyContainerConfigOptions): Promise<boolean> {
    return this.client.applyContainerConfig(args, options);
  }

  configureManualApproval(callback: ApprovalCallback): ManualApprovalHandle {
    return this.client.configureManualApproval(callback);
  }
}
