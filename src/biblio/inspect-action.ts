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
import { SpanStatusCode } from '@opentelemetry/api';

import { registerDeliveryAction } from '../delivery.js';
import { log } from '../log.js';
import { inspect } from './inspect.js';
import { BIBLIO_NAME_RE, withBiblioActionSpan, writeBackMessage } from './action-helpers.js';
import type { InspectResult } from './types.js';

/** inspect 結果を patron 向けの 1 行 (HOLD/REJECT は 2 行) テキストに整形する。 */
function resultText(biblioName: string, result: InspectResult): string {
  if (result.verdict === 'ACCEPT') {
    return `検品 ACCEPT: ${biblioName} は棚に上げられます (3 軸全通過)。次は categorize_biblio でカテゴライズできます。`;
  }
  const tail = 'quarantine に残置しました。';
  return `検品 ${result.verdict} (${result.reason}): ${biblioName} — ${result.detail}。${tail}`;
}

registerDeliveryAction('inspect_biblio', async (content, session, inDb) => {
  const rawName = typeof content.name === 'string' ? content.name.trim() : '';
  const requestId = crypto.randomUUID();
  await withBiblioActionSpan('inspect', requestId, session.id, async (span) => {
    if (!rawName) {
      log.warn('inspect_biblio missing name', {
        event: 'biblio.inspect',
        outcome: 'failure',
        session_id: session.id,
        request_id: requestId,
      });
      await writeBackMessage(
        inDb,
        '検品エラー (invalid_input): name が指定されていません。',
        'inspect-resp',
        'inspect_biblio',
      );
      return;
    }
    // path traversal 防御 + `owner--name` 形式の強制 (= inspect.ts が `quarantineRoot/biblioName`
    // を path.join するため、不正な値は弾く)。
    if (!BIBLIO_NAME_RE.test(rawName)) {
      log.warn('inspect_biblio invalid name', {
        event: 'biblio.inspect',
        outcome: 'failure',
        biblioName: rawName,
        session_id: session.id,
        request_id: requestId,
      });
      await writeBackMessage(
        inDb,
        `検品エラー (invalid_input): name が \`owner--name\` 形式ではありません: "${rawName}"`,
        'inspect-resp',
        'inspect_biblio',
      );
      return;
    }

    log.info('inspect_biblio from agent', {
      event: 'biblio.inspect',
      biblioName: rawName,
      session_id: session.id,
      request_id: requestId,
    });

    try {
      const result = await inspect({ biblioName: rawName }, { ctx: { requestId, sessionId: session.id } });
      await writeBackMessage(inDb, resultText(rawName, result), 'inspect-resp', 'inspect_biblio');
      // verdict 3 値 (ACCEPT/HOLD/REJECT) を outcome 3 値 (success/hold/failure) に対応させる。
      // HOLD は「判定保留」で失敗ではないため、BQ 集計で REJECT (失敗) と区別する。
      const outcome = result.verdict === 'ACCEPT' ? 'success' : result.verdict === 'HOLD' ? 'hold' : 'failure';
      // review R6 (I1): 実際の verdict × reason 対応表 (inspect.ts の全 fail() 経路実測):
      //   ACCEPT → reason なし (undefined)
      //   HOLD + inspect_error (Vertex/Gemini 呼出失敗、応答崩れ、quarantine 不可 = システム障害)
      //   HOLD + license_denied / license_unknown (ルーティンなポリシー保留)
      //   REJECT + schema_invalid (plugin metadata 不備)
      //   REJECT + dangerous_code (LLM で危険コード検出 = dangerous=true 唯一)
      // 注意: `REJECT + inspect_error` はコード上発生しない (`inspect_error` は常に `HOLD` に倒れる、
      // 旧誤コメント修正、review comment-analyzer #2 + silent-failure-hunter #2)。
      const dangerous = result.verdict === 'REJECT' && result.reason === 'dangerous_code';
      log.info('inspect_biblio done', {
        event: 'biblio.inspect',
        outcome,
        biblioName: rawName,
        verdict: result.verdict,
        // review R6 (I1): reason を独立 emit することで、HOLD + inspect_error (システム障害) と
        // HOLD + license_* (ルーティン policy 保留) を BQ 集計で区別可能に。ACCEPT 時は reason
        // 不在なので null で明示 (SQL 側 filter/GROUP BY で扱いやすい形)。
        reason: result.verdict === 'ACCEPT' ? null : (result.reason ?? null),
        dangerous,
        session_id: session.id,
        request_id: requestId,
      });
      span.setAttribute('biblio.outcome', outcome);
    } catch (err) {
      // inspect() は throw しない設計だが、想定外例外も握って patron に通知する (host を落とさない)。
      // span 記録は acquire-action.ts と同形 (silent failure 撲滅)。
      const errorRecord = err instanceof Error ? err : new Error(String(err));
      span.recordException(errorRecord);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorRecord.message });
      log.error('inspect_biblio threw', {
        event: 'biblio.inspect',
        outcome: 'failure',
        biblioName: rawName,
        session_id: session.id,
        request_id: requestId,
        err,
      });
      await writeBackMessage(
        inDb,
        `検品エラー (internal): 予期しない失敗 — ${errorRecord.message}`,
        'inspect-resp',
        'inspect_biblio',
      );
      span.setAttribute('biblio.outcome', 'failure');
    }
  });
});
