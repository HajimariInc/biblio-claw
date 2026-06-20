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
import { registerDeliveryAction } from '../delivery.js';
import { log } from '../log.js';
import { acquire } from './acquire.js';
import { writeBackMessage } from './action-helpers.js';
import type { AcquireResult } from './types.js';

/** acquire 結果を patron 向けの 1 行テキストに整形する。 */
function resultText(repo: string, result: AcquireResult): string {
  if (result.ok) {
    return `仕入れ完了: ${repo} を quarantine に配置しました (${result.quarantinePath})。次は inspect_biblio で検品できます。`;
  }
  return `仕入れエラー (${result.reason}): ${result.detail}`;
}

registerDeliveryAction('acquire_biblio', async (content, session, inDb) => {
  const repo = typeof content.repo === 'string' ? content.repo : '';
  if (!repo) {
    log.warn('acquire_biblio missing repo', { sessionId: session.id });
    await writeBackMessage(
      inDb,
      '仕入れエラー (invalid_input): repo が指定されていません。',
      'acquire-resp',
      'acquire_biblio',
    );
    return;
  }

  log.info('acquire_biblio from agent', { repo, sessionId: session.id });

  try {
    const result = await acquire({ repo });
    await writeBackMessage(inDb, resultText(repo, result), 'acquire-resp', 'acquire_biblio');
    log.info('acquire_biblio done', { repo, ok: result.ok, sessionId: session.id });
  } catch (err) {
    // 想定外例外も握って patron に通知する (host を落とさない)。
    log.error('acquire_biblio threw', { repo, sessionId: session.id, err });
    const detail = err instanceof Error ? err.message : String(err);
    await writeBackMessage(
      inDb,
      `仕入れエラー (internal): 予期しない失敗 — ${detail}`,
      'acquire-resp',
      'acquire_biblio',
    );
  }
});
