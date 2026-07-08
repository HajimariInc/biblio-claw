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
 *   4. return true — resume は admin 押下時に response-handler.ts の adk_confirm 分岐が
 *      `resolveAdkApproval` を呼ぶ経路で行われる
 *
 * `requestApproval()` (primitive.ts) を使わない理由: primitive.ts の `RequestApprovalOptions`
 * は `Session` を必須 (= NanoClaw session 経由の agent 起こしを想定) だが、ADK Runner 経路には
 * NanoClaw session 概念がない (= in-process 完結、outbound.db 未使用)。onecli-approvals.ts が
 * 同じ理由で独立実装した pattern を Phase 4 で ADK 用に踏襲する。
 *
 * # issue #106: admin 未応答時のタイムアウト + 起動時 sweep
 *
 * `pending_approvals` row + ADK session の無期限リーク防止のため 3 層を追加した:
 *   - **Layer 1**: `createPendingApproval` 呼出に `expires_at = now + ADK_APPROVAL_TIMEOUT_MS`
 *     を設定 (default 30 min、env `ADK_APPROVAL_TIMEOUT_MS` で override 可)
 *   - **Layer 2**: 呼出時に `setTimeout` で expiry timer を仕込み、時間切れ時に
 *     `expireAdkApproval` で「row status='expired' + Slack card edit + patron 通知 +
 *     `sessionService.deleteSession` + row 削除」の順に cleanup を実行
 *   - **Layer 3**: `startAdkApprovalHandler` を起動時 hook (`onDeliveryAdapterReady`) から
 *     呼び、Pod 再起動で残った stale row を「Expired (host restarted)」で edit + patron 通知 +
 *     row 削除で sweep (= sessionService は Pod 再起動後空なので `deleteSession` は skip)
 *
 * Admin が timer 発火前に応答したケース: `response-handler.ts:adk_confirm` 分岐冒頭で
 * `clearAdkApprovalTimer(approvalId)` を呼び、timer と pending Map entry を明示的に取り除く。
 * これにより「timer 発火直前 vs admin 応答」の race で `expireAdkApproval` が row missing で
 * 早期 return する経路も防御される (= 二重処理防止)。
 */
import type { AdkApprovalPayload } from '../../adk/approval-dispatcher.js';
import { BIBLIO_M4B_APP_NAME } from '../../adk/runner.js';
// NOTE: `getSharedRunner` は `dispatcher.ts` にあるが、dispatcher.ts は本ファイルから
// `requestAdkApproval` を static import している (Phase 4 で導入)。両者を static import で
// 相互参照すると循環依存になるため (`adk-approvals ↔ dispatcher`)、本ファイル側は
// `deleteAdkSessionSafe` 内で dynamic import (= await import()) で解決する。ESM の dynamic
// import は module graph の evaluation 順序を runtime に遅延させるため循環を閉じられる。
// また `deleteAdkSessionSafe` は expire 発火時にしか呼ばれないため、host 起動時の
// 初期 import cost には載らない (= 副作用ゼロで循環回避)。
import type { HitlConfirmationPayload, HitlToolAction } from '../../adk/tools/hitl-types.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import {
  createPendingApproval,
  deletePendingApproval,
  getPendingApproval,
  getPendingApprovalsByAction,
  updatePendingApprovalStatus,
} from '../../db/sessions.js';
import { getDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { PendingApproval } from '../../types.js';

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

/** issue #106: admin 未応答時の expiry timeout の既定値 (= 30 min)。 */
export const DEFAULT_ADK_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * env `ADK_APPROVAL_TIMEOUT_MS` を数値化 (parse fail / 非正値は null)。
 *
 * `host-sweep.ts:parseIdleThresholdMs` と同流儀。テスト用に export する。
 */
export function parseAdkApprovalTimeoutMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * issue #106: ADK 承認 expiry timeout (default 30 min、env `ADK_APPROVAL_TIMEOUT_MS` で override 可)。
 *
 * 3 層 fallback: env 未設定 → default / env 不正 → warn + default / env 有効 → env 値。
 * `host-sweep.ts:69-100` の IDLE_THRESHOLD_MS pattern 踏襲。module load 時に 1 回だけ解決。
 */
export const ADK_APPROVAL_TIMEOUT_MS = (() => {
  const raw = process.env.ADK_APPROVAL_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_ADK_APPROVAL_TIMEOUT_MS;
  const parsed = parseAdkApprovalTimeoutMs(raw);
  if (parsed !== null) return parsed;
  log.warn('ADK_APPROVAL_TIMEOUT_MS is invalid, falling back to default', {
    event: 'adk.approval.timeout_config_invalid',
    raw,
    default_ms: DEFAULT_ADK_APPROVAL_TIMEOUT_MS,
  });
  return DEFAULT_ADK_APPROVAL_TIMEOUT_MS;
})();

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
  /**
   * ADK runner が pause 時に付与した wrapper (`adk_request_confirmation`) の function call id。
   * resume 時の `functionResponse.id` に使う (Phase 4 review C1: 元 tool call id と別 namespace、
   * `event.longRunningToolIds[]` = `event.content.parts[].functionCall.id` に一致する側)。
   */
  functionCallId: string;
  /** admin に表示する承認カード本文 (tool 側 `requestConfirmation({hint, ...})` の hint と同値)。 */
  hint: string;
  /** 内部 action 名 (= tool 側 payload.action)。承認カード title 分岐に使う。 */
  action: HitlToolAction;
  /** tool 側 requestConfirmation の payload (= issue #108 対応、named type で 3 箇所統一)。 */
  payload: HitlConfirmationPayload;
}

