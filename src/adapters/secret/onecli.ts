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
    // SDK の戻り値は `{ name, identifier, created }` のみ (`id` / `secretMode` は載らない)。
    // `created` (= 新規 / 既存) は「新規作成 agent は OneCLI default で mode=selective」という
    // 文脈で mode=all 昇格漏れ検知の手掛かりになる。
    try {
      const result = await this.client.ensureAgent(input);
      log.info('onecli.ensure_agent', {
        event: 'onecli.ensure_agent',
        outcome: 'success',
        name: result.name,
        identifier: result.identifier,
        created: result.created,
      });
      return result;
    } catch (err) {
      // 失敗経路を成功経路と同 event 名 + outcome=failure で残す (= caller 側は throw を catch
      // するが、SDK の error 詳細を握り潰さないため本クラスでも記録)。
      log.error('onecli.ensure_agent failed', {
        event: 'onecli.ensure_agent',
        outcome: 'failure',
        name: input.name,
        identifier: input.identifier,
        err,
      });
      throw err;
    }
  }

  async applyContainerSecrets(args: string[], options?: ApplyContainerConfigOptions): Promise<boolean> {
    try {
      const result = await this.client.applyContainerConfig(args, options);
      log.info('onecli.apply_secrets', {
        event: 'onecli.apply_secrets',
        outcome: result ? 'success' : 'failure',
        applied: result,
      });
      return result;
    } catch (err) {
      log.error('onecli.apply_secrets failed', {
        event: 'onecli.apply_secrets',
        outcome: 'failure',
        err,
      });
      throw err;
    }
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
