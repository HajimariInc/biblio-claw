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

/**
 * acquire 結果を patron 向けの 1 行テキストに整形する。
 *
 * `not_implemented` は Phase 1 個別 skill 仕入れ受領通知 (= Phase 3 未実装)。
 * `threshold_exceeded` は Phase 2 閾値超過 promote (= clone 前 early return)。
 * いずれも「エラー」表記を避け、patron が次の手 (= 個別指定) に進める文言に倒す
 * (Phase 3 完了時に `not_implemented` 分岐は削除予定)。
 */
function resultText(repo: string, skill: string | undefined, result: AcquireResult): string {
  if (result.ok) {
    return `仕入れ完了: ${repo} を quarantine に配置しました (${result.quarantinePath})。次は inspect_biblio で検品できます。`;
  }
  if (result.reason === 'not_implemented') {
    const target = skill ? `${repo}/${skill}` : repo;
    return `個別 skill 仕入れリクエストを受領しました (${target})。実 fetch は Phase 3 で実装中、現時点では受領通知のみ返します。`;
  }
  if (result.reason === 'threshold_exceeded') {
    // 動的 promote 文言 (count + 上限 + 個別指定例 + ブラウザ確認案内) は acquire.ts 側で
    // detail に組み済み。素通しすることで Slack 上の UX が「個別に指定してください」の親切な
    // 案内になる (= patron は次の手 = シナリオ B = `@bot 仕入れて <owner>/<repo>/<skill>` に進める)。
    return result.detail;
  }
  return `仕入れエラー (${result.reason}): ${result.detail}`;
}

registerDeliveryAction('acquire_biblio', async (content, session, inDb) => {
  const repo = typeof content.repo === 'string' ? content.repo : '';
  // 空文字 / 空白のみは undefined に倒し、`acquire()` には skill キーごと渡さない
  // (= 既存 2 segments 経路と完全互換、`content.skill: ''` を「全体仕入れ」と解釈する)。
  // `mcp-tools/biblio.ts` と同じ `trim() || undefined` イディオムに統一。
  const skill = typeof content.skill === 'string' ? content.skill.trim() || undefined : undefined;
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

  log.info('acquire_biblio from agent', { repo, skill, sessionId: session.id });

  try {
    const result = await acquire({ repo, ...(skill ? { skill } : {}) });
    await writeBackMessage(inDb, resultText(repo, skill, result), 'acquire-resp', 'acquire_biblio');
    log.info('acquire_biblio done', { repo, skill, ok: result.ok, sessionId: session.id });
  } catch (err) {
    // 想定外例外も握って patron に通知する (host を落とさない)。
    log.error('acquire_biblio threw', { repo, skill, sessionId: session.id, err });
    const detail = err instanceof Error ? err.message : String(err);
    await writeBackMessage(
      inDb,
      `仕入れエラー (internal): 予期しない失敗 — ${detail}`,
      'acquire-resp',
      'acquire_biblio',
    );
  }
});
