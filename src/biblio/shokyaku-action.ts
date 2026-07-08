/**
 * Delivery action handler — `shokyaku_biblio` (= 焼却: 棚から除去 + 装備源物理削除 = 再装備不可)。
 *
 * 経路:
 *   1. agent (Claude) が `shokyaku_biblio` MCP ツールで outbound.db に system action を書く
 *      (content: `{ action, name, category }`)
 *   2. delivery poll がここを呼ぶ → 入力 validate → `requestApproval('shokyaku_confirm', ...)` で
 *      admin に Slack DM カードを送る → `writeBackMessage` で「承認待ち」を patron に通知
 *   3. admin 承認後に `registerApprovalHandler('shokyaku_confirm', ...)` のコールバックが発火し、
 *      `shokyaku()` を実行 → `notify()` で patron に PR URL or 失敗理由を通知
 *
 * enkin-action.ts と同形 (= 入口 validate + HITL 承認 + writeBackMessage)。差分は action key と
 * 「焼却」テキスト、`shokyaku()` 呼び出しのみ。
 */
import { SpanStatusCode } from '@opentelemetry/api';

import { registerDeliveryAction } from '../delivery.js';
import { log } from '../log.js';
import { registerApprovalHandler, requestApproval } from '../modules/approvals/index.js';
import { shokyaku } from './shokyaku.js';
import {
  parseApprovalPayload,
  safeNotify,
  validateBiblioInput,
  withBiblioActionSpan,
  writeBackMessage,
} from './action-helpers.js';
import { BIBLIO_CATEGORIES } from './types.js';

const APPROVAL_ACTION = 'shokyaku_confirm';

registerApprovalHandler(APPROVAL_ACTION, async ({ payload, notify }) => {
  // payload parse を集約 helper に委譲 (= enkin-action.ts と逐語コピーになるのを避けるため 1 箇所に集約)。
  const { biblioName, category } = parseApprovalPayload(payload);
  // approval 後の境界 = 独立 request_id (= 申請境界とは別 trace)。
  const requestId = crypto.randomUUID();
  // 申請時の request_id を payload から取り出して biblio.originating_request_id 属性に
  // 設定する。申請 span (shokyaku_request) と本 approval span (shokyaku) は別 trace だが、
  // この属性経由でログ検索や BQ 集計により申請→承認を遡れる。OTel SpanLink は使わない
  // (= Cloud Trace UI の SpanLink 描画未確認、属性連結で十分とした)。
  const originatingRequestId =
    typeof (payload as Record<string, unknown>).originating_request_id === 'string'
      ? ((payload as Record<string, unknown>).originating_request_id as string)
      : undefined;
  await withBiblioActionSpan('shokyaku', requestId, '', async (span) => {
    if (originatingRequestId) span.setAttribute('biblio.originating_request_id', originatingRequestId);
    if (!biblioName || !BIBLIO_CATEGORIES.includes(category)) {
      log.error('shokyaku_confirm: invalid payload', {
        event: 'biblio.shokyaku',
        outcome: 'failure',
        payload,
        request_id: requestId,
      });
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'invalid approval payload' });
      span.setAttribute('biblio.outcome', 'failure');
      safeNotify(notify, `焼却エラー: 承認 payload が壊れています (biblioName=${biblioName}, category=${category})`, {
        action: APPROVAL_ACTION,
        biblioName,
      });
      return;
    }
    try {
      const result = await shokyaku({ biblioName, category }, { ctx: { requestId } });
      // success / 業務失敗の両 path で biblio.outcome を必ず立てる (silent failure 撲滅、
      // enkin-action.ts と同流儀)。
      span.setAttribute('biblio.outcome', result.ok ? 'success' : 'failure');
      if (result.ok) {
        // cleanup 成否で通知文言を切替 (= 「物理削除しました」と無条件通知で焼却の意味を
        // 誤認させない、silent failure 撲滅)。
        // cleanupWarning は複数系統の cleanup (装備源 dir 物理削除 / session_equipped_biblios /
        // fugue_equipped_biblios) の失敗を ' / ' 連結で運ぶため、ヘッドラインを理由非依存にする
        // (= 特定系統に限定した誤ミスリード防止)。
        // 是正指示も「詳細を確認して該当箇所を個別に対処」に一般化。
        const cleanupLine = result.cleanupWarning
          ? `${biblioName} を棚から除去する draft PR を立てましたが、**装備状態のクリーンアップに一部失敗しました** ` +
            `(ログ確認要): ${result.cleanupWarning}。手動 merge + 上記詳細の該当箇所 (装備源 dir / 装備リスト DB / Fugue 装備状態 DB) を個別に対処してください。`
          : `${biblioName} を棚から除去する draft PR を立て、装備源を物理削除しました (= 再装備不可)。手動 merge をお願いします。`;
        safeNotify(notify, `焼却完了: PR URL = ${result.prUrl} (branch: \`${result.branchName}\`)\n${cleanupLine}`, {
          action: APPROVAL_ACTION,
          biblioName,
        });
        log.info('shokyaku_confirm: ok', {
          event: 'biblio.shokyaku',
          outcome: 'success',
          biblioName,
          category,
          prUrl: result.prUrl,
          cleanupWarning: result.cleanupWarning ?? null,
          request_id: requestId,
        });
      } else {
        safeNotify(notify, `焼却失敗 (${result.reason}): ${biblioName} — ${result.detail}`, {
          action: APPROVAL_ACTION,
          biblioName,
        });
        log.warn('shokyaku_confirm: shokyaku returned not ok', {
          event: 'biblio.shokyaku',
          outcome: 'failure',
          biblioName,
          category,
          reason: result.reason,
          request_id: requestId,
        });
      }
    } catch (err) {
      // span 記録は acquire-action.ts と同形 (silent failure 撲滅)。
      const errorRecord = err instanceof Error ? err : new Error(String(err));
      span.recordException(errorRecord);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorRecord.message });
      log.error('shokyaku_confirm threw', {
        event: 'biblio.shokyaku',
        outcome: 'failure',
        biblioName,
        category,
        request_id: requestId,
        err,
      });
      safeNotify(notify, `焼却エラー (internal): 予期しない失敗 — ${errorRecord.message}`, {
        action: APPROVAL_ACTION,
        biblioName,
      });
      span.setAttribute('biblio.outcome', 'failure');
    }
  });
});

