import { OneCLI } from '@onecli-sh/sdk';
import type {
  ApplyContainerConfigOptions,
  CreateAgentInput,
  EnsureAgentResponse,
  ManualApprovalHandle,
} from '@onecli-sh/sdk';

import { ONECLI_API_KEY, ONECLI_URL } from '../../config.js';
import { log } from '../../log.js';
import type { ApprovalCallback, ProxyConfig, SecretProvider } from './types.js';

/**
 * OneCLI-backed SecretProvider. Holds the single OneCLI client (previously
 * new'd separately in container-runner and onecli-approvals) and delegates the
 * three host-side credential operations to it.
 */
export class OneCLISecretProvider implements SecretProvider {
  readonly name = 'onecli';
  private readonly client = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

  async ensureAgent(input: CreateAgentInput): Promise<EnsureAgentResponse> {
    // SDK が agent 作成 / 取得を行う。成功時の `secretMode` は selective / all のどちらが
    // 紐付いているかを示す重要な状態 (= mode=all 昇格漏れの検知に使う)。
    const result = await this.client.ensureAgent(input);
    // SDK が返すのは `{ name, identifier, created }` のみ (agent id は非公開、secretMode も
    // SDK には載っていない)。それでも `created` (= 新規作成 / 既存) は「mode=all 昇格漏れ」
    // 検知の文脈で重要 (新規作成 agent は OneCLI default で mode=selective、明示昇格が必要)。
    log.info('onecli.ensure_agent', {
      event: 'onecli.ensure_agent',
      outcome: 'success',
      name: result.name,
      identifier: result.identifier,
      created: result.created,
    });
    return result;
  }

  async applyContainerSecrets(args: string[], options?: ApplyContainerConfigOptions): Promise<boolean> {
    const result = await this.client.applyContainerConfig(args, options);
    log.info('onecli.apply_secrets', {
      event: 'onecli.apply_secrets',
      outcome: result ? 'success' : 'failure',
      applied: result,
    });
    return result;
  }

  configureManualApproval(callback: ApprovalCallback): ManualApprovalHandle {
    return this.client.configureManualApproval(callback);
  }

  async getProxyConfig(agentId: string): Promise<ProxyConfig> {
    // SDK の ContainerConfig から host が使う 2 フィールドだけ取り出す (型漏出を防ぐ)。
    const cfg = await this.client.getContainerConfig(agentId);
    return { env: cfg.env, caCertificate: cfg.caCertificate };
  }
}
