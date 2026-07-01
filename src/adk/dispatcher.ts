/**
 * ADK Runner → channel adapter dispatcher (M4-B Phase 3).
 *
 * 本 module は `src/router.ts:deliverToAgent()` の `provider === 'adk'` 分岐から呼ばれ、
 * patron 命令 (CLI / Slack / 他 channel いずれか) を root `LlmAgent` に流し込み、
 * event stream の `isFinalResponse` を拾って channel adapter 経由で patron に返す。
 *
 * **channel adapter agnostic**: `channelType` を parameter で受け、`getChannelAdapter()` で
 * 動的に adapter を解決するだけ。CLI (`cli.ts`) でも Slack (`slack.ts`) でも同一 code path。
 *
 * **`runEphemeral` 採用理由** (Phase 3 MVP = 1 patron 命令 = 1 session):
 *   - `InMemoryRunner.runEphemeral({userId, newMessage})` は内部で `runAsync` に委譲し、
 *     都度 ephemeral session を作る (= session key 衝突懸念なし + code 単純)
 *   - Phase 3 verify-m4-b.sh には multi-turn 要件がない (= 1 命令完遂で足りる)
 *   - Phase 4 以降で multi-turn / 永続 SessionService に差替時は dispatcher 内で
 *     `runEphemeral` → `runAsync` の変更のみで済む (interface は factory で吸収)
 *
 * **module-level singleton runner の理由**:
 *   - `new LlmAgent(...)` は Vertex SDK 認証解決を伴う = 起動時 1 回に抑える
 *   - Pod 再起動で消えるが `runEphemeral` は session を都度使い捨てるため実害なし
 *   - test では `_resetSharedRunnerForTest()` を beforeEach で呼び、`vi.mock('./root-agent.js')`
 *     で mock runner に差替可能 (= test-helpers.ts pattern と一貫)
 */
import { isFinalResponse } from '@google/adk';
import type { InMemoryRunner } from '@google/adk';

import { getChannelAdapter } from '../channels/channel-registry.js';
import { log } from '../log.js';

import { buildRootAgent } from './root-agent.js';
import { buildRunner, BIBLIO_M4B_APP_NAME } from './runner.js';

/** module-scope singleton (Vertex SDK 認証解決を起動時 1 回に抑える)。 */
let sharedRunner: InMemoryRunner | undefined;

/**
 * ADK Runner の共有インスタンスを返す (初回呼出時に lazy 初期化)。
 *
 * lazy 初期化する理由: `buildRootAgent()` は `LLMRegistry` 解決経路で Vertex SDK 認証を
 * 触る (= ADC / proxy 初期化前に触ると壊れる)。`initHostProxy()` / `setupVertexProxy()` /
 * `registerAnthropicVertexLlm()` が完了した後 (= routeInbound 経由呼出時点) で走ることを
 * `src/index.ts` main() の順序が保証している。
 */
export function getSharedRunner(): InMemoryRunner {
  if (!sharedRunner) {
    const rootAgent = buildRootAgent();
    sharedRunner = buildRunner(rootAgent);
    log.info('ADK dispatcher: shared runner created', {
      event: 'adk.dispatcher.runner_created',
      app_name: BIBLIO_M4B_APP_NAME,
    });
  }
  return sharedRunner;
}

/**
 * test 用 backdoor: module state を reset する。production import path からは呼ばない。
 *
 * `vi.mock('./root-agent.js')` で mock runner に差し替えるとき、beforeEach で
 * `_resetSharedRunnerForTest()` を呼ばないと前 case の runner が引き継がれる。
 */
export function _resetSharedRunnerForTest(): void {
  sharedRunner = undefined;
}

/** dispatcher の入力パラメータ。router.ts:deliverToAgent が組み立てて渡す。 */
export interface DispatchToAdkParams {
  agentGroupId: string;
  messagingGroupId: string;
  /** 'cli' / 'slack' / etc. `getChannelAdapter(channelType)` で動的解決される。 */
  channelType: string;
  platformId: string;
  threadId: string | null;
  userId: string | null;
  /** patron 発話 (chat.content.text の抽出後)。空文字列は early return + warn。 */
  patronText: string;
  requestId: string;
}

