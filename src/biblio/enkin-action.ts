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
import { registerDeliveryAction } from '../delivery.js';
import { log } from '../log.js';
import { registerApprovalHandler, requestApproval } from '../modules/approvals/index.js';
import { enkin } from './enkin.js';
import { safeNotify, validateBiblioInput, writeBackMessage } from './action-helpers.js';
import { BIBLIO_CATEGORIES, type BiblioCategory } from './types.js';

/** approval handler の action key (= `requestApproval` の action と完全一致が必要)。 */
const APPROVAL_ACTION = 'enkin_confirm';

// 承認後の処理は register at module-import-time (= side-effect import で `src/index.ts` から)。
registerApprovalHandler(APPROVAL_ACTION, async ({ payload, notify }) => {
  // payload.category は型強制 + includes 検証を 1 行に統合 (= 旧実装の「string なら cast、それ
  // 以外は biblio-dev デフォルト」だと不正文字列が validation を素通しする罠を解消、
  // PR #21 silent-failure-hunter 提案)。
  const biblioName = typeof payload.biblioName === 'string' ? payload.biblioName : '';
  const category: BiblioCategory =
    typeof payload.category === 'string' && BIBLIO_CATEGORIES.includes(payload.category as BiblioCategory)
      ? (payload.category as BiblioCategory)
      : 'biblio-dev';
  // approval 後の実処理は「承認申請」とは別境界 → 独立 request_id を生成 (Plan: 各 action ごとに独立)。
  const requestId = crypto.randomUUID();
  if (!biblioName || !BIBLIO_CATEGORIES.includes(category)) {
    log.error('enkin_confirm: invalid payload', {
      event: 'biblio.enkin',
      outcome: 'failure',
      payload,
      request_id: requestId,
    });
    safeNotify(notify, `禁書エラー: 承認 payload が壊れています (biblioName=${biblioName}, category=${category})`, {
      action: APPROVAL_ACTION,
      biblioName,
    });
    return;
  }
  try {
    const result = await enkin({ biblioName, category }, { ctx: { requestId } });
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
    log.error('enkin_confirm threw', {
      event: 'biblio.enkin',
      outcome: 'failure',
      biblioName,
      category,
      request_id: requestId,
      err,
    });
    const detail = err instanceof Error ? err.message : String(err);
    safeNotify(notify, `禁書エラー (internal): 予期しない失敗 — ${detail}`, {
      action: APPROVAL_ACTION,
      biblioName,
    });
  }
});

registerDeliveryAction('enkin_biblio', async (content, session, inDb) => {
  const validated = await validateBiblioInput(content, inDb, session, 'enkin-resp', 'enkin_biblio', '禁書');
  if (!validated) return;
  const { biblioName, category } = validated;
  // 「承認申請」の境界 (= approval handler 側とは別 request_id、Plan: 各 action ごとに独立)。
  const requestId = crypto.randomUUID();
  log.info('enkin_biblio from agent', {
    event: 'biblio.enkin_request',
    biblioName,
    category,
    sessionId: session.id,
    request_id: requestId,
  });

  try {
    await requestApproval({
      session,
      agentName: 'biblio-claw',
      action: APPROVAL_ACTION,
      payload: { biblioName, category },
      title: '禁書の承認',
      question: `${biblioName} を禁書します (棚から除去、装備源は残置 = 再装備可)。承認しますか?`,
    });
    await writeBackMessage(
      inDb,
      `禁書承認を申請しました: ${biblioName} (category=${category})。admin の応答をお待ちください。`,
      'enkin-resp',
      'enkin_biblio',
    );
  } catch (err) {
    log.error('enkin_biblio requestApproval threw', {
      event: 'biblio.enkin_request',
      outcome: 'failure',
      biblioName,
      category,
      sessionId: session.id,
      request_id: requestId,
      err,
    });
    const detail = err instanceof Error ? err.message : String(err);
    await writeBackMessage(inDb, `禁書エラー (internal): 承認申請に失敗 — ${detail}`, 'enkin-resp', 'enkin_biblio');
  }
});
