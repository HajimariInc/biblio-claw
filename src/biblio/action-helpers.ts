/**
 * biblio action handler (acquire/inspect/categorize/shelve/enkin/shokyaku) の共通ヘルパ。
 *
 * - `writeBackMessage`: chat メッセージを inbound.db に書き戻し agent を起こす共通ロジック。
 *   SQLITE_BUSY 等を線形バックオフで 3 attempts まで再試行、全失敗時は patron 通知消失を
 *   error ログで明示。絶対に throw しない。
 * - `BIBLIO_NAME_RE`: `<owner>--<name>` 形式の biblioName を validate する正規表現。
 *   dedup key と path traversal 防御を兼ねる。
 * - `safeNotify`: approval handler 内で session に notify を書く `ApprovalHandlerContext.notify`
 *   を try/catch で包み、SQLITE_BUSY 等の throw を握って `log.error` で「patron 通知消失」を
 *   明示する。`notify` は `writeSessionMessage` の同期ラッパで retry 機構を持たないため、
 *   HITL 承認後の通知が host を巻き込まないよう本ヘルパで防御する (PR #15 silent-failure HIGH 1)。
 */
import { setTimeout as sleep } from 'node:timers/promises';

import type Database from 'better-sqlite3';

import { insertMessage } from '../db/session-db.js';
import { log } from '../log.js';
import type { Session } from '../types.js';

import { BIBLIO_CATEGORIES, type BiblioCategory } from './types.js';

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

/**
 * approval handler 内の `notify()` 呼び出しを try/catch で包む。
 *
 * `notify` (= `ApprovalHandlerContext.notify`) は `writeSessionMessage` の同期ラッパで、
 * SQLITE_BUSY 等が throw すると caller (= `response-handler.ts` の最終 catch) に抜けて
 * patron 通知が消失する。本ヘルパで握って `log.error` を出すことで、通知失敗を
 * 「patron 通知消失」として可視化する (= `writeBackMessage` と同じ silent failure 防止方針)。
 *
 * 絶対に throw しない。
 *
 * @param notify approval handler に渡される `ApprovalHandlerContext.notify` の同期関数
 * @param text patron に届ける本文
 * @param ctx ログに含める識別情報 (action 名 + biblioName 等)
 */
export function safeNotify(
  notify: (text: string) => void,
  text: string,
  ctx: { action: string; biblioName?: string },
): void {
  try {
    notify(text);
  } catch (err) {
    log.error(`${ctx.action}: notify failed (patron notification lost)`, {
      biblioName: ctx.biblioName,
      textPreview: text.slice(0, 200),
      err,
    });
  }
}

/** {@link validateBiblioInput} の入力 (= delivery action handler が agent から受け取る content)。 */
export interface BiblioNameCategoryInput {
  name?: unknown;
  category?: unknown;
}

/** {@link validateBiblioInput} の成功時返り値 (= name + category の両方が validate 通過)。 */
export interface BiblioNameCategoryValidated {
  biblioName: string;
  category: BiblioCategory;
}

/**
 * enkin / shokyaku / shelve delivery action handler 共通の name + category validate。
 *
 * 4 つの validate (name 不在 / `BIBLIO_NAME_RE` 不通過 / category 不在 / `BIBLIO_CATEGORIES`
 * 不通過) を 1 箇所に集約し、失敗時は `writeBackMessage` で patron にエラーを書き戻して
 * `null` を返す。caller は `null` を見たら return する想定 (= guard clause)。成功時は
 * `{ biblioName, category }` を返す (= caller は trust して `requestApproval` / `shelve` に
 * 渡せる)。
 *
 * 旧実装は enkin-action / shokyaku-action / shelve-action の 3 ファイルに 40 行ずつ
 * 逐語コピーされており、将来 category 追加 / メッセージ変更で 3 箇所同時修正が必要だった
 * (= PR #21 code-simplifier 推奨で集約)。
 *
 * @param respPrefix `writeBackMessage` の id プレフィックス (例: `enkin-resp`)
 * @param actionName log の識別用 action 名 (例: `enkin_biblio`)
 * @param errorLabel patron 向けエラーメッセージの先頭ラベル (例: `禁書` / `焼却` / `陳列`)
 */
export async function validateBiblioInput(
  content: BiblioNameCategoryInput,
  inDb: Database.Database,
  session: Session,
  respPrefix: string,
  actionName: string,
  errorLabel: string,
): Promise<BiblioNameCategoryValidated | null> {
  const rawName = typeof content.name === 'string' ? content.name.trim() : '';
  const rawCategory = typeof content.category === 'string' ? content.category.trim() : '';

  if (!rawName) {
    log.warn(`${actionName} missing name`, { sessionId: session.id });
    await writeBackMessage(
      inDb,
      `${errorLabel}エラー (invalid_input): name が指定されていません。`,
      respPrefix,
      actionName,
    );
    return null;
  }
  if (!BIBLIO_NAME_RE.test(rawName)) {
    log.warn(`${actionName} invalid name`, { biblioName: rawName, sessionId: session.id });
    await writeBackMessage(
      inDb,
      `${errorLabel}エラー (invalid_input): name が \`owner--name\` 形式ではありません: "${rawName}"`,
      respPrefix,
      actionName,
    );
    return null;
  }
  if (!rawCategory) {
    log.warn(`${actionName} missing category`, { sessionId: session.id });
    await writeBackMessage(
      inDb,
      `${errorLabel}エラー (invalid_input): category が指定されていません。`,
      respPrefix,
      actionName,
    );
    return null;
  }
  if (!BIBLIO_CATEGORIES.includes(rawCategory as BiblioCategory)) {
    log.warn(`${actionName} invalid category`, { category: rawCategory, sessionId: session.id });
    await writeBackMessage(
      inDb,
      `${errorLabel}エラー (invalid_category): category は biblio-dev|biblio-art|biblio-bf|biblio-ai のいずれかである必要があります: "${rawCategory}"`,
      respPrefix,
      actionName,
    );
    return null;
  }
  return { biblioName: rawName, category: rawCategory as BiblioCategory };
}
