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
import { setTimeout as sleep } from 'node:timers/promises';

import type Database from 'better-sqlite3';

import { registerDeliveryAction } from '../delivery.js';
import { insertMessage } from '../db/session-db.js';
import { log } from '../log.js';
import { categorize } from './categorize.js';
import type { CategoryResult } from './types.js';

/**
 * Phase 3 以降の biblioName 形式 (`<owner>--<name>`)。Phase 1/2 の旧形式 (`<name>` 単体) は
 * Task 8 (acquire.ts) の dedup key 化で全経路が新形式に統一される。古い形式を受け取った
 * 場合は明示的に拒否 (= 別経路で混入した古い biblio を黙って受け付けない silent failure 防御)。
 */
const BIBLIO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*--[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** writeBack の SQLITE_BUSY 等への小規模リトライ回数 (1 + 2 = 計 3 attempts、inspect-action.ts と同値)。 */
const WRITEBACK_MAX_RETRIES = 2;
/** 各リトライ前に sleep する基底 (ms)。attempt × WRITEBACK_RETRY_BASE_MS で線形バックオフ。 */
const WRITEBACK_RETRY_BASE_MS = 100;

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

/**
 * chat メッセージを inbound.db に書き戻し agent を起こす。
 * 失敗時は patron 通知消失を error ログで明示 (silent failure 防止)。
 * 絶対に throw しない (inspect-action.ts と同流儀)。
 */
async function writeBack(inDb: Database.Database, text: string): Promise<void> {
  for (let attempt = 0; attempt <= WRITEBACK_MAX_RETRIES; attempt++) {
    try {
      insertMessage(inDb, {
        id: `categorize-resp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
      log.error('categorize_biblio writeBack failed', { attempt: attempt + 1, isLast, err });
      if (isLast) {
        log.error('categorize_biblio writeBack: patron notification lost after all retries', {
          retries: WRITEBACK_MAX_RETRIES + 1,
          textPreview: text.slice(0, 200),
        });
        return;
      }
      await sleep((attempt + 1) * WRITEBACK_RETRY_BASE_MS);
    }
  }
}

registerDeliveryAction('categorize_biblio', async (content, session, inDb) => {
  const rawName = typeof content.name === 'string' ? content.name.trim() : '';
  if (!rawName) {
    log.warn('categorize_biblio missing name', { sessionId: session.id });
    await writeBack(inDb, 'カテゴライズエラー (invalid_input): name が指定されていません。');
    return;
  }
  // パストラバーサル防御 + `owner--name` 形式の強制 (= categorize.ts が
  // `quarantineRoot/biblioName` を path.join するため、不正な値は弾く)。
  if (!BIBLIO_NAME_RE.test(rawName)) {
    log.warn('categorize_biblio invalid name', { biblioName: rawName, sessionId: session.id });
    await writeBack(
      inDb,
      `カテゴライズエラー (invalid_input): name が \`owner--name\` 形式ではありません: "${rawName}"`,
    );
    return;
  }

  log.info('categorize_biblio from agent', { biblioName: rawName, sessionId: session.id });

  try {
    const result = await categorize({ biblioName: rawName });
    await writeBack(inDb, resultText(rawName, result));
    log.info('categorize_biblio done', {
      biblioName: rawName,
      ok: result.ok,
      category: result.ok ? result.category : null,
      sessionId: session.id,
    });
  } catch (err) {
    // categorize() は throw しない設計だが、想定外例外も握って patron に通知する (host を落とさない)。
    log.error('categorize_biblio threw', { biblioName: rawName, sessionId: session.id, err });
    const detail = err instanceof Error ? err.message : String(err);
    await writeBack(inDb, `カテゴライズエラー (internal): 予期しない失敗 — ${detail}`);
  }
});
