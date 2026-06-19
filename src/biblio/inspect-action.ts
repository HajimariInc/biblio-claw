/**
 * Delivery action handler — `inspect_biblio`.
 *
 * agent (Claude) が `inspect_biblio` MCP ツールで outbound.db に system action を
 * 書く → delivery poll がここを呼ぶ → host で `inspect()` を実行 → 判定 + 理由を
 * inbound.db に chat メッセージで書き戻し (`trigger:1` = agent を起こす) → agent が
 * patron に Slack 応答する、という acquire_biblio と同じ system-action 経路。
 *
 * handler 内例外は host を巻き込むため try/catch で握り、失敗も必ず inbound に
 * 書き戻す (silent failure 禁止 — patron に必ず可視化する。`acquire-action.ts` と同形)。
 */
import type Database from 'better-sqlite3';

import { registerDeliveryAction } from '../delivery.js';
import { insertMessage } from '../db/session-db.js';
import { log } from '../log.js';
import { inspect } from './inspect.js';
import type { InspectResult } from './types.js';

/** inspect 結果を patron 向けの 1 行 (HOLD/REJECT は 2 行) テキストに整形する。 */
function resultText(biblioName: string, result: InspectResult): string {
  if (result.verdict === 'ACCEPT') {
    return `検品 ACCEPT: ${biblioName} は棚に上げられます (3 軸全通過)。次は陳列 (Phase 3) に渡せます。`;
  }
  const tail = 'quarantine に残置しました。';
  return `検品 ${result.verdict} (${result.reason}): ${biblioName} — ${result.detail}。${tail}`;
}

/**
 * chat メッセージを inbound.db に書き戻し agent を起こす。
 * DB 書き込み失敗 (SQLITE_BUSY 等) を握って log.error に出し、絶対に throw しない。
 */
function writeBack(inDb: Database.Database, text: string): void {
  try {
    insertMessage(inDb, {
      id: `inspect-resp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
  } catch (err) {
    log.error('inspect_biblio writeBack failed', { err });
  }
}

registerDeliveryAction('inspect_biblio', async (content, session, inDb) => {
  const biblioName = typeof content.name === 'string' ? content.name : '';
  if (!biblioName) {
    log.warn('inspect_biblio missing name', { sessionId: session.id });
    writeBack(inDb, '検品エラー (invalid_input): name が指定されていません。');
    return;
  }

  log.info('inspect_biblio from agent', { biblioName, sessionId: session.id });

  try {
    const result = await inspect({ biblioName });
    writeBack(inDb, resultText(biblioName, result));
    log.info('inspect_biblio done', { biblioName, verdict: result.verdict, sessionId: session.id });
  } catch (err) {
    // inspect() は throw しない設計だが、想定外例外も握って patron に通知する (host を落とさない)。
    log.error('inspect_biblio threw', { biblioName, sessionId: session.id, err });
    const detail = err instanceof Error ? err.message : String(err);
    writeBack(inDb, `検品エラー (internal): 予期しない失敗 — ${detail}`);
  }
});
