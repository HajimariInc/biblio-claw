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
import { withBiblioActionSpan, writeBackMessage } from './action-helpers.js';
import type { AcquireResult } from './types.js';

/**
 * acquire 結果を patron 向けの 1 行テキストに整形する。
 *
 * 成功時は `repo` (= 全体経路) または `repo/skill` (= 個別 skill 経路) を target として表示し、
 * patron が「自分のリクエストが期待どおり解釈されたか」を 1 文字で判別できるようにする。
 * `threshold_exceeded` は Phase 2 閾値超過 promote (= clone 前 early return)。「エラー」表記を
 * 避け、patron が次の手 (= 個別指定) に進める文言に倒す。
 */
function resultText(repo: string, skill: string | undefined, result: AcquireResult): string {
  if (result.ok) {
    const target = skill ? `${repo}/${skill}` : repo;
    return `仕入れ完了: ${target} を quarantine に配置しました (${result.quarantinePath})。次は inspect_biblio で検品できます。`;
  }
  if (result.reason === 'threshold_exceeded') {
    // 動的 promote 文言 (count + 上限 + 個別指定例 + ブラウザ確認案内) は acquire.ts 側で
    // detail に組み済み。素通しすることで Slack 上の UX が「個別に指定してください」の親切な
    // 案内になる (= patron は次の手 = シナリオ B = `@bot 仕入れて <owner>/<repo>/<skill>` に進める)。
    return result.detail;
  }
  // `marketplace_source_root` / `marketplace_source_external` は issue #63 PR 検証で追加。
  // どちらも patron に「次の手」を提示する案内文を acquire.ts 側で detail に組み済 (= 2-segment で
  // 叩いて / 別 repo を直接指定して) ため、素通しで Slack に流すと UX が親切になる。
  if (result.reason === 'marketplace_source_root' || result.reason === 'marketplace_source_external') {
    return result.detail;
  }
  // 'internal' は patron が手で対処できない構成不備 (詳細は types.ts AcquireFailureReason)。
  // 再試行ではなく運用者への報告を促す文言にする。
  if (result.reason === 'internal') {
    return `システム構成エラー: ${result.detail}`;
  }
  return `仕入れエラー (${result.reason}): ${result.detail}`;
}

registerDeliveryAction('acquire_biblio', async (content, session, inDb) => {
  const repo = typeof content.repo === 'string' ? content.repo : '';
  // 空文字 / 空白のみは undefined に倒し、`acquire()` には skill キーごと渡さない
  // (= 既存 2 segments 経路と完全互換、`content.skill: ''` を「全体仕入れ」と解釈する)。
  // `mcp-tools/biblio.ts` と同じ `trim() || undefined` イディオムに統一。
  const skill = typeof content.skill === 'string' ? content.skill.trim() || undefined : undefined;
  const requestId = crypto.randomUUID();
  await withBiblioActionSpan('acquire', requestId, session.id, async (span) => {
    if (!repo) {
      log.warn('acquire_biblio missing repo', {
        event: 'biblio.acquire',
        outcome: 'failure',
        session_id: session.id,
        request_id: requestId,
      });
      await writeBackMessage(
        inDb,
        '仕入れエラー (invalid_input): repo が指定されていません。',
        'acquire-resp',
        'acquire_biblio',
      );
      return;
    }

    log.info('acquire_biblio from agent', {
      event: 'biblio.acquire',
      repo,
      skill,
      session_id: session.id,
      request_id: requestId,
    });

    try {
      // ctx を渡して acquire 内の ghFetch ログに request_id / session_id を伝搬
      // (= Phase 2 で確立した patron 依頼単位の trace 経路、shelve-action.ts と同流儀)。
      const result = await acquire(
        { repo, ...(skill ? { skill } : {}) },
        { ctx: { requestId, sessionId: session.id } },
      );
      await writeBackMessage(inDb, resultText(repo, skill, result), 'acquire-resp', 'acquire_biblio');
      log.info('acquire_biblio done', {
        event: 'biblio.acquire',
        outcome: result.ok ? 'success' : 'failure',
        repo,
        skill,
        ok: result.ok,
        session_id: session.id,
        request_id: requestId,
      });
      span.setAttribute('biblio.outcome', result.ok ? 'success' : 'failure');
    } catch (err) {
      // 想定外例外も握って patron に通知する (host を落とさない)。
      log.error('acquire_biblio threw', {
        event: 'biblio.acquire',
        outcome: 'failure',
        repo,
        skill,
        session_id: session.id,
        request_id: requestId,
        err,
      });
      const detail = err instanceof Error ? err.message : String(err);
      // resultText() の 'internal' 分岐と同じ文言形式に揃える (patron へのメッセージ統一)。
      await writeBackMessage(inDb, `システム構成エラー: 予期しない失敗 — ${detail}`, 'acquire-resp', 'acquire_biblio');
      span.setAttribute('biblio.outcome', 'failure');
    }
  });
});
