/**
 * ADK HITL 承認完了時の resume 経路 (M4-B Phase 4)。
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
 * adk-js@1.3.0 の `RequestConfirmationLlmRequestProcessor` (`agents/processors/*`) が
 * `requestConfirmation()` 発火時に internal で "adk_request_confirmation" name を用いて
 * function call を組み立てる。resume 時にも同じ name の functionResponse を送ることで
 * ADK 側の `handleFunctionCalls` (functions.ts) が pause tool を再実行する経路が成立する
 * (plan §意思決定ログ + web-researcher 調査結果より)。
 *
 * # silent failure 撲滅方針
 *
 * dispatcher.ts と同じ contract を守る: 内部で throw を起こしても最終的に patron に
 * 「エラー: ...」応答を deliver する。deliver 自体の失敗は log.error で拾って swallow する
 * (= response-handler.ts の caller は本関数の throw を期待していない)。
 */
import { isFinalResponse } from '@google/adk';

import { getChannelAdapter } from '../channels/channel-registry.js';
import { log } from '../log.js';

import { getSharedRunner } from './dispatcher.js';
import { BIBLIO_M4B_APP_NAME } from './runner.js';

/**
 * response-handler.ts の adk_confirm 分岐が受け取る payload の shape (= adk-approvals.ts の
 * `createPendingApproval` payload と対応)。JSON.parse 後にこの型で扱う。
 */
export interface AdkApprovalPayload {
  adkSessionId: string;
  functionCallId: string;
  userId: string;
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  hint: string;
  innerAction: 'enkin' | 'shokyaku';
  toolPayload: Record<string, unknown>;
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
  // (session/base_session_service.d.ts:31-42 準拠)。
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
  try {
    await adapter.deliver(payload.platformId, payload.threadId, {
      kind: 'chat',
      content: { text },
    });
  } catch (err) {
    log.error('ADK approval deliver failed', {
      event: 'adk.approval.deliver_failed',
      request_id: requestId,
      channel_type: payload.channelType,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
