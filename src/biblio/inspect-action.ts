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
import { setTimeout as sleep } from 'node:timers/promises';

import type Database from 'better-sqlite3';

import { registerDeliveryAction } from '../delivery.js';
import { insertMessage } from '../db/session-db.js';
import { log } from '../log.js';
import { inspect } from './inspect.js';
import type { InspectResult } from './types.js';

/**
 * `biblioName` の許容文字 — `acquire.ts:SEGMENT_RE` と同値の安全側集合。
 * agent が任意の文字列を `inspect_biblio` 経由で送れるため、`path.join` する前に検証
 * しないと `../../tmp/evil` 形式でパストラバーサルが成立し、quarantine 外を LLM
 * プロンプトに埋め込む経路が生まれる (code-review #7 指摘)。`acquire` 経路の biblio 名は
 * normalizeRepo で検証済なので、本検証は agent 直接呼び (誤動作 / プロンプトインジェクション)
 * に対する防御線。
 */
const BIBLIO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** writeBack の SQLITE_BUSY 等への小規模リトライ回数 (1 + 2 = 計 3 attempts)。 */
const WRITEBACK_MAX_RETRIES = 2;
/** 各リトライ前に sleep する基底 (ms)。attempt × WRITEBACK_RETRY_BASE_MS で線形バックオフ。 */
const WRITEBACK_RETRY_BASE_MS = 100;

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
 * DB 書き込み失敗 (`SQLITE_BUSY` 等) は短い線形バックオフで 3 attempts まで再試行、
 * 全失敗時は **patron 通知が消失すること** を明示する error ログを出す
 * (silent failure 防止)。**絶対に throw しない** — 呼び出し元 (handler / 失敗パス)
 * は writeBack の throw に対するガードを持たない前提で書かれているため、ここで
 * 投げると host を巻き込む。
 */
async function writeBack(inDb: Database.Database, text: string): Promise<void> {
  for (let attempt = 0; attempt <= WRITEBACK_MAX_RETRIES; attempt++) {
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
      return;
    } catch (err) {
      const isLast = attempt === WRITEBACK_MAX_RETRIES;
      log.error('inspect_biblio writeBack failed', { attempt: attempt + 1, isLast, err });
      if (isLast) {
        // 通知が patron に届かない silent failure を絶対に隠さない。preview は debug 用 (text は
        // verdict + reason + biblioName を含むので機密ではない)。
        log.error('inspect_biblio writeBack: patron notification lost after all retries', {
          retries: WRITEBACK_MAX_RETRIES + 1,
          textPreview: text.slice(0, 200),
        });
        return;
      }
      await sleep((attempt + 1) * WRITEBACK_RETRY_BASE_MS);
    }
  }
}

registerDeliveryAction('inspect_biblio', async (content, session, inDb) => {
  const rawName = typeof content.name === 'string' ? content.name.trim() : '';
  if (!rawName) {
    log.warn('inspect_biblio missing name', { sessionId: session.id });
    await writeBack(inDb, '検品エラー (invalid_input): name が指定されていません。');
    return;
  }
  // パストラバーサル防御: agent が `../../tmp/evil` 形式を渡しても `path.join` で
  // quarantine 外を指す経路を作れないようにする。BIBLIO_NAME_RE は `acquire.ts` の
  // SEGMENT_RE と同値の安全側集合。
  if (!BIBLIO_NAME_RE.test(rawName)) {
    log.warn('inspect_biblio invalid name', { biblioName: rawName, sessionId: session.id });
    await writeBack(inDb, `検品エラー (invalid_input): name に無効な文字が含まれています: "${rawName}"`);
    return;
  }

  log.info('inspect_biblio from agent', { biblioName: rawName, sessionId: session.id });

  try {
    const result = await inspect({ biblioName: rawName });
    await writeBack(inDb, resultText(rawName, result));
    log.info('inspect_biblio done', { biblioName: rawName, verdict: result.verdict, sessionId: session.id });
  } catch (err) {
    // inspect() は throw しない設計だが、想定外例外も握って patron に通知する (host を落とさない)。
    log.error('inspect_biblio threw', { biblioName: rawName, sessionId: session.id, err });
    const detail = err instanceof Error ? err.message : String(err);
    await writeBack(inDb, `検品エラー (internal): 予期しない失敗 — ${detail}`);
  }
});
