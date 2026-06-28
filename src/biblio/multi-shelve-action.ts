/**
 * Delivery action handler — `shelve_biblio_multi` (Phase 4 multi-category-shelve).
 *
 * agent (Claude) が `shelve_biblio_multi` MCP ツールで outbound.db に system action を
 * 書く (content: `{ action, items: [{name, category, reason}, ...] }`) → delivery poll が
 * ここを呼ぶ → host で `shelveMulti()` を実行 → N 件の biblio を 1 PR にまとめた結果を
 * inbound.db に書き戻す → agent が patron に「PR URL: ... / 内訳: ... / 手動 merge を」を
 * Slack 応答する。
 *
 * shelve-action.ts と同形 (writeBack 3 retry / fail-closed catch)。差分は items 配列の
 * per-item validation (= BIBLIO_NAME_RE + BIBLIO_CATEGORIES) を delivery action 入口で
 * 行う点のみ (validateBiblioInput は単一 name+category 想定のため再利用しない)。
 */
import { SpanStatusCode } from '@opentelemetry/api';

import { registerDeliveryAction } from '../delivery.js';
import { log } from '../log.js';
import { BIBLIO_NAME_RE, withBiblioActionSpan, writeBackMessage } from './action-helpers.js';
import { shelveMulti } from './shelve.js';
import { BIBLIO_CATEGORIES, type BiblioCategory, type MultiShelveItem, type MultiShelveResult } from './types.js';

const RESP_PREFIX = 'shelve-multi-resp';
const ACTION_NAME = 'shelve_biblio_multi';

/** shelveMulti 結果を patron 向けテキストに整形する。 */
function resultText(result: MultiShelveResult): string {
  if (result.ok) {
    const list = result.items.map((it) => `  - \`${it.biblioName}\` → \`${it.category}\``).join('\n');
    return (
      `陳列完了 (${result.items.length} 件 / 1 PR): ${result.prUrl}\n` +
      `branch: \`${result.branchName}\`\n` +
      `内訳:\n${list}\n` +
      `手動 merge をお願いします。`
    );
  }
  return `陳列失敗 (${result.reason}): ${result.detail}`;
}

registerDeliveryAction(ACTION_NAME, async (content, session, inDb) => {
  // Phase 2: requestId を生成 (= 他 8 handler との対称化、shelve-action と同流儀)
  const requestId = crypto.randomUUID();
  await withBiblioActionSpan('shelve_multi', requestId, session.id, async (span) => {
    // 入口 validate: items が配列で 1 件以上、各 item に name (BIBLIO_NAME_RE 通過) + category
    // (BIBLIO_CATEGORIES 通過) が揃っていること。reason は optional (空でも進める)。
    const rawItems = (content as { items?: unknown }).items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      log.warn('shelve_biblio_multi: empty/invalid items', {
        session_id: session.id,
        request_id: requestId,
        totalItems: Array.isArray(rawItems) ? rawItems.length : 'not-array',
      });
      await writeBackMessage(
        inDb,
        '陳列エラー (invalid_input): items 配列が空 or 未指定です (1 件以上の {name, category, reason} を含めてください)。',
        RESP_PREFIX,
        ACTION_NAME,
      );
      return;
    }

    const items: MultiShelveItem[] = [];
    for (const [i, raw] of rawItems.entries()) {
      if (typeof raw !== 'object' || raw === null) {
        log.warn('shelve_biblio_multi: invalid item shape', {
          index: i,
          totalItems: rawItems.length,
          session_id: session.id,
          request_id: requestId,
        });
        await writeBackMessage(
          inDb,
          `陳列エラー (invalid_input): items[${i}] が object ではありません。`,
          RESP_PREFIX,
          ACTION_NAME,
        );
        return;
      }
      const obj = raw as Record<string, unknown>;
      const name = typeof obj.name === 'string' ? obj.name.trim() : '';
      const category = typeof obj.category === 'string' ? obj.category.trim() : '';
      const rawReason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
      const reason = rawReason || '(理由未指定)';

      if (!name) {
        log.warn('shelve_biblio_multi: missing name', {
          index: i,
          totalItems: rawItems.length,
          session_id: session.id,
          request_id: requestId,
        });
        await writeBackMessage(
          inDb,
          `陳列エラー (invalid_input): items[${i}].name が指定されていません。`,
          RESP_PREFIX,
          ACTION_NAME,
        );
        return;
      }
      if (!BIBLIO_NAME_RE.test(name)) {
        log.warn('shelve_biblio_multi: invalid name', {
          index: i,
          totalItems: rawItems.length,
          name,
          session_id: session.id,
          request_id: requestId,
        });
        await writeBackMessage(
          inDb,
          `陳列エラー (invalid_input): items[${i}].name が \`owner--name\` または \`owner--repo--skill\` 形式ではありません: "${name}"`,
          RESP_PREFIX,
          ACTION_NAME,
        );
        return;
      }
      if (!category) {
        log.warn('shelve_biblio_multi: missing category', {
          index: i,
          totalItems: rawItems.length,
          session_id: session.id,
          request_id: requestId,
        });
        await writeBackMessage(
          inDb,
          `陳列エラー (invalid_input): items[${i}].category が指定されていません。`,
          RESP_PREFIX,
          ACTION_NAME,
        );
        return;
      }
      if (!BIBLIO_CATEGORIES.includes(category as BiblioCategory)) {
        log.warn('shelve_biblio_multi: invalid category', {
          index: i,
          totalItems: rawItems.length,
          category,
          session_id: session.id,
          request_id: requestId,
        });
        await writeBackMessage(
          inDb,
          `陳列エラー (invalid_category): items[${i}].category は ${BIBLIO_CATEGORIES.join('|')} のいずれかである必要があります: "${category}"`,
          RESP_PREFIX,
          ACTION_NAME,
        );
        return;
      }
      items.push({ biblioName: name, category: category as BiblioCategory, reason });
    }

    log.info('shelve_biblio_multi from agent', {
      count: items.length,
      items: items.map((it) => ({ name: it.biblioName, category: it.category })),
      session_id: session.id,
      request_id: requestId,
    });

    try {
      const result = await shelveMulti(items);
      await writeBackMessage(inDb, resultText(result), RESP_PREFIX, ACTION_NAME);
      log.info('shelve_biblio_multi done', {
        count: items.length,
        ok: result.ok,
        prUrl: result.ok ? result.prUrl : null,
        reason: result.ok ? null : result.reason,
        session_id: session.id,
        request_id: requestId,
      });
      span.setAttribute('biblio.outcome', result.ok ? 'success' : 'failure');
    } catch (err) {
      // shelveMulti() は throw しない設計だが、想定外例外も握って patron に通知する (host を落とさない)。
      // span 記録は PR #78 review-agents I1 (= acquire-action.ts と同形)。
      const errorRecord = err instanceof Error ? err : new Error(String(err));
      span.recordException(errorRecord);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorRecord.message });
      log.error('shelve_biblio_multi threw', {
        count: items.length,
        session_id: session.id,
        request_id: requestId,
        err,
      });
      await writeBackMessage(
        inDb,
        `陳列エラー (internal): 予期しない失敗 — ${errorRecord.message}`,
        RESP_PREFIX,
        ACTION_NAME,
      );
      span.setAttribute('biblio.outcome', 'failure');
    }
  });
});
