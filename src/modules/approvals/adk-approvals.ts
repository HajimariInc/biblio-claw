/**
 * ADK HITL approval handler — Phase 4 で追加された ADK Runner 経路専用の approval 経路。
 *
 * ADK Runner 配下の破壊操作 tool (`enkin_biblio` / `shokyaku_biblio`) が
 * `tool_context.requestConfirmation()` を呼ぶと、runner が pause して event に
 * `longRunningToolIds: [functionCallId]` を populate する。dispatcher (`src/adk/dispatcher.ts`)
 * が pending 経路を検知してここ (`requestAdkApproval`) を呼ぶ:
 *
 *   1. `pickApprover` / `pickApprovalDelivery` で admin DM を解決 (`primitive.ts` 流用)
 *   2. Slack DM に Approve/Reject 2-button ask_question card を配信 (chat-sdk bridge)
 *   3. `pending_approvals` row を `action: 'adk_confirm'` + `session_id: null` で作成
 *      (onecli-approvals.ts と同流儀 = session-independent、payload に ADK session 情報を保持)
 *   4. return void — resume は admin 押下時に response-handler.ts の adk_confirm 分岐が
 *      `resolveAdkApproval` を呼ぶ経路で行われる
 *
 * `requestApproval()` (primitive.ts) を使わない理由: primitive.ts の `RequestApprovalOptions`
 * は `Session` を必須 (= NanoClaw session 経由の agent 起こしを想定) だが、ADK Runner 経路には
 * NanoClaw session 概念がない (= in-process 完結、outbound.db 未使用)。onecli-approvals.ts が
 * 同じ理由で独立実装した pattern を Phase 4 で ADK 用に踏襲する。
 */
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { createPendingApproval } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';

import { pickApprovalDelivery, pickApprover } from './primitive.js';

/** pending_approvals.action に格納する固定文字列。response-handler.ts の分岐 key として参照。 */
export const ADK_CONFIRM_ACTION = 'adk_confirm';

/**
 * ADK 承認 card の button options。`shortAdkApprovalId()` と共に response-handler が
 * `selectedOption === 'approve'` で承認判定する contract を提供する (onecli-approvals.ts の
 * `resolveOneCLIApproval` と同 pattern)。
 */
const ADK_APPROVAL_OPTIONS = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
];

export interface RequestAdkApprovalOptions {
  agentGroupId: string;
  /** patron が発話した channel の type (= 'cli' / 'slack' 等)。fallback 通知の adapter 解決用。 */
  channelType: string;
  /** patron の platform id (= Slack user/channel、CLI local 等)。fallback 通知の宛先。 */
  platformId: string;
  /** patron thread の id (nullable、fallback 通知の宛先)。 */
  threadId: string | null;
  /** ADK 経路の userId (= patron platform_id 由来、`runAsync` の userId として使う)。 */
  userId: string;
  /** dispatcher が create した ADK session id (= runner.sessionService.createSession 結果)。 */
  adkSessionId: string;
  /** ADK runner が pause 時に付与した function call id (= resume 時の functionResponse.id に使う)。 */
  functionCallId: string;
  /** admin に表示する承認カード本文 (tool 側 `requestConfirmation({hint, ...})` の hint と同値)。 */
  hint: string;
  /** 内部 action 名 (= tool 側 payload.action、`'enkin' | 'shokyaku'`)。承認カード title 分岐に使う。 */
  action: 'enkin' | 'shokyaku';
  /** tool 側 requestConfirmation の payload (= { biblioName, category, action } の 3 要素)。 */
  payload: Record<string, unknown>;
}

/**
 * ADK 用の short approval id を生成 (onecli-approvals.ts:shortApprovalId と同流儀)。
 *
 * Telegram callback_data 64-byte 制限内に収まるよう `adk-` + 8 base36 chars の 11-byte 化。
 */
