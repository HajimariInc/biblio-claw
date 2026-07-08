/**
 * ADK HITL 承認完了時の resume 経路。
 *
 * response-handler.ts の `adk_confirm` 分岐が admin 押下時にここ (`resolveAdkApproval`) を呼ぶ。
 * dispatcher.ts で pause した ADK session を **同じ sessionId で `runner.runAsync` 再呼出**し、
 * `functionResponse` (name='adk_request_confirmation') を送り込むことで tool.execute を resume
 * させる。resume 後の event stream を消費して patron に最終応答を deliver する。
 *
 * # 経路の要点
 *
 * 1. `getSharedRunner()` (dispatcher.ts) から `{ runner, sessionService }` を取得
 * 2. `sessionService.getSession({adkSessionId})` で存在確認 (Pod 再起動対応 =
 *    InMemorySessionService は Pod 内メモリなので再起動で消える → patron に「失効」通知)
 * 3. `runner.runAsync({sessionId: adkSessionId, newMessage: {functionResponse}})` で resume
 * 4. event stream 消費 → `isFinalResponse` から finalText 抽出 → adapter.deliver で patron 応答
 * 5. `sessionService.deleteSession` で cleanup (= session leak 防止)
 *
 * # `functionResponse.name = 'adk_request_confirmation'` の由来
 *
 * adk-js@1.3.0 の実装で pause と resume は担当関数が別:
 *   - **pause 構築**: `generateRequestConfirmationEvent` (`agents/functions.js:129-170`) が
 *     `requestConfirmation()` 発火時に定数 `REQUEST_CONFIRMATION_FUNCTION_CALL_NAME =
 *     'adk_request_confirmation'` (`agents/functions.js:56`) を name に持つ wrapper function call
 *     を組み立てる。呼び出し元は `LlmAgent.postprocess` (`agents/llm_agent.js:527-534`)
 *   - **resume 検知**: `RequestConfirmationLlmRequestProcessor.runAsync`
 *     (`agents/processors/request_confirmation_llm_request_processor.js:74`) が次ターン開始時に
 *     session history を遡り、同 name の function call とそれに紐づく functionResponse を
 *     突き合わせて pause tool を再実行する経路が成立する
 *
 * したがって resume 時に送る `functionResponse.name` を `'adk_request_confirmation'` に固定
 * する必要があり、`id` は pause 時の wrapper function call id (Phase 4 review C1 参照) を使う
 * (Phase 4 review CM1 対応: 旧 comment は pause 構築を processor に誤帰属していたため訂正)。
 *
 * # silent failure 撲滅方針
 *
 * dispatcher.ts と同じ contract を守る: 内部で throw を起こしても最終的に patron に
 * 「エラー: ...」応答を deliver する。deliver 自体の失敗は log.error で拾って swallow する
 * (= response-handler.ts の caller は本関数の throw を期待していない)。
 */
import { isFinalResponse } from '@google/adk';

import { getChannelAdapter } from '../channels/channel-registry.js';
import { isStubDeliveryByMg } from '../delivery.js';
import { log } from '../log.js';

import { getSharedRunner } from './dispatcher.js';
import { BIBLIO_M4B_APP_NAME } from './runner.js';
import type { HitlConfirmationPayload, HitlToolAction } from './tools/hitl-types.js';

/**
 * response-handler.ts の adk_confirm 分岐が受け取る payload の shape (= adk-approvals.ts の
 * `createPendingApproval` payload と対応)。JSON.parse 後にこの型で扱う。
 *
 * **Phase 4 review W3-3 / issue #108 対応**: `innerAction` / `toolPayload` の型を
 * `hitl-types.ts` の named type に統一 (3 箇所の重複定義解消)。
 */
export interface AdkApprovalPayload {
  adkSessionId: string;
  /**
   * ADK runner が pause 時に付与した wrapper (`adk_request_confirmation`) の function call id。
   * resume 時の `functionResponse.id` に指定する (Phase 4 review C1: 元 tool call id と別
   * namespace、`event.longRunningToolIds[]` = `event.content.parts[].functionCall.id` の側)。
   */
  functionCallId: string;
  userId: string;
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  hint: string;
  innerAction: HitlToolAction;
  toolPayload: HitlConfirmationPayload;
}

/**
 * ADK 承認完了時の resume + patron 応答 (throw しない、silent failure 撲滅)。
 *
 * @param payload adk_confirm pending_approvals row の payload (parse 済)
 * @param selectedOption admin 押下ボタンの value (`'approve' | 'reject'`)
 */
