/**
 * notify-only admin DM (M4-F Phase 2 gate in-secure 3 点セットの (1) 通知経路)。
 *
 * `requestAdkApproval` (`adk-approvals.ts`) や `requestApproval` (`primitive.ts`) と違い:
 *   - `pending_approvals` row は作らない (承認要求ではない、fire-and-forget 通知)
 *   - resume / handler dispatch も無い (admin 押下 UI 不要、通知素の chat)
 *   - `pickApprover` + `pickApprovalDelivery` は流用 (admin 選定は既存 pattern を継承)
 *
 * **In-memory debounce**: 同一 admin userId への連続通知を `GATE_ADMIN_NOTIFY_DEBOUNCE_MS`
 * (既定 3000ms) window で 1 件に抑制する (in-secure attack 継続時の admin DM spam 防止)。
 * Map<userId, lastSentAt> は module scope に保持、プロセス再起動で消失する (稀ケース、runbook 罠 5 に明記)。
 *
 * throw しない契約: 呼出側 (router / fugue-http の in-secure 経路) は本関数の失敗で
 * patron 応答経路を止めない = 全 error 経路で return string を返す (`'sent'` / `'no_approver'` /
 * `'no_delivery'` / `'deliver_failed'` / `'debounced'`)。
 */
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { isStubDeliveryByMg } from '../../delivery.js';
import { log } from '../../log.js';

import { pickApprover, pickApprovalDelivery } from './primitive.js';

/** debounce 用の in-memory Map (key=userId, value=lastSentAt ms epoch)。 */
const debounceMap = new Map<string, number>();

/** debounce window の env 3 層 fallback (arg 経由の override は現状不要、runbook で env 統一)。 */
const DEBOUNCE_MS = (() => {
  const raw = process.env.GATE_ADMIN_NOTIFY_DEBOUNCE_MS;
  if (raw === undefined || raw === '') return 3000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    log.warn('GATE_ADMIN_NOTIFY_DEBOUNCE_MS is invalid, falling back to default', {
      event: 'gate.admin_notify.debounce_config_invalid',
      raw,
      default_ms: 3000,
    });
    return 3000;
  }
  return parsed;
})();

/** notify-admin の入力。channelType は Fugue 経由等での admin 通知 channel 選定に使う。 */
export interface NotifyAdminOptions {
  /** approver 選定時に origin channel と一致する DM を優先するためのヒント (`primitive.ts:pickApprovalDelivery`)。 */
  channelType: string;
  /** admin 選定の scope (agent group 単位の scoped admin → global admin → owner の順)。null で global 相当。 */
  agentGroupId: string | null;
  /** DM 本文の header 相当 (例: `'gate.blocked'`)。日本語 or 英語混在許容。 */
  subject: string;
  /** DM 本文 (改行含む詳細情報)。secret を含まないよう呼出側で truncate 済想定。 */
  body: string;
  /**
   * issue #155 案 B 対応: patron 発話の event context を optional で渡す。verify 経路で
   * `--stub-outbound` によって登録された 2-tuple key (channel_type + platform_id) にマッチ
   * する場合、admin DM の実発火を silent skip する。production 経路は undefined で挙動不変。
   */
  sourceEvent?: {
    channelType: string;
    platformId: string;
  };
}

/**
 * notify-only admin DM の状態遷移:
 *   - `'sent'`         — Slack DM (or 対称 channel DM) 送信成功
 *   - `'no_approver'`  — pickApprover 結果が空 (admin/owner 不在)
 *   - `'no_delivery'`  — pickApprovalDelivery が null (DM 経路解決不能)
 *   - `'deliver_failed'` — adapter.deliver throw (log.warn 発火)
 *   - `'debounced'`   — 直近 DEBOUNCE_MS 内に同 admin へ送信済で spam 抑制
 */
export type NotifyAdminResult = 'sent' | 'no_approver' | 'no_delivery' | 'deliver_failed' | 'debounced';

/**
 * `NotifyAdminOptions` を受け取り admin DM に **通知素の chat** を送る。
 *
 * 3 点セットの (1)。承認要求ではない (pending_approvals 未作成 / resume 経路不在)。
 *
 * @returns 状態遷移 (`'sent'` / `'no_approver'` / `'no_delivery'` / `'deliver_failed'` / `'debounced'`)
 */