registerDeliveryAction('shokyaku_biblio', async (content, session, inDb) => {
  const validated = await validateBiblioInput(content, inDb, session, 'shokyaku-resp', 'shokyaku_biblio', '焼却');
  if (!validated) return;
  const { biblioName, category } = validated;
  const requestId = crypto.randomUUID();
  await withBiblioActionSpan('shokyaku_request', requestId, session.id, async (span) => {
    log.info('shokyaku_biblio from agent', {
      event: 'biblio.shokyaku_request',
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
        title: '焼却の承認',
        question: `${biblioName} を焼却します (棚から除去 + 装備源を物理削除 = 再装備不可)。承認しますか?`,
      });
      await writeBackMessage(
        inDb,
        `焼却承認を申請しました: ${biblioName} (category=${category})。admin の応答をお待ちください。`,
        'shokyaku-resp',
        'shokyaku_biblio',
      );
      span.setAttribute('biblio.outcome', 'success');
    } catch (err) {
      // span 記録は acquire-action.ts と同形 (silent failure 撲滅)。
      const errorRecord = err instanceof Error ? err : new Error(String(err));
      span.recordException(errorRecord);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorRecord.message });
      log.error('shokyaku_biblio requestApproval threw', {
        event: 'biblio.shokyaku_request',
        outcome: 'failure',
        biblioName,
        category,
        session_id: session.id,
        request_id: requestId,
        err,
      });
      await writeBackMessage(
        inDb,
        `焼却エラー (internal): 承認申請に失敗 — ${errorRecord.message}`,
        'shokyaku-resp',
        'shokyaku_biblio',
      );
      span.setAttribute('biblio.outcome', 'failure');
    }
  });
});
