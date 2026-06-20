/**
 * 4 つの biblio action handler (acquire/inspect/categorize/shelve) の共通ヘルパ。
 *
 * - `writeBackMessage`: chat メッセージを inbound.db に書き戻し agent を起こす共通ロジック。
 *   SQLITE_BUSY 等を線形バックオフで 3 attempts まで再試行、全失敗時は patron 通知消失を
 *   error ログで明示。絶対に throw しない。
 * - `BIBLIO_NAME_RE`: `<owner>--<name>` 形式の biblioName を validate する正規表現。
 *   dedup key と path traversal 防御を兼ねる。
 */
import { setTimeout as sleep } from 'node:timers/promises';

import type Database from 'better-sqlite3';

import { insertMessage } from '../db/session-db.js';
import { log } from '../log.js';

/** writeBack の SQLITE_BUSY 等への小規模リトライ回数 (1 + 2 = 計 3 attempts)。 */
const WRITEBACK_MAX_RETRIES = 2;
/** 各リトライ前に sleep する基底 (ms)。attempt 倍率で線形バックオフ。 */
const WRITEBACK_RETRY_BASE_MS = 100;

/**
 * biblioName の正規表現 (`<owner>--<name>` 形式)。
 *
 * 用途:
 * - dedup key: 別 owner の同名 repo を同一 quarantine dir で衝突させない。GitHub 規約上
 *   `--` は通常 repo 名に含まれず、`<owner>--<name>` で衝突可能性を実務上ゼロにする。
 * - path traversal 防御: agent が `inspect_biblio` 等で任意の文字列を送れるため、
 *   `path.join` 前に `../../tmp/evil` 形式を弾く必要がある。
 *
 * 文字クラスは `acquire.ts` の SEGMENT_RE と同じ集合を 2 セグメントに繋いだ形。
 */
export const BIBLIO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*--[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * chat メッセージを inbound.db に書き戻し agent を起こす (4 action handler 共通)。
 *
 * DB 書き込み失敗 (`SQLITE_BUSY` 等) は短い線形バックオフで 3 attempts まで再試行、
 * 全失敗時は **patron 通知が消失すること** を明示する error ログを出す (silent failure 防止)。
 * **絶対に throw しない** — handler 側は writeBack の throw を catch していないため、
 * ここで投げると host を巻き込む。
 *
 * @param idPrefix `insertMessage` の id プレフィックス (例: `inspect-resp` / `acquire-resp`)。
 * @param actionName log の識別用 action 名 (例: `inspect_biblio` / `acquire_biblio`)。
 */
export async function writeBackMessage(
  inDb: Database.Database,
  text: string,
  idPrefix: string,
  actionName: string,
): Promise<void> {
  for (let attempt = 0; attempt <= WRITEBACK_MAX_RETRIES; attempt++) {
    try {
      insertMessage(inDb, {
        id: `${idPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
      log.error(`${actionName} writeBack failed`, { attempt: attempt + 1, isLast, err });
      if (isLast) {
        // 通知が patron に届かない silent failure を絶対に隠さない。preview は debug 用
        // (text は verdict/reason/biblioName を含むので機密ではない)。
        log.error(`${actionName} writeBack: patron notification lost after all retries`, {
          retries: WRITEBACK_MAX_RETRIES + 1,
          textPreview: text.slice(0, 200),
        });
        return;
      }
      await sleep((attempt + 1) * WRITEBACK_RETRY_BASE_MS);
    }
  }
}
