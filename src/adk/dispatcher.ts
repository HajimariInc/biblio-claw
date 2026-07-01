/**
 * ADK Runner → channel adapter dispatcher (M4-B Phase 3 + Phase 4 HITL 統合).
 *
 * 本 module は `src/router.ts:deliverToAgent()` の `provider === 'adk'` 分岐から呼ばれ、
 * patron 命令 (CLI / Slack / 他 channel いずれか) を root `LlmAgent` に流し込み、
 * event stream の `isFinalResponse` を拾って channel adapter 経由で patron に返す。
 *
 * **channel adapter agnostic**: `channelType` を parameter で受け、`getChannelAdapter()` で
 * 動的に adapter を解決するだけ。CLI (`cli.ts`) でも Slack (`slack.ts`) でも同一 code path。
 *
 * # Phase 3 → Phase 4 の切替: `runEphemeral` → `runAsync` + 明示 session 管理
 *
 * Phase 3 は `InMemoryRunner.runEphemeral({userId, newMessage})` を使い ephemeral session を
 * 都度使い捨てだった。Phase 4 で HITL 承認機構 (enkin/shokyaku) を統合するため、明示的な
 * `sessionService.createSession → runner.runAsync → 保持 or deleteSession` に切り替えた。
 *
 * # HITL pending 経路 (event.longRunningToolIds 検知)
 *
 * LLM が `enkin_biblio` / `shokyaku_biblio` の tool を呼び、内部で `requestConfirmation()` を
 * 発火すると、adk-js は event に:
 *   - `event.longRunningToolIds: [functionCallId]` (pause 対象の function call id 配列)
 *   - `event.actions.requestedToolConfirmations: {[functionCallId]: {hint, confirmed, payload}}`
 * を populate する。dispatcher はこれを検知したら:
 *   1. payload から `{biblioName, category, action: 'enkin' | 'shokyaku'}` を取り出し
 *   2. `requestAdkApproval({...})` で admin に Slack DM ask_question card を配信
 *   3. patron に「承認申請しました」中間応答を deliver
 *   4. `break` で event stream 消費を打ち切り、`deleteSession` を **skip** して session 保持
 *
 * 承認完了 (admin 押下) 時は response-handler.ts が `resolveAdkApproval` を呼び、同 sessionId で
 * runAsync 再呼出 → functionResponse 送り込み → tool.execute 再実行 → 最終応答 deliver。
 *
 * # silent failure 撲滅方針 (Phase 3 契約を維持)
 *
 * `throw` しない (= router.ts の catch に頼らない)。runner 初期化失敗 / event stream 例外 /
 * adapter.deliver 失敗までを全て内部で catch し、patron 向けに何らかの日本語 fallback text で
 * `adapter.deliver` を試みる。空 `patronText` は patron に「認識できませんでした」応答。
 */
import { isFinalResponse } from '@google/adk';

import { getChannelAdapter } from '../channels/channel-registry.js';
import { log } from '../log.js';
import { requestAdkApproval } from '../modules/approvals/adk-approvals.js';

import { buildRootAgent } from './root-agent.js';
import { buildRunner, BIBLIO_M4B_APP_NAME, type SharedRunnerContext } from './runner.js';

/** module-scope singleton。SDK オブジェクト構築コストを起動時 1 回に抑える。 */
let sharedContext: SharedRunnerContext | undefined;

/**
 * ADK Runner の共有インスタンスを返す (初回呼出時に lazy 初期化)。
 *
 * Phase 4 で戻り値を `SharedRunnerContext = { runner, sessionService }` に拡張した
 * (= HITL 承認機構が sessionService を経由して明示的に session の create / delete を行う)。
 *
 * lazy 初期化する理由: `buildRootAgent()` は SDK 内部 validation (`FunctionTool` name regex、
 * `LlmAgent` config 検証) を同期実行する。ADK 側の想定外変更で例外が投げられうる (= 現状は
 * 稀だが 0 ではない)。**呼出元は必ず try で囲む** (= dispatchToAdk / resolveAdkApproval が
 * 試みる契約)。実際の Vertex 認証は `runAsync` 実行時に遅延発火するため、`initHostProxy()` /
 * `setupVertexProxy()` / `registerAnthropicVertexLlm()` が完了した後 (= routeInbound 経由
 * 呼出時点) で走る順序を `src/index.ts` main() が保証している。
 */
export function getSharedRunner(): SharedRunnerContext {
  if (!sharedContext) {
    const rootAgent = buildRootAgent();
    sharedContext = buildRunner(rootAgent);
    log.info('ADK dispatcher: shared runner + sessionService created', {
      event: 'adk.dispatcher.runner_created',
      app_name: BIBLIO_M4B_APP_NAME,
    });
  }
  return sharedContext;
}

/**
 * test 用 backdoor: module state を reset する。production import path からは呼ばない。
 *
 * `vi.mock('./root-agent.js')` で mock runner に差し替えるとき、beforeEach で
 * `_resetSharedRunnerForTest()` を呼ばないと前 case の runner が引き継がれる。
 */
