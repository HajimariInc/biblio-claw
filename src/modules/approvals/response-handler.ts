/**
 * Handle an admin's response to an approval card.
 *
 * Three categories of pending_approvals rows exist:
 *   1. Module-initiated actions — the module called `requestApproval()` with
 *      some free-form `action` string and registered a handler via
 *      `registerApprovalHandler(action, handler)`. On approve, we look up the
 *      handler and call it; on reject, we notify the agent and move on.
 *   2. OneCLI credential approvals (`action = 'onecli_credential'`). Resolved
 *      via an in-memory Promise — see onecli-approvals.ts.
 *   3. ADK HITL approvals (`action = 'adk_confirm'`). Phase 4 で追加、破壊操作
 *      tool (enkin/shokyaku) の admin 承認。approve/reject を `resolveAdkApproval`
 *      経由で ADK runner に伝え、pause 中の tool.execute を resume させる。
 *
 * The response handler is registered via core's `registerResponseHandler`;
 * core iterates handlers and the first one to return `true` claims the response.
 */
import { resolveAdkApproval, type AdkApprovalPayload } from '../../adk/approval-dispatcher.js';
import { wakeContainer } from '../../container-runner.js';
import { deletePendingApproval, getPendingApproval, getSession } from '../../db/sessions.js';
import type { ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval } from '../../types.js';
import { ADK_CONFIRM_ACTION } from './adk-approvals.js';
import { ONECLI_ACTION, resolveOneCLIApproval } from './onecli-approvals.js';
import { getApprovalHandler } from './primitive.js';

export async function handleApprovalsResponse(payload: ResponsePayload): Promise<boolean> {
  // OneCLI credential approvals — resolved via in-memory Promise first.
  if (resolveOneCLIApproval(payload.questionId, payload.value)) {
    return true;
  }

  // DB-backed pending_approvals.
  const approval = getPendingApproval(payload.questionId);
  if (!approval) return false;

  if (approval.action === ONECLI_ACTION) {
    // Row exists but the in-memory resolver is gone (timer fired or the process
    // was in a weird state). Nothing to do — just drop the row.
    deletePendingApproval(payload.questionId);
    return true;
  }

  // Phase 4: ADK HITL approvals — session_id は null で保存、payload に ADK session 情報。
  // 既存 module-registered 分岐 (下の `handleRegisteredApproval`) は session_id 有り前提のため
  // 先に adk_confirm を捌く必要がある。
  if (approval.action === ADK_CONFIRM_ACTION) {
    let adkPayload: AdkApprovalPayload;
    try {
      adkPayload = JSON.parse(approval.payload) as AdkApprovalPayload;
    } catch (err) {
      log.error('ADK approval payload parse failed', {
        event: 'adk.approval.payload_parse_failed',
        approval_id: approval.approval_id,
        err: err instanceof Error ? err.message : String(err),
      });
      deletePendingApproval(payload.questionId);
      return true;
    }
    try {
      await resolveAdkApproval(adkPayload, payload.value);
    } catch (err) {
      // resolveAdkApproval は throw しない契約だが、防御的に catch (silent-failure-hunter I1)
      log.error('resolveAdkApproval unexpectedly threw', {
        event: 'adk.approval.resolve_unexpected_throw',
        approval_id: approval.approval_id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    deletePendingApproval(payload.questionId);
    return true;
  }

  await handleRegisteredApproval(approval, payload.value, payload.userId ?? '');
  return true;
}

async function handleRegisteredApproval(
  approval: PendingApproval,
  selectedOption: string,
  userId: string,
): Promise<void> {
  if (!approval.session_id) {
    deletePendingApproval(approval.approval_id);
    return;
  }
  const session = getSession(approval.session_id);
  if (!session) {
    deletePendingApproval(approval.approval_id);
    return;
  }

  const notify = (text: string): void => {
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
    });
  };

  if (selectedOption !== 'approve') {
    notify(`Your ${approval.action} request was rejected by admin.`);
    log.info('Approval rejected', { approvalId: approval.approval_id, action: approval.action, userId });
    deletePendingApproval(approval.approval_id);
    await wakeContainer(session);
    return;
  }

  // Approved — dispatch to the module that registered for this action.
  const handler = getApprovalHandler(approval.action);
  if (!handler) {
    log.warn('No approval handler registered — row dropped', {
      approvalId: approval.approval_id,
      action: approval.action,
    });
    notify(`Your ${approval.action} was approved, but no handler is installed to apply it.`);
    deletePendingApproval(approval.approval_id);
    await wakeContainer(session);
    return;
  }

  const payload = JSON.parse(approval.payload);
  try {
    await handler({ session, payload, userId, notify });
    log.info('Approval handled', { approvalId: approval.approval_id, action: approval.action, userId });
  } catch (err) {
    log.error('Approval handler threw', { approvalId: approval.approval_id, action: approval.action, err });
    notify(
      `Your ${approval.action} was approved, but applying it failed: ${err instanceof Error ? err.message : String(err)}.`,
    );
  }

  deletePendingApproval(approval.approval_id);
  await wakeContainer(session);
}
