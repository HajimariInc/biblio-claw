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
    let result: EnsureAgentResponse;
    try {
      result = await this.client.ensureAgent(input);
      log.info('onecli.ensure_agent', {
        event: 'onecli.ensure_agent',
        outcome: 'success',
        name: result.name,
        identifier: result.identifier,
        created: result.created,
      });
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

    // OneCLI default の `selective` mode のままだと vault にある secret が injection
    // されず 401 retry-loop に入る (= biblio-shelf gh API 呼出が全て失敗)。rotator
    // (`gh-rotate.sh` 50min 周期) が safety net として後追いで昇格するが、最初の
    // `@bot 仕入れて` で 401 を返すまで待つことになる。ensureAgent と同 transaction で
    // PATCH しておくことで順序保証完璧。失敗は WARN で握る (= rotator が拾う)。
    await this.promoteAgentToModeAll(result.identifier);
    return result;
  }

  /**
   * OneCLI agent の `secretMode` を `all` に PATCH する best-effort 経路。
   *
   * SDK 戻り値に `id` が含まれないため `GET /v1/agents` で identifier lookup → PATCH の
   * 2 段構え。失敗は WARN で握って throw しない (= caller の ensureAgent は成功扱いで継続、
   * `gh-rotate.sh` の 50min 周期 rotator が後追いで再昇格する safety net がある)。
   */
  private async promoteAgentToModeAll(identifier: string): Promise<void> {
    const event = 'onecli.promote_mode_all';
    const authHeader: Record<string, string> = ONECLI_API_KEY ? { Authorization: `Bearer ${ONECLI_API_KEY}` } : {};
    try {
      const listRes = await fetch(`${ONECLI_URL}/v1/agents`, { headers: authHeader });
      if (!listRes.ok) {
        log.warn('onecli.promote_mode_all: GET /v1/agents failed', {
          event,
          outcome: 'failure',
          identifier,
          status: listRes.status,
        });
        return;
      }
      const agents = (await listRes.json()) as Array<{ id?: string; identifier?: string }>;
      const target = Array.isArray(agents) ? agents.find((a) => a.identifier === identifier) : undefined;
      if (!target?.id) {
        log.warn('onecli.promote_mode_all: agent not found after ensure', {
          event,
          outcome: 'failure',
          identifier,
        });
        return;
      }
      const patchRes = await fetch(`${ONECLI_URL}/v1/agents/${target.id}/secret-mode`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ mode: 'all' }),
      });
      if (!patchRes.ok) {
        log.warn('onecli.promote_mode_all: PATCH secret-mode failed', {
          event,
          outcome: 'failure',
          identifier,
          id: target.id,
          status: patchRes.status,
        });
        return;
      }
      log.info('onecli.promote_mode_all', {
        event,
        outcome: 'success',
        identifier,
        id: target.id,
      });
      // eslint-disable-next-line no-catch-all/no-catch-all -- 設計上 best-effort: rotator (gh-rotate.sh) が safety net として全 agent を再昇格する
    } catch (err) {
      log.warn('onecli.promote_mode_all: unexpected error', {
        event,
        outcome: 'failure',
        identifier,
        err,
      });
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
