/**
 * Delivery action handler — `enkin_biblio` (= 禁書: 棚から除去 + 装備源残置 = 再装備可)。
 *
 * 経路:
 *   1. agent (Claude) が `enkin_biblio` MCP ツールで outbound.db に system action を書く
 *      (content: `{ action, name, category }`)
 *   2. delivery poll がここを呼ぶ → 入力 validate → `requestApproval('enkin_confirm', ...)` で
 *      admin (DEN) に Slack DM カードを送る → `writeBackMessage` で「承認待ち」を patron に通知
 *   3. admin 承認後に `registerApprovalHandler('enkin_confirm', ...)` のコールバックが発火し、
 *      `enkin()` を実行 → `notify()` で patron に PR URL or 失敗理由を通知
 *
 * shelve-action.ts と同形 (= 入口 validate + try/catch + writeBackMessage)。差分は HITL approval を
 * 挟む点と、`enkin()` の実行を approval handler 内に移す点のみ。
 */
import { SpanStatusCode } from '@opentelemetry/api';

import { registerDeliveryAction } from '../delivery.js';
import { log } from '../log.js';
import { registerApprovalHandler, requestApproval } from '../modules/approvals/index.js';
import { enkin } from './enkin.js';
import {
  parseApprovalPayload,
  safeNotify,
  validateBiblioInput,
  withBiblioActionSpan,
  writeBackMessage,
} from './action-helpers.js';
import { BIBLIO_CATEGORIES } from './types.js';

/** approval handler の action key (= `requestApproval` の action と完全一致が必要)。 */
const APPROVAL_ACTION = 'enkin_confirm';

// 承認後の処理は register at module-import-time (= side-effect import で `src/index.ts` から)。
registerApprovalHandler(APPROVAL_ACTION, async ({ payload, notify }) => {
  // payload.biblioName + category の型強制 + includes 検証を集約 helper に委譲
  // (= PR #37 code-simplifier S2、shokyaku-action.ts と逐語コピー解消)。
  const { biblioName, category } = parseApprovalPayload(payload);
  // approval 後の実処理は「承認申請」とは別境界 → 独立 request_id を生成。
  const requestId = crypto.randomUUID();
  // 申請時の request_id を payload から取り出して biblio.originating_request_id 属性に
  // 設定する。申請 span (enkin_request) と本 approval span (enkin) は別 trace だが、
  // この属性経由でログ検索や BQ 集計により申請→承認を遡れる。OTel SpanLink は使わない
  // (= Cloud Trace UI の SpanLink 描画未確認、属性連結で十分とした)。
  const originatingRequestId =
    typeof (payload as Record<string, unknown>).originating_request_id === 'string'
      ? ((payload as Record<string, unknown>).originating_request_id as string)
      : undefined;
  await withBiblioActionSpan('enkin', requestId, '', async (span) => {
    if (originatingRequestId) span.setAttribute('biblio.originating_request_id', originatingRequestId);
    if (!biblioName || !BIBLIO_CATEGORIES.includes(category)) {
      log.error('enkin_confirm: invalid payload', {
        event: 'biblio.enkin',
        outcome: 'failure',
        payload,
        request_id: requestId,
      });
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'invalid approval payload' });
      span.setAttribute('biblio.outcome', 'failure');
      safeNotify(notify, `禁書エラー: 承認 payload が壊れています (biblioName=${biblioName}, category=${category})`, {
        action: APPROVAL_ACTION,
        biblioName,
      });
      return;
    }
    try {
      const result = await enkin({ biblioName, category }, { ctx: { requestId } });
      // PR #78 review-agents I2: success / 業務失敗の両 path で biblio.outcome を必ず立てる
      // (= 旧実装は catch のみで設定していたため、HITL 承認 = 本番多数派オペレーションが
      // BQ の `WHERE attributes['biblio.outcome']='success'` から消えていた)。
      span.setAttribute('biblio.outcome', result.ok ? 'success' : 'failure');
      if (result.ok) {
        safeNotify(
          notify,
          `禁書完了: PR URL = ${result.prUrl} (branch: \`${result.branchName}\`)\n` +
            `${biblioName} を棚から除去する draft PR を立てました。装備源は残置 (= 再装備可)。手動 merge をお願いします。`,
          { action: APPROVAL_ACTION, biblioName },
        );
        log.info('enkin_confirm: ok', {
          event: 'biblio.enkin',
          outcome: 'success',
          biblioName,
          category,
          prUrl: result.prUrl,
          request_id: requestId,
        });
      } else {
        safeNotify(notify, `禁書失敗 (${result.reason}): ${biblioName} — ${result.detail}`, {
          action: APPROVAL_ACTION,
          biblioName,
        });
        log.warn('enkin_confirm: enkin returned not ok', {
          event: 'biblio.enkin',
          outcome: 'failure',
          biblioName,
          category,
          reason: result.reason,
          request_id: requestId,
        });
      }
    } catch (err) {
      // enkin() は throw しない設計だが、想定外例外も握って patron に通知する (host を落とさない)。
      // span 記録は PR #78 review-agents I1 (= acquire-action.ts と同形)。
      const errorRecord = err instanceof Error ? err : new Error(String(err));
      span.recordException(errorRecord);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorRecord.message });
      log.error('enkin_confirm threw', {
        event: 'biblio.enkin',
        outcome: 'failure',
        biblioName,
        category,
        request_id: requestId,
        err,
      });
      safeNotify(notify, `禁書エラー (internal): 予期しない失敗 — ${errorRecord.message}`, {
        action: APPROVAL_ACTION,
        biblioName,
      });
      span.setAttribute('biblio.outcome', 'failure');
    }
  });
});

registerDeliveryAction('enkin_biblio', async (content, session, inDb) => {
  const validated = await validateBiblioInput(content, inDb, session, 'enkin-resp', 'enkin_biblio', '禁書');
  if (!validated) return;
  const { biblioName, category } = validated;
  // 「承認申請」の境界 (= approval handler 側とは別 request_id)。
  const requestId = crypto.randomUUID();
  await withBiblioActionSpan('enkin_request', requestId, session.id, async (span) => {
    log.info('enkin_biblio from agent', {
      event: 'biblio.enkin_request',
      biblioName,
      category,
      session_id: session.id,
      request_id: requestId,
    });

    try {
      await requestApproval({
        session,
        agentName: 'biblio-claw',
        action: APPROVAL_ACTION,
        payload: { biblioName, category, originating_request_id: requestId },
        title: '禁書の承認',
        question: `${biblioName} を禁書します (棚から除去、装備源は残置 = 再装備可)。承認しますか?`,
      });
      await writeBackMessage(
        inDb,
        `禁書承認を申請しました: ${biblioName} (category=${category})。admin の応答をお待ちください。`,
        'enkin-resp',
        'enkin_biblio',
      );
      span.setAttribute('biblio.outcome', 'success');
    } catch (err) {
      // span 記録は PR #78 review-agents I1 (= acquire-action.ts と同形)。
      const errorRecord = err instanceof Error ? err : new Error(String(err));
      span.recordException(errorRecord);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorRecord.message });
      log.error('enkin_biblio requestApproval threw', {
        event: 'biblio.enkin_request',
        outcome: 'failure',
        biblioName,
        category,
        session_id: session.id,
        request_id: requestId,
        err,
      });
      await writeBackMessage(
        inDb,
        `禁書エラー (internal): 承認申請に失敗 — ${errorRecord.message}`,
        'enkin-resp',
        'enkin_biblio',
      );
      span.setAttribute('biblio.outcome', 'failure');
    }
  });
});
