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
 * **module-level singleton runner の理由** (comment-analyzer S2 精度訂正):
 *   - `new LlmAgent(...)` 自体は認証を触らない (= 文字列 model ID を保持するのみ)。実際の
 *     Vertex 認証解決は `canonicalModel` getter → `AnthropicVertexLlm` コンストラクタ経由で
 *     `runEphemeral` 実行時に **遅延発火** する (adk-js 1.3.0 `llm_agent.js` 実装)
 *   - それでも singleton 化する理由は SDK オブジェクト (`LlmAgent` / `InMemoryRunner` /
 *     内部 in-memory service) 構築コストの毎回発火を避けるため
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

/** module-scope singleton。SDK オブジェクト構築コストを起動時 1 回に抑える。 */
let sharedRunner: InMemoryRunner | undefined;

/**
 * ADK Runner の共有インスタンスを返す (初回呼出時に lazy 初期化)。
 *
 * lazy 初期化する理由: `buildRootAgent()` は SDK 内部 validation (`FunctionTool` name regex、
 * `LlmAgent` config 検証) を同期実行する。ADK 側の想定外変更で例外が投げられうる (= 現状は
 * 稀だが 0 ではない)。**呼出元は必ず try で囲む** (= dispatchToAdk が試みる契約、下記参照)。
 * また実際の Vertex 認証は `runEphemeral` 実行時に遅延発火するため、`initHostProxy()` /
 * `setupVertexProxy()` / `registerAnthropicVertexLlm()` が完了した後 (= routeInbound 経由
 * 呼出時点) で走る順序を `src/index.ts` main() が保証している。
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
  /** router → dispatcher の trace 相関 ID (structured log で活用)。 */
  messagingGroupId: string;
  /** 'cli' / 'slack' / etc. `getChannelAdapter(channelType)` で動的解決される。 */
  channelType: string;
  platformId: string;
  threadId: string | null;
  userId: string | null;
  /** patron 発話 (chat.content.text の抽出後)。空文字列は「メッセージを認識できませんでした」応答。 */
  patronText: string;
  requestId: string;
}

/**
 * ADK Runner event stream を消費し、最終応答を channel adapter 経由で patron に返す。
 *
 * **contract** (silent failure 撲滅方針の徹底):
 *   - `throw` しない (= router.ts の catch に頼らない)。`getSharedRunner()` の初期化失敗
 *     から `runEphemeral` の event stream 例外、`adapter.deliver` 失敗までを全て内部で
 *     catch し、patron 向けに何らかの日本語 fallback text で `adapter.deliver` を試みる
 *   - `adapter` 不在時のみ warn log で終了 (= 応答経路がないなら他に選択肢がない)
 *   - `adapter.deliver` が `undefined` を返した場合、CLI 経路等の「client 未接続 = 実 delivery
 *     なし」の可能性があるため `delivered` ログではなく `not_delivered` を残す (= 偽成功
 *     ログを防ぐ、silent-failure-hunter C1 対処)
 *   - 空 `patronText` は patron に「認識できませんでした」応答 (= 唯一の validation、上流
 *     チェックはない前提)
 *
 * event stream 消費 pattern は `scripts/verify-phase-1-adk-local.ts:98-138` から写経。
 */
export async function dispatchToAdk(params: DispatchToAdkParams): Promise<void> {
  const { channelType, platformId, threadId, patronText, requestId } = params;

  // 空 patronText fallback (= empty payload / mention only 等): silent drop せず patron に返す。
  if (!patronText.trim()) {
    log.warn('ADK dispatcher: empty patronText', {
      event: 'adk.dispatcher.empty_input',
      request_id: requestId,
      channel_type: channelType,
    });
    await deliverFallback(
      channelType,
      platformId,
      threadId,
      'メッセージを認識できませんでした。テキストを含めてもう一度お試しください。',
      requestId,
    );
    return;
  }

  // Runner 初期化を try に含める (I1 = code-reviewer + comment-analyzer 指摘)。
  // 初期化失敗時は system error として patron に fallback を送る。
  let runner: InMemoryRunner;
  try {
    runner = getSharedRunner();
  } catch (err) {
    log.error('ADK dispatcher: runner init failed', {
      event: 'adk.dispatcher.runner_init_failed',
      request_id: requestId,
      err: err instanceof Error ? err.message : String(err),
    });
    await deliverFallback(
      channelType,
      platformId,
      threadId,
      'エラー: システム初期化に失敗しました。しばらくして再度お試しください。',
      requestId,
    );
    return;
  }

  const userId = params.userId ?? params.platformId;

  log.info('ADK dispatcher: invoke', {
    event: 'adk.dispatcher.invoke',
    request_id: requestId,
    channel_type: channelType,
    agent_group_id: params.agentGroupId,
    messaging_group_id: params.messagingGroupId,
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

  await deliverFallback(channelType, platformId, threadId, finalText, requestId);
}

/**
 * `adapter.deliver` を安全に叩くヘルパ (= dispatcher 内の全ての「patron 応答」経路がここを通る)。
 *
 * - adapter 不在: warn log のみ (= 応答経路がないなら選択肢なし)
 * - deliver throw: log.error で拾って swallow (= dispatchToAdk contract を守る)
 * - deliver return undefined: CLI adapter が client 未接続時に `undefined` を返す仕様 =
 *   実 delivery なし。`delivered` ではなく `not_delivered` ログを残して silent 化を防ぐ
 *   (silent-failure-hunter C1 対処)
 */
async function deliverFallback(
  channelType: string,
  platformId: string,
  threadId: string | null,
  text: string,
  requestId: string,
): Promise<void> {
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
    const deliveryId = await adapter.deliver(platformId, threadId, {
      kind: 'chat',
      content: { text },
    });
    if (deliveryId === undefined) {
      // CLI adapter は client 未接続時に undefined を返す (`cli.ts:126-135` で warn 出力済)。
      // ADK 経路は outbound.db を経由しないため、この応答は永久にロストする = 偽成功
      // ログを残さないよう `not_delivered` を明示。運用は Cloud Logging で
      // `event="adk.dispatcher.not_delivered"` を監視することで silent failure を検知できる。
      log.warn('ADK dispatcher: adapter returned undefined (delivery may not have reached patron)', {
        event: 'adk.dispatcher.not_delivered',
        request_id: requestId,
        channel_type: channelType,
        final_text_length: text.length,
      });
    } else {
      log.info('ADK dispatcher: delivered', {
        event: 'adk.dispatcher.delivered',
        request_id: requestId,
        channel_type: channelType,
        delivery_id: deliveryId,
        final_text_length: text.length,
      });
    }
  } catch (err) {
    log.error('ADK dispatcher: deliver failed', {
      event: 'adk.dispatcher.deliver_failed',
      request_id: requestId,
      channel_type: channelType,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