/** issue #106: pending Map の value shape (= expiry timer のハンドル保持)。 */
interface AdkPendingState {
  timer: NodeJS.Timeout;
}

/**
 * approval_id → 生存中の expiry timer state のマップ。
 *
 * - `requestAdkApproval` が set (= expiry timer 開始)
 * - `clearAdkApprovalTimer` が明示的に取り除く (= admin が timeout 前に応答)
 * - `expireAdkApproval` が timer 発火時に取り除く (= timeout 発生)
 * - `stopAdkApprovalHandler` が shutdown 時に全 timer clear + Map クリア
 *
 * payload を state に持たせない理由: expiry / sweep 経路が row lookup で必ず DB を経由する
 * (= `getPendingApproval` / `getPendingApprovalsByAction`)。payload は DB row の source of
 * truth に一元化し、state はライフサイクル制御 (timer) のみに絞る。
 */
const pending = new Map<string, AdkPendingState>();

/**
 * issue #106: 起動時 hook で set される delivery adapter。
 *
 * expiry / sweep 経路は本 field を経由して `deliver('chat-sdk', {operation:'edit',...})` を発行
 * (= `requestAdkApproval` は既存の `getDeliveryAdapter()` 経路を保持、test 影響を抑える)。
 *
 * OneCLI 側 (`onecli-approvals.ts:46`) と同流儀。
 */
let adapterRef: ChannelDeliveryAdapter | null = null;

/** issue #106: `startAdkApprovalHandler` の idempotent 保証。二重 hook 登録の副作用を防ぐ。 */
let started = false;

/**
 * ADK 用の short approval id を生成 (onecli-approvals.ts:shortApprovalId と同流儀)。
 *
 * Telegram callback_data 64-byte 制限内に収まるよう `adk-` + 8 base36 chars の 11-byte 化。
 */
