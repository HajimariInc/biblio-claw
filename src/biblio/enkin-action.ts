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
import { BIBLIO_NAME_RE, safeNotify, writeBackMessage } from './action-helpers.js';
import { BIBLIO_CATEGORIES, type BiblioCategory } from './types.js';

/** category の合法集合。 */
const VALID_CATEGORIES: readonly BiblioCategory[] = BIBLIO_CATEGORIES;

/** approval handler の action key (= `requestApproval` の action と完全一致が必要)。 */
const APPROVAL_ACTION = 'enkin_confirm';

// 承認後の処理は register at module-import-time (= side-effect import で `src/index.ts` から)。
registerApprovalHandler(APPROVAL_ACTION, async ({ payload, notify }) => {
  const biblioName = typeof payload.biblioName === 'string' ? payload.biblioName : '';
  const category =
    typeof payload.category === 'string' ? (payload.category as BiblioCategory) : ('biblio-dev' as BiblioCategory);
  if (!biblioName || !VALID_CATEGORIES.includes(category)) {
    log.error('enkin_confirm: invalid payload', { payload });
    safeNotify(notify, `禁書エラー: 承認 payload が壊れています (biblioName=${biblioName}, category=${category})`, {
      action: APPROVAL_ACTION,
      biblioName,
    });
    return;
  }
  try {
    const result = await enkin({ biblioName, category });
    if (result.ok) {
      safeNotify(
        notify,
        `禁書完了: PR URL = ${result.prUrl} (branch: \`${result.branchName}\`)\n` +
          `${biblioName} を棚から除去する draft PR を立てました。装備源は残置 (= 再装備可)。手動 merge をお願いします。`,
        { action: APPROVAL_ACTION, biblioName },
      );
      log.info('enkin_confirm: ok', { biblioName, category, prUrl: result.prUrl });
    } else {
      safeNotify(notify, `禁書失敗 (${result.reason}): ${biblioName} — ${result.detail}`, {
        action: APPROVAL_ACTION,
        biblioName,
      });
      log.warn('enkin_confirm: enkin returned not ok', { biblioName, category, reason: result.reason });
    }
  } catch (err) {
    // enkin() は throw しない設計だが、想定外例外も握って patron に通知する (host を落とさない)。
    log.error('enkin_confirm threw', { biblioName, category, err });
    const detail = err instanceof Error ? err.message : String(err);
    safeNotify(notify, `禁書エラー (internal): 予期しない失敗 — ${detail}`, {
      action: APPROVAL_ACTION,
      biblioName,
    });
  }
});

registerDeliveryAction('enkin_biblio', async (content, session, inDb) => {
  const rawName = typeof content.name === 'string' ? content.name.trim() : '';
  const rawCategory = typeof content.category === 'string' ? content.category.trim() : '';

  if (!rawName) {
    log.warn('enkin_biblio missing name', { sessionId: session.id });
    await writeBackMessage(
      inDb,
      '禁書エラー (invalid_input): name が指定されていません。',
      'enkin-resp',
      'enkin_biblio',
    );
    return;
  }
  if (!BIBLIO_NAME_RE.test(rawName)) {
    log.warn('enkin_biblio invalid name', { biblioName: rawName, sessionId: session.id });
    await writeBackMessage(
      inDb,
      `禁書エラー (invalid_input): name が \`owner--name\` 形式ではありません: "${rawName}"`,
      'enkin-resp',
      'enkin_biblio',
    );
    return;
  }
  if (!rawCategory) {
    log.warn('enkin_biblio missing category', { sessionId: session.id });
    await writeBackMessage(
      inDb,
      '禁書エラー (invalid_input): category が指定されていません。',
      'enkin-resp',
      'enkin_biblio',
    );
    return;
  }
  if (!VALID_CATEGORIES.includes(rawCategory as BiblioCategory)) {
    log.warn('enkin_biblio invalid category', { category: rawCategory, sessionId: session.id });
    await writeBackMessage(
      inDb,
      `禁書エラー (invalid_category): category は biblio-dev|art|bf|ai のいずれかである必要があります: "${rawCategory}"`,
      'enkin-resp',
      'enkin_biblio',
    );
    return;
  }

  const category = rawCategory as BiblioCategory;
  log.info('enkin_biblio from agent', { biblioName: rawName, category, sessionId: session.id });

  try {
    await requestApproval({
      session,
      agentName: 'biblio-claw',
      action: APPROVAL_ACTION,
      payload: { biblioName: rawName, category },
      title: '禁書の承認',
      question: `${rawName} を禁書します (棚から除去、装備源は残置 = 再装備可)。承認しますか?`,
    });
    await writeBackMessage(
      inDb,
      `禁書承認を申請しました: ${rawName} (category=${category})。admin の応答をお待ちください。`,
      'enkin-resp',
      'enkin_biblio',
    );
  } catch (err) {
    log.error('enkin_biblio requestApproval threw', { biblioName: rawName, category, sessionId: session.id, err });
    const detail = err instanceof Error ? err.message : String(err);
    await writeBackMessage(inDb, `禁書エラー (internal): 承認申請に失敗 — ${detail}`, 'enkin-resp', 'enkin_biblio');
  }
});
