/**
 * Delivery action handler — `shelve_biblio`.
 *
 * agent (Claude) が `shelve_biblio` MCP ツールで outbound.db に system action を書く
 * (content: `{ action, name, category, reason }`) → delivery poll がここを呼ぶ → host で
 * `shelve()` を実行 → 棚リポへの PR URL or 失敗理由を inbound.db に書き戻し → agent が
 * patron に「PR URL: ... / 手動 merge をお願いします」 を Slack 応答する。
 *
 * inspect-action.ts / categorize-action.ts と同形 (writeBack 3 retry / fail-closed catch /
 * BIBLIO_NAME_RE)。差分は (a) `category` パラメータの validate、(b) 応答テキストの整形のみ。
 */
import { registerDeliveryAction } from '../delivery.js';
import { log } from '../log.js';
import { shelve } from './shelve.js';
import { BIBLIO_NAME_RE, writeBackMessage } from './action-helpers.js';
import { BIBLIO_CATEGORIES, type BiblioCategory, type ShelveResult } from './types.js';

/** category の合法集合 (= BiblioCategory)。`includes` で `category as BiblioCategory` を validate。 */
const VALID_CATEGORIES: readonly BiblioCategory[] = BIBLIO_CATEGORIES;

/** shelve 結果を patron 向けテキストに整形する。 */
function resultText(biblioName: string, result: ShelveResult): string {
  if (result.ok) {
    return `陳列完了: PR URL = ${result.prUrl} (branch: \`${result.branchName}\`)\n手動 merge をお願いします。`;
  }
  if (result.reason === 'already_shelved') {
    return `already shelved (key=${biblioName})。既存 PR / merge 済 entry をご確認ください。`;
  }
  return `陳列失敗 (${result.reason}): ${biblioName} — ${result.detail}`;
}

registerDeliveryAction('shelve_biblio', async (content, session, inDb) => {
  const rawName = typeof content.name === 'string' ? content.name.trim() : '';
  const rawCategory = typeof content.category === 'string' ? content.category.trim() : '';
  // reason は optional だが、空でも shelve() に渡す (commit/PR body に出る)。
  const rawReason = typeof content.reason === 'string' ? content.reason.trim() : '';

  if (!rawName) {
    log.warn('shelve_biblio missing name', { sessionId: session.id });
    await writeBackMessage(
      inDb,
      '陳列エラー (invalid_input): name が指定されていません。',
      'shelve-resp',
      'shelve_biblio',
    );
    return;
  }
  if (!BIBLIO_NAME_RE.test(rawName)) {
    log.warn('shelve_biblio invalid name', { biblioName: rawName, sessionId: session.id });
    await writeBackMessage(
      inDb,
      `陳列エラー (invalid_input): name が \`owner--name\` 形式ではありません: "${rawName}"`,
      'shelve-resp',
      'shelve_biblio',
    );
    return;
  }
  if (!rawCategory) {
    log.warn('shelve_biblio missing category', { sessionId: session.id });
    await writeBackMessage(
      inDb,
      '陳列エラー (invalid_input): category が指定されていません。',
      'shelve-resp',
      'shelve_biblio',
    );
    return;
  }
  if (!VALID_CATEGORIES.includes(rawCategory as BiblioCategory)) {
    log.warn('shelve_biblio invalid category', { category: rawCategory, sessionId: session.id });
    await writeBackMessage(
      inDb,
      `陳列エラー (invalid_category): category は biblio-dev|art|bf|ai のいずれかである必要があります: "${rawCategory}"`,
      'shelve-resp',
      'shelve_biblio',
    );
    return;
  }

  const category = rawCategory as BiblioCategory;
  const reason = rawReason || '(理由未指定)';
  log.info('shelve_biblio from agent', { biblioName: rawName, category, sessionId: session.id });

  try {
    const result = await shelve({ biblioName: rawName, category, reason });
    await writeBackMessage(inDb, resultText(rawName, result), 'shelve-resp', 'shelve_biblio');
    log.info('shelve_biblio done', {
      biblioName: rawName,
      category,
      ok: result.ok,
      prUrl: result.ok ? result.prUrl : null,
      reason: result.ok ? null : result.reason,
      sessionId: session.id,
    });
  } catch (err) {
    // shelve() は throw しない設計だが、想定外例外も握って patron に通知する (host を落とさない)。
    log.error('shelve_biblio threw', { biblioName: rawName, category, sessionId: session.id, err });
    const detail = err instanceof Error ? err.message : String(err);
    await writeBackMessage(inDb, `陳列エラー (internal): 予期しない失敗 — ${detail}`, 'shelve-resp', 'shelve_biblio');
  }
});