function shortAdkApprovalId(): string {
  return `adk-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * ADK 経路の承認要求を発行 (throw しない、pending row 作成成否を boolean で返す)。
 *
 * **Phase 4 review C3 対応**: 戻り値を `Promise<boolean>` に変更した。以下の各 fail 経路では
 * patron に既に「失敗」通知を deliver した状態で `false` を返す。**呼び出し元 (dispatcher.ts)
 * は false を「pending row 未作成 = 承認要求は成立していない」と解釈**し、`dispatched` を
 * インクリメントせず、中間応答「承認を admin にお願いしました」を送らない (= 内部失敗と
 * 「成功しました」の矛盾する 2 通のメッセージ配信を防ぐ)。
 *
 * **issue #106 対応**: 正常経路で `expires_at` を設定 (Layer 1) + `setTimeout` で expiry timer
 * を仕込む (Layer 2)。timer 発火時は `expireAdkApproval` に委譲。
 *
 * 各 fail 経路:
 *   - approver 不在 → patron に「承認可能な admin / owner が未設定です」通知 → false
 *   - DM 経路不在 → patron に「承認可能な approver への DM 経路がありません」通知 → false
 *   - 承認カード配信 throw → patron に「承認カード配信に失敗しました」通知 → false
 *   - delivery adapter 未 wire (boot 直後 / shutdown 中) → patron に「配信系統が未初期化です」通知 → false
 *   - 上記いずれも `pending_approvals` row は作らない (= 到達不可能な approval の silent 蓄積防止)
 *
 * 正常経路: `pending_approvals` row を作成後 true を返す。
 */
export async function requestAdkApproval(opts: RequestAdkApprovalOptions): Promise<boolean> {
  const approvers = pickApprover(opts.agentGroupId);
  if (approvers.length === 0) {
    log.warn('ADK approval: no eligible approver, notifying patron', {
      event: 'adk.approval.no_approver',
      agent_group_id: opts.agentGroupId,
      action: opts.action,
    });
    await notifyPatronFallback(opts, `${opts.action} 失敗: 承認可能な admin / owner が未設定です。`);
    return false;
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
    return false;
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
      return false;
    }
  } else {
    // delivery adapter 未 wire (= boot 直後 or shutdown 中) 想定外経路。row 作らずに patron 通知。
    log.warn('ADK approval: no delivery adapter (approval card not sent)', {
      event: 'adk.approval.no_delivery_adapter',
      approval_id: approvalId,
      action: opts.action,
    });
    await notifyPatronFallback(opts, `${opts.action} 失敗: 配信系統が未初期化です。しばらくして再度お試しください。`);
    return false;
  }

  // issue #106 Layer 1: expires_at + created_at を単一の `nowMs` から派生させて整合を保つ。
  const nowMs = Date.now();
  const expiresAt = new Date(nowMs + ADK_APPROVAL_TIMEOUT_MS).toISOString();

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
    created_at: new Date(nowMs).toISOString(),
    expires_at: expiresAt,
    agent_group_id: opts.agentGroupId,
    channel_type: target.messagingGroup.channel_type,
    platform_id: target.messagingGroup.platform_id,
    platform_message_id: platformMessageId ?? null,
    status: 'pending',
    title,
    options_json: JSON.stringify(ADK_APPROVAL_OPTIONS),
  });

  // issue #106 Layer 2: setTimeout で expiry を仕込む。timer 発火直前に admin が応答した race は
  // `expireAdkApproval` 側の `pending.has()` 早期抜けと `clearAdkApprovalTimer` の pop で防御。
  const timer = setTimeout(() => {
    if (!pending.has(approvalId)) return; // clearAdkApprovalTimer が先勝ちしたケース
    pending.delete(approvalId);
    expireAdkApproval(approvalId, 'no response').catch((err) =>
      log.error('Failed to expire ADK approval', {
        event: 'adk.approval.expire_failed',
        approval_id: approvalId,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }, ADK_APPROVAL_TIMEOUT_MS);

  pending.set(approvalId, { timer });

  log.info('ADK approval requested', {
    event: 'adk.approval.dispatch.' + opts.action,
    approval_id: approvalId,
    action: opts.action,
    approver: target.userId,
    adk_session_id: opts.adkSessionId,
    function_call_id: opts.functionCallId,
    expires_at: expiresAt,
  });
  return true;
}

/**
 * issue #106: admin が timeout 前に応答したときに、対応する expiry timer を明示的に取り除く。
 *
 * `response-handler.ts` の `adk_confirm` 分岐冒頭から呼ばれる。timer 発火直前の race を防ぐ
 * ため、`resolveAdkApproval` (実際の resume) 呼出**前**に本関数を呼ぶ設計。
 *
 * **戻り値**: `true` なら「admin 応答が expiry timer より先勝ちして claim できた」= 呼出元は
 * そのまま resume 処理に進んでよい。`false` なら「timer callback が既に pending Map から
 * 該当 entry を pop 済み (= expiry cleanup が in-flight or 完了済み)」= 呼出元は resume 処理を
 * skip すべき (二重 patron 通知防止)。
 *
 * この boolean 契約により、`response-handler.ts` は expire と admin 応答の race window
 * (expire 発火から row 削除完了までの間に admin 応答が届いた場合) で、二重処理を避けられる。
 */
export function clearAdkApprovalTimer(approvalId: string): boolean {
  const state = pending.get(approvalId);
  if (!state) return false;
  clearTimeout(state.timer);
  pending.delete(approvalId);
  return true;
}

/**
 * issue #106 Layer 2: timer 発火 or sweep 経由で pending_approvals row を「タイムアウト」処理。
 *
 * 順序: (1) row lookup → (2) status='expired' 更新 → (3) Slack card edit →
 *      (4) patron 通知 → (5) sessionService.deleteSession → (6) row delete。
 *
 * 途中の失敗は log.warn / log.error で拾って swallow (= throw しない、silent failure 撲滅)。
 * 特に (5) sessionService の失敗は Pod メモリ状態に関する話で、row は必ず (6) で消す。
 *
 * Pod 再起動 sweep 経路 (`reason === 'host restarted'`) では sessionService が空のため
 * (5) を skip する (`InMemorySessionService` は Pod プロセスメモリ上のみ)。
 */
async function expireAdkApproval(approvalId: string, reason: string): Promise<void> {
  const row = getPendingApproval(approvalId);
  if (!row) {
    log.warn('ADK approval expire: row already deleted', {
      event: 'adk.approval.expire_row_missing',
      approval_id: approvalId,
      reason,
    });
    return;
  }

  updatePendingApprovalStatus(approvalId, 'expired');
  await editAdkCardExpired(row, reason);
  await notifyPatronExpired(row, reason);
  if (reason !== 'host restarted') {
    await deleteAdkSessionSafe(row);
  }
  deletePendingApproval(approvalId);

  log.info('ADK approval expired', {
    event: 'adk.approval.expired',
    approval_id: approvalId,
    reason,
  });
}

/**
 * issue #106: Slack カードを「Expired (reason)」に edit。
 *
 * `adapterRef` (`startAdkApprovalHandler` で set) 経由。未設定 / row 情報不足 (= platform id 群
 * の 3 つが揃わない) 時は silent skip。deliver throw は warn で swallow (= row delete は完遂)。
 */
async function editAdkCardExpired(row: PendingApproval, reason: string): Promise<void> {
  if (!adapterRef || !row.platform_message_id || !row.channel_type || !row.platform_id) return;
  try {
    await adapterRef.deliver(
      row.channel_type,
      row.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        operation: 'edit',
        messageId: row.platform_message_id,
        text: `Expired (${reason})`,
      }),
    );
  } catch (err) {
    log.warn('Failed to edit expired ADK approval card', {
      event: 'adk.approval.card_edit_failed',
      approval_id: row.approval_id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * issue #106: patron に「タイムアウトしました」通知。reason で本文分岐。
 *
 * `getChannelAdapter(payload.channelType)` (= raw ChannelAdapter、3 引数 shape) を経由。
 * payload JSON parse 失敗 / adapter 不在 / deliver throw は log.warn or log.error で swallow
 * (= row delete は完遂、patron 未通知は許容 = メモリリーク優先で解消)。
 */
async function notifyPatronExpired(row: PendingApproval, reason: string): Promise<void> {
  let payload: AdkApprovalPayload;
  try {
    payload = JSON.parse(row.payload) as AdkApprovalPayload;
  } catch (err) {
    log.warn('ADK approval expire: payload parse failed, patron notification skipped', {
      event: 'adk.approval.expire_payload_parse_failed',
      approval_id: row.approval_id,
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const message =
    reason === 'host restarted'
      ? 'エラー: Pod 再起動により承認セッションが失効しました。もう一度 tool 呼出をお願いします。'
      : '承認がタイムアウトしました。もう一度お試しください。';

  const adapter = getChannelAdapter(payload.channelType);
  if (!adapter) {
    log.warn('ADK approval expire: no channel adapter for patron notification', {
      event: 'adk.approval.expire_no_adapter',
      approval_id: row.approval_id,
      channel_type: payload.channelType,
    });
    return;
  }
  try {
    const deliveryId = await adapter.deliver(payload.platformId, payload.threadId, {
      kind: 'chat',
      content: { text: message },
    });
    if (deliveryId === undefined) {
      log.warn('ADK approval expire: patron notify not delivered (adapter returned undefined)', {
        event: 'adk.approval.expire_patron_notify_not_delivered',
        approval_id: row.approval_id,
        channel_type: payload.channelType,
      });
    }
  } catch (err) {
    log.error('ADK approval expire: patron notify threw', {
      event: 'adk.approval.expire_patron_notify_threw',
      approval_id: row.approval_id,
      channel_type: payload.channelType,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * issue #106: `InMemorySessionService.deleteSession` で paused session を cleanup。
 *
 * `getSharedRunner()` は module singleton (`dispatcher.ts`)。runner 未初期化 / deleteSession
 * throw は warn で swallow (= row delete は完遂)。sweep 経路 (`reason === 'host restarted'`)
 * では呼び出し元 (`expireAdkApproval`) が本関数を skip する (Pod 再起動後は sessionService が空)。
 */
async function deleteAdkSessionSafe(row: PendingApproval): Promise<void> {
  let payload: AdkApprovalPayload;
  try {
    payload = JSON.parse(row.payload) as AdkApprovalPayload;
  } catch (err) {
    log.warn('ADK approval expire: payload parse failed, deleteSession skipped', {
      event: 'adk.approval.expire_payload_parse_failed_session',
      approval_id: row.approval_id,
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  try {
    // Lazy dynamic import で `adk-approvals ↔ dispatcher` の static 循環を閉じる (top-level
    // コメント参照)。expire 経路以外では evaluate されないため boot cost に載らない。
    const { getSharedRunner } = await import('../../adk/dispatcher.js');
    const { sessionService } = getSharedRunner();
    await sessionService.deleteSession({
      appName: BIBLIO_M4B_APP_NAME,
      userId: payload.userId,
      sessionId: payload.adkSessionId,
    });
  } catch (err) {
    log.warn('ADK approval expire: deleteSession failed', {
      event: 'adk.approval.expire_delete_session_failed',
      approval_id: row.approval_id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
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
    // Phase 4 review I1 対応: `deliveryId === undefined` 検知 (CLI 未接続時の silent 化防止、
    // dispatcher.ts:deliverFallback の C1 教訓 carry over)。
    const deliveryId = await adapter.deliver(opts.platformId, opts.threadId, {
      kind: 'chat',
      content: { text },
    });
    if (deliveryId === undefined) {
      log.warn('ADK approval fallback: adapter returned undefined (patron may not have received)', {
        event: 'adk.approval.fallback_not_delivered',
        channel_type: opts.channelType,
        action: opts.action,
        text_length: text.length,
      });
    }
  } catch (err) {
    log.error('ADK approval fallback deliver threw', {
      event: 'adk.approval.fallback_failed',
      channel_type: opts.channelType,
      action: opts.action,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * issue #106 Layer 3: 起動時 hook (`src/modules/approvals/index.ts` の
 * `onDeliveryAdapterReady` から呼び出し) で:
 *   1. delivery adapter を module state に保持 (= expiry / sweep 経路が使う)
 *   2. Pod 再起動で残った stale row を `sweepStaleAdkApprovals` で cleanup
 *
 * idempotent (`started` flag)。二重呼出でも副作用なし。
 */
export function startAdkApprovalHandler(deliveryAdapter: ChannelDeliveryAdapter): void {
  if (started) return;
  adapterRef = deliveryAdapter;

  // Sweep any rows left over from a previous process.
  sweepStaleAdkApprovals().catch((err) =>
    log.error('ADK approval sweep failed', {
      event: 'adk.approval.sweep_failed',
      err: err instanceof Error ? err.message : String(err),
    }),
  );

  started = true;
  log.info('ADK approval handler started', {
    event: 'adk.approval.handler_started',
    timeout_ms: ADK_APPROVAL_TIMEOUT_MS,
  });
}

/**
 * issue #106 Layer 3: 起動時 hook (`src/modules/approvals/index.ts` の
 * `onShutdown` から呼び出し) で:
 *   1. 生存中の expiry timer を全 clearTimeout
 *   2. pending Map を空にする
 *   3. adapterRef を null にリセット (= 次回 start まで expiry / sweep 経路無効化)
 *   4. `started` を false に戻す (= 次回 start で sweep が再度動く)
 */
export function stopAdkApprovalHandler(): void {
  for (const state of pending.values()) {
    clearTimeout(state.timer);
  }
  pending.clear();
  adapterRef = null;
  started = false;
  log.info('ADK approval handler stopped', { event: 'adk.approval.handler_stopped' });
}

/**
 * issue #106 Layer 3: Pod 再起動で残った pending_approvals row (action='adk_confirm') を
 * 「Expired (host restarted)」で edit + patron 通知 + row 削除の順で cleanup。
 *
 * `expireAdkApproval` を reason='host restarted' で呼び出すことで、通常の expiry フローを
 * 再利用しつつ内部の `deleteAdkSessionSafe` を skip する分岐に落とす (= Pod 再起動後は
 * `InMemorySessionService` が空)。
 *
 * per-row の try/catch を挟むことで、`updatePendingApprovalStatus` / `deletePendingApproval`
 * の raw DB 呼出が例外を投げても残りの row の sweep を継続する (= 「Layer 3 は起動時に
 * 確実に一掃する安全網」という契約を守る、code-review 指摘 #3 対応)。
 */
async function sweepStaleAdkApprovals(): Promise<void> {
  const rows = getPendingApprovalsByAction(ADK_CONFIRM_ACTION);
  if (rows.length === 0) return;
  log.info('Sweeping stale ADK approvals from previous process', {
    event: 'adk.approval.sweep_start',
    count: rows.length,
  });
  let failed = 0;
  for (const row of rows) {
    try {
      await expireAdkApproval(row.approval_id, 'host restarted');
    } catch (err) {
      failed++;
      log.error('ADK approval sweep: row cleanup failed, continuing with remaining rows', {
        event: 'adk.approval.sweep_row_failed',
        approval_id: row.approval_id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log.info('Swept stale ADK approvals', {
    event: 'adk.approval.sweep_done',
    count: rows.length,
    failed,
  });
}
