/**
 * Delivery action handler — `shokyaku_biblio` (= 焼却: 棚から除去 + 装備源物理削除 = 再装備不可)。
 *
 * 経路:
 *   1. agent (Claude) が `shokyaku_biblio` MCP ツールで outbound.db に system action を書く
 *      (content: `{ action, name, category }`)
 *   2. delivery poll がここを呼ぶ → 入力 validate → `requestApproval('shokyaku_confirm', ...)` で
 *      admin (DEN) に Slack DM カードを送る → `writeBackMessage` で「承認待ち」を patron に通知
 *   3. admin 承認後に `registerApprovalHandler('shokyaku_confirm', ...)` のコールバックが発火し、
 *      `shokyaku()` を実行 → `notify()` で patron に PR URL or 失敗理由を通知
 *
 * enkin-action.ts と同形 (= 入口 validate + HITL 承認 + writeBackMessage)。差分は action key と
 * 「焼却」テキスト、`shokyaku()` 呼び出しのみ。
 */
import { registerDeliveryAction } from '../delivery.js';
import { log } from '../log.js';
import { registerApprovalHandler, requestApproval } from '../modules/approvals/index.js';
import { shokyaku } from './shokyaku.js';
import { parseApprovalPayload, safeNotify, validateBiblioInput, writeBackMessage } from './action-helpers.js';
import { BIBLIO_CATEGORIES } from './types.js';

const APPROVAL_ACTION = 'shokyaku_confirm';

registerApprovalHandler(APPROVAL_ACTION, async ({ payload, notify }) => {
  // payload parse を集約 helper に委譲 (= PR #37 code-simplifier S2、enkin-action.ts と逐語コピー解消)。
  const { biblioName, category } = parseApprovalPayload(payload);
  // approval 後の境界 = 独立 request_id (= 申請境界とは別 trace)。
  const requestId = crypto.randomUUID();
  if (!biblioName || !BIBLIO_CATEGORIES.includes(category)) {
    log.error('shokyaku_confirm: invalid payload', {
      event: 'biblio.shokyaku',
      outcome: 'failure',
      payload,
      request_id: requestId,
    });
    safeNotify(notify, `焼却エラー: 承認 payload が壊れています (biblioName=${biblioName}, category=${category})`, {
      action: APPROVAL_ACTION,
      biblioName,
    });
    return;
  }
  try {
    const result = await shokyaku({ biblioName, category }, { ctx: { requestId } });
    if (result.ok) {
      // cleanup 成否で通知文言を切替 (= 「物理削除しました」と無条件通知で焼却の意味を誤認させない、
      // PR #15 silent-failure-hunter HIGH 2 対応)。
      const cleanupLine = result.cleanupWarning
        ? `${biblioName} を棚から除去する draft PR を立てましたが、**装備源の物理削除に失敗しました** ` +
          `(ログ確認要): ${result.cleanupWarning}。手動 merge + 装備源 dir の手動削除をお願いします。`
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
    log.error('shokyaku_confirm threw', {
      event: 'biblio.shokyaku',
      outcome: 'failure',
      biblioName,
      category,
      request_id: requestId,
      err,
    });
    const detail = err instanceof Error ? err.message : String(err);
    safeNotify(notify, `焼却エラー (internal): 予期しない失敗 — ${detail}`, {
      action: APPROVAL_ACTION,
      biblioName,
    });
  }
});

registerDeliveryAction('shokyaku_biblio', async (content, session, inDb) => {
  const validated = await validateBiblioInput(content, inDb, session, 'shokyaku-resp', 'shokyaku_biblio', '焼却');
  if (!validated) return;
  const { biblioName, category } = validated;
  const requestId = crypto.randomUUID();
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
      payload: { biblioName, category },
      title: '焼却の承認',
      question: `${biblioName} を焼却します (棚から除去 + 装備源を物理削除 = 再装備不可)。承認しますか?`,
    });
    await writeBackMessage(
      inDb,
      `焼却承認を申請しました: ${biblioName} (category=${category})。admin の応答をお待ちください。`,
      'shokyaku-resp',
      'shokyaku_biblio',
    );
  } catch (err) {
    log.error('shokyaku_biblio requestApproval threw', {
      event: 'biblio.shokyaku_request',
      outcome: 'failure',
      biblioName,
      category,
      session_id: session.id,
      request_id: requestId,
      err,
    });
    const detail = err instanceof Error ? err.message : String(err);
    await writeBackMessage(
      inDb,
      `焼却エラー (internal): 承認申請に失敗 — ${detail}`,
      'shokyaku-resp',
      'shokyaku_biblio',
    );
  }
});