export async function resolveAdkApproval(payload: AdkApprovalPayload, selectedOption: string): Promise<void> {
  const confirmed = selectedOption === 'approve';
  const requestId = crypto.randomUUID();
  log.info('ADK approval resolved (dispatch resume)', {
    event: 'adk.approval.resolve',
    request_id: requestId,
    adk_session_id: payload.adkSessionId,
    function_call_id: payload.functionCallId,
    inner_action: payload.innerAction,
    confirmed,
  });

  let runner;
  let sessionService;
  try {
    ({ runner, sessionService } = getSharedRunner());
  } catch (err) {
    log.error('ADK approval resolve: runner init failed', {
      event: 'adk.approval.runner_init_failed',
      request_id: requestId,
      adk_session_id: payload.adkSessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    await deliverToPatron(payload, 'エラー: 承認後のシステム初期化に失敗しました。', requestId);
    return;
  }

  // Session 存在確認 (Pod 再起動対応 = InMemorySessionService が消えていれば undefined)。
  // adk-js@1.3.0 の `BaseSessionService.getSession(request)` は request object 引数
  // `{appName, userId, sessionId}` を受け `Promise<Session | undefined>` を返す
  // (session/base_session_service.d.ts:33-42 `GetSessionRequest` interface 準拠、
  // Phase 4 review CM5 対応で行番号厳密化)。
  const existingSession = await sessionService.getSession({
    appName: BIBLIO_M4B_APP_NAME,
    userId: payload.userId,
    sessionId: payload.adkSessionId,
  });
  if (!existingSession) {
    log.warn('ADK approval resolve: session not found (Pod restart?)', {
      event: 'adk.approval.session_lost',
      request_id: requestId,
      adk_session_id: payload.adkSessionId,
    });
    await deliverToPatron(
      payload,
      'エラー: Pod 再起動により承認セッションが失効しました。もう一度 tool 呼出をお願いします。',
      requestId,
    );
    return;
  }

  let finalText = '';
  let adkErrorCode: string | undefined;
  let adkErrorMessage: string | undefined;

  try {
    for await (const event of runner.runAsync({
      userId: payload.userId,
      sessionId: payload.adkSessionId,
      newMessage: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: payload.functionCallId,
              name: 'adk_request_confirmation',
              response: { confirmed },
            },
          },
        ],
      },
    })) {
      // ADK error event handling (dispatcher.ts と同流儀)
      if (typeof event === 'object' && event !== null && 'errorCode' in event) {
        const ev = event as { errorCode?: string; errorMessage?: string };
        if (ev.errorCode) {
          adkErrorCode = ev.errorCode;
          adkErrorMessage = ev.errorMessage;
          log.error('ADK approval resolve: error event', {
            event: 'adk.approval.error_event',
            request_id: requestId,
            adk_session_id: payload.adkSessionId,
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
    log.error('ADK approval resolve: runAsync threw', {
      event: 'adk.approval.resume_error',
      request_id: requestId,
      adk_session_id: payload.adkSessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    finalText = 'エラー: 承認後の処理に失敗しました。しばらくして再度お試しください。';
  } finally {
    // Resume 完了、session cleanup (session leak 防止、失敗しても warn のみで continue)
    try {
      await sessionService.deleteSession({
        appName: BIBLIO_M4B_APP_NAME,
        userId: payload.userId,
        sessionId: payload.adkSessionId,
      });
    } catch (deleteErr) {
      log.warn('ADK approval resolve: deleteSession failed', {
        event: 'adk.approval.delete_session_failed',
        request_id: requestId,
        adk_session_id: payload.adkSessionId,
        err: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
      });
    }
  }

  if (adkErrorCode) {
    finalText = `エラー: ${adkErrorCode}${adkErrorMessage ? ' — ' + adkErrorMessage : ''}`;
  } else if (!finalText) {
    finalText = '(承認後の応答が空でした。)';
  }

  await deliverToPatron(payload, finalText, requestId);
}

/**
 * patron への最終応答 deliver ヘルパ (= dispatcher.ts の `deliverFallback` と同流儀)。
 *
 * adapter 不在: warn log のみ。adapter.deliver throw: log.error で拾って swallow。
 */
async function deliverToPatron(payload: AdkApprovalPayload, text: string, requestId: string): Promise<void> {
  const adapter = getChannelAdapter(payload.channelType);
  if (!adapter) {
    log.warn('ADK approval resolve: no channel adapter', {
      event: 'adk.approval.no_adapter',
      request_id: requestId,
      channel_type: payload.channelType,
    });
    return;
  }
  // issue #155 案 B 対応: ADK approval resume 経路の stub check (dispatcher.ts と対称)
  if (isStubDeliveryByMg(payload.channelType, payload.platformId)) {
    log.info('ADK approval resolve: deliver skipped by stub (verify path)', {
      event: 'adk.approval.stubbed',
      request_id: requestId,
      channel_type: payload.channelType,
      platform_id: payload.platformId,
      final_text_length: text.length,
    });
    return;
  }
  try {
    // `deliverFallback` (dispatcher.ts:333-379) と同流儀の
    // `deliveryId === undefined` 検知を追加。CLI adapter が client 未接続時に undefined を
    // 返すため、`delivered` ではなく `not_delivered` warn を残して silent 化を防ぐ。
    const deliveryId = await adapter.deliver(payload.platformId, payload.threadId, {
      kind: 'chat',
      content: { text },
    });
    if (deliveryId === undefined) {
      log.warn('ADK approval resolve: adapter returned undefined (delivery may not have reached patron)', {
        event: 'adk.approval.not_delivered',
        request_id: requestId,
        channel_type: payload.channelType,
        inner_action: payload.innerAction,
        final_text_length: text.length,
      });
    } else {
      log.info('ADK approval resolve: delivered', {
        event: 'adk.approval.delivered',
        request_id: requestId,
        channel_type: payload.channelType,
        delivery_id: deliveryId,
        final_text_length: text.length,
      });
    }
  } catch (err) {
    log.error('ADK approval deliver failed', {
      event: 'adk.approval.deliver_failed',
      request_id: requestId,
      channel_type: payload.channelType,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