/**
 * ADK Runner event stream を消費し、最終応答を channel adapter 経由で patron に返す。
 *
 * **contract**:
 *   - `throw` しない (= router.ts の catch に頼らない、silent failure を防ぐ)
 *   - LLM 呼出失敗 / ADK error event / event stream 例外はいずれも patron 向けの
 *     日本語 fallback text で `adapter.deliver` を呼ぶ
 *   - `adapter` 不在時は warn log のみ (= 応答経路がないなら他に選択肢がない)
 *   - 空 `patronText` は early return + warn (= 上流 sanity check の副次)
 *
 * event stream 消費 pattern は `scripts/verify-phase-1-adk-local.ts:98-138` から写経。
 */
export async function dispatchToAdk(params: DispatchToAdkParams): Promise<void> {
  const { channelType, platformId, threadId, patronText, requestId } = params;

  if (!patronText.trim()) {
    log.warn('ADK dispatcher: empty patronText, skipping', {
      event: 'adk.dispatcher.empty_input',
      request_id: requestId,
      channel_type: channelType,
    });
    return;
  }

  const runner = getSharedRunner();
  const userId = params.userId ?? params.platformId;

  log.info('ADK dispatcher: invoke', {
    event: 'adk.dispatcher.invoke',
    request_id: requestId,
    channel_type: channelType,
    agent_group_id: params.agentGroupId,
    user_id: userId,
    patron_text_length: patronText.length,
  });

  let finalText = '';
  let adkErrorCode: string | undefined;
  let adkErrorMessage: string | undefined;

  try {
    for await (const event of runner.runEphemeral({
      userId,
      newMessage: { role: 'user', parts: [{ text: patronText }] },
    })) {
      // ADK error event 検知 (= verify-phase-1-adk-local.ts:72-84 パターン):
      // LLM API 失敗時に ADK runner は throw せず `errorCode` 付き event を yield する。
      if (typeof event === 'object' && event !== null && 'errorCode' in event) {
        const ev = event as { errorCode?: string; errorMessage?: string };
        if (ev.errorCode) {
          adkErrorCode = ev.errorCode;
          adkErrorMessage = ev.errorMessage;
          log.error('ADK dispatcher: error event', {
            event: 'adk.dispatcher.error_event',
            request_id: requestId,
            error_code: ev.errorCode,
            error_message: ev.errorMessage,
          });
          break;
        }
      }
      if (isFinalResponse(event)) {
        finalText = event.content?.parts?.[0]?.text ?? '';
      }
    }
  } catch (err) {
    log.error('ADK dispatcher: unexpected throw', {
      event: 'adk.dispatcher.unexpected_error',
      request_id: requestId,
      err: err instanceof Error ? err.message : String(err),
    });
    finalText = 'エラー: LLM 呼び出しに失敗しました。しばらくして再度お試しください。';
  }

  if (adkErrorCode) {
    finalText = `エラー: ${adkErrorCode}${adkErrorMessage ? ' — ' + adkErrorMessage : ''}`;
  } else if (!finalText) {
    finalText = '(応答が空でした。)';
  }

  const adapter = getChannelAdapter(channelType);
  if (!adapter) {
    log.warn('ADK dispatcher: no adapter for channel type', {
      event: 'adk.dispatcher.no_adapter',
      request_id: requestId,
      channel_type: channelType,
    });
    return;
  }

  try {
    await adapter.deliver(platformId, threadId, {
      kind: 'chat',
      content: { text: finalText },
    });
    log.info('ADK dispatcher: delivered', {
      event: 'adk.dispatcher.delivered',
      request_id: requestId,
      channel_type: channelType,
      final_text_length: finalText.length,
    });
  } catch (err) {
    // adapter.deliver 失敗はここで拾う (= router.ts の catch に throw させない)。
    // channel adapter 側のログで詳細が出るはずなので、ここは overview のみ残す。
    log.error('ADK dispatcher: deliver failed', {
      event: 'adk.dispatcher.deliver_failed',
      request_id: requestId,
      channel_type: channelType,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
