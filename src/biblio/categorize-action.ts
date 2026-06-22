/**
 * Delivery action handler — `categorize_biblio`.
 *
 * agent (Claude) が `categorize_biblio` MCP ツールで outbound.db に system action を
 * 書く → delivery poll がここを呼ぶ → host で `categorize()` を実行 → 4 namespace 判定 +
 * 理由を inbound.db に chat メッセージで書き戻し (`trigger:1` = agent を起こす) →
 * agent が patron に「進めますか?」 Slack 応答する。
 *
 * inspect-action.ts と同形 (writeBack 3 retry / fail-closed catch / BIBLIO_NAME_RE)。
 * 差分は (a) 名前 validate を `owner--name` 形式に厳格化、(b) 応答テキストの整形のみ。
 */
import { registerDeliveryAction } from '../delivery.js';
import { log } from '../log.js';
import { categorize } from './categorize.js';
import { BIBLIO_NAME_RE, writeBackMessage } from './action-helpers.js';
import type { CategoryResult } from './types.js';

/** カテゴライズ結果を patron 向けの 1-2 行テキストに整形する。 */
function resultText(biblioName: string, result: CategoryResult): string {
  if (result.ok) {
    return (
      `カテゴリ判定: \`${result.category}\` (理由: ${result.reason})。\n` +
      '陳列を進めますか? (はい / biblio-art|bf|ai のいずれかで変更)'
    );
  }
  return `カテゴライズ失敗 (${result.reason}): ${biblioName} — ${result.detail}`;
}

registerDeliveryAction('categorize_biblio', async (content, session, inDb) => {
  const rawName = typeof content.name === 'string' ? content.name.trim() : '';
  const requestId = crypto.randomUUID();
  if (!rawName) {
    log.warn('categorize_biblio missing name', {
      event: 'biblio.categorize',
      outcome: 'failure',
      sessionId: session.id,
      request_id: requestId,
    });
    await writeBackMessage(
      inDb,
      'カテゴライズエラー (invalid_input): name が指定されていません。',
      'categorize-resp',
      'categorize_biblio',
    );
    return;
  }
  // path traversal 防御 + `owner--name` 形式の強制 (= categorize.ts が
  // `quarantineRoot/biblioName` を path.join するため、不正な値は弾く)。
  if (!BIBLIO_NAME_RE.test(rawName)) {
    log.warn('categorize_biblio invalid name', {
      event: 'biblio.categorize',
      outcome: 'failure',
      biblioName: rawName,
      sessionId: session.id,
      request_id: requestId,
    });
    await writeBackMessage(
      inDb,
      `カテゴライズエラー (invalid_input): name が \`owner--name\` 形式ではありません: "${rawName}"`,
      'categorize-resp',
      'categorize_biblio',
    );
    return;
  }

  log.info('categorize_biblio from agent', {
    event: 'biblio.categorize',
    biblioName: rawName,
    sessionId: session.id,
    request_id: requestId,
  });

  try {
    const result = await categorize({ biblioName: rawName }, { ctx: { requestId, sessionId: session.id } });
    await writeBackMessage(inDb, resultText(rawName, result), 'categorize-resp', 'categorize_biblio');
    log.info('categorize_biblio done', {
      event: 'biblio.categorize',
      outcome: result.ok ? 'success' : 'failure',
      biblioName: rawName,
      ok: result.ok,
      category: result.ok ? result.category : null,
      sessionId: session.id,
      request_id: requestId,
    });
  } catch (err) {
    // categorize() は throw しない設計だが、想定外例外も握って patron に通知する (host を落とさない)。
    log.error('categorize_biblio threw', {
      event: 'biblio.categorize',
      outcome: 'failure',
      biblioName: rawName,
      sessionId: session.id,
      request_id: requestId,
      err,
    });
    const detail = err instanceof Error ? err.message : String(err);
    await writeBackMessage(
      inDb,
      `カテゴライズエラー (internal): 予期しない失敗 — ${detail}`,
      'categorize-resp',
      'categorize_biblio',
    );
  }
});