export function _resetSharedRunnerForTest(): void {
  sharedContext = undefined;
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
 *   - `throw` しない
 *   - runner 初期化失敗 / event stream 例外 / adapter.deliver 失敗を全て内部で catch し patron 通知
 *   - HITL pending 経路 (`event.longRunningToolIds`) 検知時は `requestAdkApproval` 呼出 +
 *     patron に中間応答 + session 保持 (deleteSession skip) で return
 *   - 通常経路の finally は session cleanup、pending 経路は resume 側 (approval-dispatcher.ts) が cleanup
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

  // Runner 初期化を try に含める (Phase 3 契約継承)。初期化失敗時は system error として fallback。
  let ctx: SharedRunnerContext;
  try {
    ctx = getSharedRunner();
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
  const { runner, sessionService } = ctx;

  const userId = params.userId ?? params.platformId;

  // Session 明示作成 (runEphemeral 内部処理を manual で行う、HITL pause 対応のため)。
  // sessionId は adk-js が UUID を自動生成する。
  let sessionId: string;
  try {
    const session = await sessionService.createSession({
      appName: BIBLIO_M4B_APP_NAME,
      userId,
    });
    sessionId = session.id;
  } catch (err) {
    log.error('ADK dispatcher: createSession failed', {
      event: 'adk.dispatcher.create_session_failed',
      request_id: requestId,
      err: err instanceof Error ? err.message : String(err),
    });
    await deliverFallback(
      channelType,
      platformId,
      threadId,
      'エラー: 会話セッションの作成に失敗しました。しばらくして再度お試しください。',
      requestId,
    );
    return;
  }

  // 重複 deleteSession 防止 (= finally + pending 経路の両方で呼ばれる可能性への防御)
  let sessionDeleted = false;
  const deleteSessionSafe = async (): Promise<void> => {
    if (sessionDeleted) return;
    sessionDeleted = true;
    try {
      await sessionService.deleteSession({ appName: BIBLIO_M4B_APP_NAME, userId, sessionId });
    } catch (err) {
      log.warn('ADK dispatcher: deleteSession failed (leaking session)', {
        event: 'adk.dispatcher.delete_session_failed',
        request_id: requestId,
        session_id: sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  log.info('ADK dispatcher: invoke', {
    event: 'adk.dispatcher.invoke',
    request_id: requestId,
    channel_type: channelType,
    agent_group_id: params.agentGroupId,
    messaging_group_id: params.messagingGroupId,
    user_id: userId,
    adk_session_id: sessionId,
    patron_text_length: patronText.length,
  });

  let finalText = '';
  let adkErrorCode: string | undefined;
  let adkErrorMessage: string | undefined;
  let pending = false;

  try {
    for await (const event of runner.runAsync({
      userId,
      sessionId,
      newMessage: { role: 'user', parts: [{ text: patronText }] },
    })) {
      // ADK error event 検知 (= Phase 3 pattern と同じ)
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

      // Phase 4: HITL pending 経路検知 (`longRunningToolIds` populate = requestConfirmation 発火済)
      const longRunningIds = event.longRunningToolIds;
      if (longRunningIds && longRunningIds.length > 0) {
        pending = true;
        // requestedToolConfirmations から hint + payload を取り出す
        const requestedConfirmations = event.actions?.requestedToolConfirmations ?? {};
        let dispatched = 0;
        for (const functionCallId of longRunningIds) {
          const confirmation = requestedConfirmations[functionCallId];
          if (!confirmation) {
            log.warn('ADK dispatcher: longRunningToolId without confirmation payload, skipping', {
              event: 'adk.dispatcher.pending_no_confirmation',
              request_id: requestId,
              function_call_id: functionCallId,
            });
            continue;
          }
          const toolPayload = confirmation.payload as { action?: unknown } | undefined;
          const action = typeof toolPayload?.action === 'string' ? toolPayload.action : undefined;
          if (action !== 'enkin' && action !== 'shokyaku') {
            log.warn('ADK dispatcher: unknown confirmation action, skipping', {
              event: 'adk.dispatcher.pending_unknown_action',
              request_id: requestId,
              function_call_id: functionCallId,
              action: action ?? null,
            });
            continue;
          }
          await requestAdkApproval({
            agentGroupId: params.agentGroupId,
            channelType,
            platformId,
            threadId,
            userId,
            adkSessionId: sessionId,
            functionCallId,
            hint: confirmation.hint ?? '承認が必要な操作です。',
            action,
            payload: (toolPayload as Record<string, unknown>) ?? {},
          });
          dispatched++;
        }
        // 中間応答: patron に「承認申請しました」通知
        // (dispatched === 0 なら結局承認カードが 1 件も出ていない = 通常経路に落として最終応答を試みる)
        if (dispatched > 0) {
          await deliverFallback(
            channelType,
            platformId,
            threadId,
            '承認を admin にお願いしました。承認後に処理を続行します。',
            requestId,
          );
          break; // session を残したまま return (deleteSession しない)
        } else {
          // 全 confirmation を skip した = pending 経路の実体なし、通常経路として続行
          pending = false;
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
  } finally {
    // 通常経路のみ deleteSession、pending は resume 側 (approval-dispatcher.ts) が cleanup。
    if (!pending) {
      await deleteSessionSafe();
    }
  }

  if (pending) {
    // pending 経路: 中間応答は既に送信済、最終応答は resume 時に approval-dispatcher が送る。
    return;
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
