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
import { setTimeout as sleep } from 'node:timers/promises';

import type Database from 'better-sqlite3';

import { registerDeliveryAction } from '../delivery.js';
import { insertMessage } from '../db/session-db.js';
import { log } from '../log.js';
import { shelve } from './shelve.js';
import { BIBLIO_CATEGORIES, type BiblioCategory, type ShelveResult } from './types.js';

/** Phase 3 以降の biblioName 形式 (`<owner>--<name>`)。categorize-action.ts と同値。 */
const BIBLIO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*--[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** category の合法集合 (= BiblioCategory)。`includes` で `category as BiblioCategory` を validate。 */
const VALID_CATEGORIES: readonly BiblioCategory[] = BIBLIO_CATEGORIES;

/** writeBack の SQLITE_BUSY 等への小規模リトライ回数 (1 + 2 = 計 3 attempts、inspect-action.ts と同値)。 */
const WRITEBACK_MAX_RETRIES = 2;
/** 各リトライ前に sleep する基底 (ms)。 */
const WRITEBACK_RETRY_BASE_MS = 100;

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

/**
 * chat メッセージを inbound.db に書き戻し agent を起こす。
 * 失敗時は patron 通知消失を error ログで明示 (silent failure 防止)。絶対に throw しない。
 */
async function writeBack(inDb: Database.Database, text: string): Promise<void> {
  for (let attempt = 0; attempt <= WRITEBACK_MAX_RETRIES; attempt++) {
    try {
      insertMessage(inDb, {
        id: `shelve-resp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: null,
        channelType: null,
        threadId: null,
        content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
        processAfter: null,
        recurrence: null,
        trigger: 1, // agent を起こして patron に応答させる (明示)。
      });
      return;
    } catch (err) {
      const isLast = attempt === WRITEBACK_MAX_RETRIES;
      log.error('shelve_biblio writeBack failed', { attempt: attempt + 1, isLast, err });
      if (isLast) {
        log.error('shelve_biblio writeBack: patron notification lost after all retries', {
          retries: WRITEBACK_MAX_RETRIES + 1,
          textPreview: text.slice(0, 200),
        });
        return;
      }
      await sleep((attempt + 1) * WRITEBACK_RETRY_BASE_MS);
    }
  }
}

registerDeliveryAction('shelve_biblio', async (content, session, inDb) => {
  const rawName = typeof content.name === 'string' ? content.name.trim() : '';
  const rawCategory = typeof content.category === 'string' ? content.category.trim() : '';
  // reason は optional だが、空でも shelve() に渡す (commit/PR body に出る)。
  const rawReason = typeof content.reason === 'string' ? content.reason.trim() : '';

  if (!rawName) {
    log.warn('shelve_biblio missing name', { sessionId: session.id });
    await writeBack(inDb, '陳列エラー (invalid_input): name が指定されていません。');
    return;
  }
  if (!BIBLIO_NAME_RE.test(rawName)) {
    log.warn('shelve_biblio invalid name', { biblioName: rawName, sessionId: session.id });
    await writeBack(inDb, `陳列エラー (invalid_input): name が \`owner--name\` 形式ではありません: "${rawName}"`);
    return;
  }
  if (!rawCategory) {
    log.warn('shelve_biblio missing category', { sessionId: session.id });
    await writeBack(inDb, '陳列エラー (invalid_input): category が指定されていません。');
    return;
  }
  if (!VALID_CATEGORIES.includes(rawCategory as BiblioCategory)) {
    log.warn('shelve_biblio invalid category', { category: rawCategory, sessionId: session.id });
    await writeBack(
      inDb,
      `陳列エラー (invalid_category): category は biblio-dev|art|bf|ai のいずれかである必要があります: "${rawCategory}"`,
    );
    return;
  }

  const category = rawCategory as BiblioCategory;
  const reason = rawReason || '(理由未指定)';
  log.info('shelve_biblio from agent', { biblioName: rawName, category, sessionId: session.id });

  try {
    const result = await shelve({ biblioName: rawName, category, reason });
    await writeBack(inDb, resultText(rawName, result));
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
    await writeBack(inDb, `陳列エラー (internal): 予期しない失敗 — ${detail}`);
  }
});