function shortAdkApprovalId(): string {
  return `adk-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * ADK 経路の承認要求を発行 (fire-and-forget、throw しない)。
 *
 * approver 不在 / DM 経路不在 / adapter.deliver throw の各 fail 経路で:
 *   - `getChannelAdapter(channelType).deliver(...)` (= raw channel adapter、ChannelAdapter の
 *     3 引数 shape) で patron に fallback 通知
 *   - `pending_approvals` row は作らない (= 到達不可能な approval を DB に残さない、silent 蓄積防止)
 */
export async function requestAdkApproval(opts: RequestAdkApprovalOptions): Promise<void> {
  const approvers = pickApprover(opts.agentGroupId);
  if (approvers.length === 0) {
    log.warn('ADK approval: no eligible approver, notifying patron', {
      event: 'adk.approval.no_approver',
      agent_group_id: opts.agentGroupId,
      action: opts.action,
    });
    await notifyPatronFallback(opts, `${opts.action} 失敗: 承認可能な admin / owner が未設定です。`);
    return;
  }

  const target = await pickApprovalDelivery(approvers, opts.channelType);
  if (!target) {
    log.warn('ADK approval: no DM channel for any approver, notifying patron', {
      event: 'adk.approval.no_dm',
      agent_group_id: opts.agentGroupId,
      action: opts.action,
      approvers,
    });
    await notifyPatronFallback(opts, `${opts.action} 失敗: 承認可能な approver への DM 経路がありません。`);
    return;
  }

  const approvalId = shortAdkApprovalId();
  const title = opts.action === 'enkin' ? '禁書の承認' : '焼却の承認';

  const adapter = getDeliveryAdapter();
  let platformMessageId: string | undefined;
  if (adapter) {
    try {
      platformMessageId = await adapter.deliver(
        target.messagingGroup.channel_type,
        target.messagingGroup.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: approvalId,
          title,
          question: opts.hint,
          options: ADK_APPROVAL_OPTIONS,
        }),
      );
    } catch (err) {
      log.error('ADK approval: failed to deliver approval card', {
        event: 'adk.approval.deliver_failed',
        approval_id: approvalId,
        action: opts.action,
        err: err instanceof Error ? err.message : String(err),
      });
      // card 配信失敗時は patron に fallback 通知 (= silent failure 防止)、pending row 作らない
      await notifyPatronFallback(opts, `${opts.action} 失敗: 承認カード配信に失敗しました。`);
      return;
    }
  } else {
    // delivery adapter 未 wire (= boot 直後 or shutdown 中) 想定外経路。row 作らずに patron 通知。
    log.warn('ADK approval: no delivery adapter (approval card not sent)', {
      event: 'adk.approval.no_delivery_adapter',
      approval_id: approvalId,
      action: opts.action,
    });
    await notifyPatronFallback(opts, `${opts.action} 失敗: 配信系統が未初期化です。しばらくして再度お試しください。`);
    return;
  }

  createPendingApproval({
    approval_id: approvalId,
    session_id: null,
    request_id: approvalId,
    action: ADK_CONFIRM_ACTION,
    payload: JSON.stringify({
      adkSessionId: opts.adkSessionId,
      functionCallId: opts.functionCallId,
      userId: opts.userId,
      agentGroupId: opts.agentGroupId,
      channelType: opts.channelType,
      platformId: opts.platformId,
      threadId: opts.threadId,
      hint: opts.hint,
      // 'action' は既存 pending_approvals field と衝突するため 'innerAction' に格納
      innerAction: opts.action,
      toolPayload: opts.payload,
    }),
    created_at: new Date().toISOString(),
    agent_group_id: opts.agentGroupId,
    channel_type: target.messagingGroup.channel_type,
    platform_id: target.messagingGroup.platform_id,
    platform_message_id: platformMessageId ?? null,
    status: 'pending',
    title,
    options_json: JSON.stringify(ADK_APPROVAL_OPTIONS),
  });

  log.info('ADK approval requested', {
    event: 'adk.approval.dispatch.' + opts.action,
    approval_id: approvalId,
    action: opts.action,
    approver: target.userId,
    adk_session_id: opts.adkSessionId,
    function_call_id: opts.functionCallId,
  });
}

/**
 * patron への fallback 通知 (= approver 解決不可 / card 配信失敗時)。
 *
 * `getChannelAdapter(channelType)` の raw ChannelAdapter (= 3 引数 shape) を経由。
 * silent failure 防止のため deliver 失敗も log.error で拾って swallow する。
 */
async function notifyPatronFallback(opts: RequestAdkApprovalOptions, text: string): Promise<void> {
  const adapter = getChannelAdapter(opts.channelType);
  if (!adapter) {
    log.warn('ADK approval fallback: no channel adapter for patron notification', {
      event: 'adk.approval.fallback_no_adapter',
      channel_type: opts.channelType,
      action: opts.action,
    });
    return;
  }
  try {
    await adapter.deliver(opts.platformId, opts.threadId, {
      kind: 'chat',
      content: { text },
    });
  } catch (err) {
    log.error('ADK approval fallback deliver threw', {
      event: 'adk.approval.fallback_failed',
      channel_type: opts.channelType,
      action: opts.action,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
