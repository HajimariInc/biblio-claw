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
import { validateBiblioInput, writeBackMessage } from './action-helpers.js';
import type { ShelveResult } from './types.js';

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
  // validate ブロックは action-helpers.ts の validateBiblioInput に集約 (= enkin/shokyaku/shelve
  // で 40 行 × 3 ファイル重複していたものを 1 箇所に、PR #21 code-simplifier 推奨)。
  const validated = await validateBiblioInput(content, inDb, session, 'shelve-resp', 'shelve_biblio', '陳列');
  if (!validated) return;
  const { biblioName, category } = validated;
  // reason は optional だが、空でも shelve() に渡す (commit/PR body に出る)。
  const rawReason = typeof content.reason === 'string' ? content.reason.trim() : '';
  const reason = rawReason || '(理由未指定)';
  // request_id は patron 依頼 1 件 (= action handler 1 回) の境界 = 内部の ghFetch × N に伝搬し
  // BigQuery で串刺し集計するための識別子。crypto.randomUUID は Node 19+ / Bun 標準 (= dep ゼロ)。
  const requestId = crypto.randomUUID();
  log.info('shelve_biblio from agent', {
    event: 'biblio.shelve',
    biblioName,
    category,
    sessionId: session.id,
    request_id: requestId,
  });

  try {
    const result = await shelve({ biblioName, category, reason }, { ctx: { requestId, sessionId: session.id } });
    await writeBackMessage(inDb, resultText(biblioName, result), 'shelve-resp', 'shelve_biblio');
    log.info('shelve_biblio done', {
      event: 'biblio.shelve',
      outcome: result.ok ? 'success' : 'failure',
      biblioName,
      category,
      ok: result.ok,
      prUrl: result.ok ? result.prUrl : null,
      reason: result.ok ? null : result.reason,
      sessionId: session.id,
      request_id: requestId,
    });
  } catch (err) {
    // shelve() は throw しない設計だが、想定外例外も握って patron に通知する (host を落とさない)。
    log.error('shelve_biblio threw', {
      event: 'biblio.shelve',
      outcome: 'failure',
      biblioName,
      category,
      sessionId: session.id,
      request_id: requestId,
      err,
    });
    const detail = err instanceof Error ? err.message : String(err);
    await writeBackMessage(inDb, `陳列エラー (internal): 予期しない失敗 — ${detail}`, 'shelve-resp', 'shelve_biblio');
  }
});
