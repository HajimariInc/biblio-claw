/**
 * Delivery action handler — `acquire_biblio`。
 *
 * agent (Claude) が `acquire_biblio` MCP ツールで outbound.db に system action を
 * 書く → delivery poll がここを呼ぶ → host で `acquire()` を実行 → 結果を
 * inbound.db に chat メッセージで書き戻し (`trigger:1` = agent を起こす) →
 * agent が patron に Slack 応答する、という既存 system-action 経路に載せる。
 *
 * handler 内の例外は host を巻き込むため try/catch で握り、失敗も必ず inbound に
 * 書き戻す (silent failure 禁止 — patron に必ず可視化する)。
 */
import type Database from 'better-sqlite3';

import { registerDeliveryAction } from '../delivery.js';
import { insertMessage } from '../db/session-db.js';
import { log } from '../log.js';
import { acquire } from './acquire.js';
import type { AcquireResult } from './types.js';

/** acquire 結果を patron 向けの 1 行テキストに整形する。 */
function resultText(repo: string, result: AcquireResult): string {
  if (result.ok) {
    return `仕入れ完了: ${repo} を quarantine に配置しました (${result.quarantinePath})。次は検品 (Phase 2) に渡せます。`;
  }
  return `仕入れエラー (${result.reason}): ${result.detail}`;
}

/** chat メッセージを inbound.db に書き戻し agent を起こす (返信は session の既定ルーティング)。 */
function writeBack(inDb: Database.Database, text: string): void {
  insertMessage(inDb, {
    id: `acquire-resp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
    processAfter: null,
    recurrence: null,
    // trigger は既定 1 = agent を起こす (patron に応答させる)。
  });
}

registerDeliveryAction('acquire_biblio', async (content, session, inDb) => {
  const repo = typeof content.repo === 'string' ? content.repo : '';
  if (!repo) {
    log.warn('acquire_biblio missing repo', { sessionId: session.id });
    writeBack(inDb, '仕入れエラー (invalid_input): repo が指定されていません。');
    return;
  }

  log.info('acquire_biblio from agent', { repo, sessionId: session.id });

  try {
    const result = await acquire({ repo });
    writeBack(inDb, resultText(repo, result));
    log.info('acquire_biblio done', { repo, ok: result.ok, sessionId: session.id });
  } catch (err) {
    // 想定外例外も握って patron に通知する (host を落とさない)。
    log.error('acquire_biblio threw', { repo, sessionId: session.id, err });
    const detail = err instanceof Error ? err.message : String(err);
    writeBack(inDb, `仕入れエラー (internal): 予期しない失敗 — ${detail}`);
  }
});