export async function notifyAdmin(opts: NotifyAdminOptions): Promise<NotifyAdminResult> {
  // I15 対応: `pickApprover` (DB クエリ) + `pickApprovalDelivery` (ensureUserDm → openDM API
  // 呼出) は元々 try/catch の外にあり、DB error / network 障害で throw していた。
  // 「throw しない契約」を実装で成立させるため全体を包む (呼出側 router / fugue-http の
  // `void ... .catch(...)` は保険として残るが、本関数側で contract を先に完成させる)。
  try {
    const approvers = pickApprover(opts.agentGroupId);
    if (approvers.length === 0) {
      log.warn('notifyAdmin: no eligible approver', {
        event: 'notify.admin.no_approver',
        agent_group_id: opts.agentGroupId,
        subject: opts.subject,
      });
      return 'no_approver';
    }
    const target = await pickApprovalDelivery(approvers, opts.channelType);
    if (!target) {
      log.warn('notifyAdmin: no DM channel for any approver', {
        event: 'notify.admin.no_delivery',
        agent_group_id: opts.agentGroupId,
        subject: opts.subject,
        approvers,
      });
      return 'no_delivery';
    }
    // debounce check (userId 単位)
    const now = Date.now();
    const lastSent = debounceMap.get(target.userId);
    if (lastSent !== undefined && now - lastSent < DEBOUNCE_MS) {
      log.debug('notifyAdmin: debounced (recent notification exists)', {
        event: 'notify.admin.debounced',
        user_id: target.userId,
        subject: opts.subject,
        last_sent_ms_ago: now - lastSent,
        debounce_ms: DEBOUNCE_MS,
      });
      return 'debounced';
    }
    // I3 対応: debounceMap.set はここでは呼ばず、配信成功後 (`return 'sent'` 直前) に移動。
    // 実配信の前に「送信済」と記録すると、no_adapter / deliver throw で失敗しても
    // 後続 window 内の legitimate 通知が silent に握りつぶされる問題があった。
    const adapter = getChannelAdapter(target.messagingGroup.channel_type);
    if (!adapter) {
      log.warn('notifyAdmin: no channel adapter for target channel_type', {
        event: 'notify.admin.no_adapter',
        channel_type: target.messagingGroup.channel_type,
      });
      return 'deliver_failed';
    }
    // issue #155 案 B 対応: patron event が stub 対象なら admin DM 発火を skip。
    // key は **patron 側 event** の (channel + platform) で判定 (admin 側 mg ではなく)。
    if (opts.sourceEvent && isStubDeliveryByMg(opts.sourceEvent.channelType, opts.sourceEvent.platformId)) {
      log.info('notifyAdmin: stubbed by verify path', {
        event: 'notify.admin.stubbed',
        user_id: target.userId,
        subject: opts.subject,
        source_channel: opts.sourceEvent.channelType,
        source_platform: opts.sourceEvent.platformId,
      });
      // debounce Map への書き込みは skip (verify 経路の実行を production の debounce state に
      // 汚染残置させない)。
      return 'sent';
    }
    try {
      await adapter.deliver(target.messagingGroup.platform_id, null, {
        kind: 'chat',
        content: { text: `[${opts.subject}]\n${opts.body}` },
      });
    } catch (err) {
      log.warn('notifyAdmin: deliver failed', {
        event: 'notify.admin.deliver_failed',
        user_id: target.userId,
        channel_type: target.messagingGroup.channel_type,
        subject: opts.subject,
        err: err instanceof Error ? err.message : String(err),
      });
      return 'deliver_failed';
    }
    // 配信が成功した時点で初めて debounce を記録 (I3)
    debounceMap.set(target.userId, now);
    log.info('notifyAdmin: sent', {
      event: 'notify.admin.sent',
      user_id: target.userId,
      channel_type: target.messagingGroup.channel_type,
      subject: opts.subject,
    });
    return 'sent';
  } catch (err) {
    // I15: pickApprover / pickApprovalDelivery が throw した稀ケース (DB down / network 障害 /
    // openDM API failure 等)。log で観測しつつ 'deliver_failed' として呼出側に伝える
    // (呼出側は結果値を見て observability を追加できる)。
    log.warn('notifyAdmin: unexpected throw in approver resolution', {
      event: 'notify.admin.unexpected_throw',
      agent_group_id: opts.agentGroupId,
      subject: opts.subject,
      err: err instanceof Error ? err.message : String(err),
    });
    return 'deliver_failed';
  }
}

/** test で debounce map を clear するための helper (module scope 変数への直接アクセスを避ける)。 */
export function _resetDebounceMap(): void {
  debounceMap.clear();
}
