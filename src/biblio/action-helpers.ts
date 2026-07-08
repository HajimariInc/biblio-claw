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
 *   HITL 承認後の通知が host を巻き込まないよう本ヘルパで防御する (silent failure 撲滅)。
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api';
import type Database from 'better-sqlite3';

import { insertMessage } from '../db/session-db.js';
import { log } from '../log.js';
import { getTracer } from '../observability/index.js';
import type { Session } from '../types.js';

import { BIBLIO_CATEGORIES, type BiblioCategory } from './types.js';

/**
 * biblio action handler の span 名を closed union で固定する。
 * acquire / inspect / categorize / shelve / multi-shelve / enkin / shokyaku /
 * list-biblio / config / equip の 10 handler が共通で使う + HITL 2 経路 (enkin_request /
 * shokyaku_request = delivery 申請境界、enkin / shokyaku = approval 承認境界) を
 * 区別する。新 handler 追加時は本 union を必ず拡張する (= 拡張なしで呼び出すと
 * compile error)。
 *
 * `equip` は Fugue channel の装備操作 (`fugue-http.ts:handleEquip`) が
 * `withBiblioActionSpan('equip', request_id, '', fn)` で包むことで、`biblio.${action}`
 * 集計に channel-agnostic に載せる (sessionId 空文字は Fugue に session 概念なしのため。
 * approval 経路と同じ空文字慣習)。
 */
export type BiblioActionName =
  | 'acquire'
  | 'inspect'
  | 'categorize'
  | 'shelve'
  | 'shelve_multi'
  | 'list'
  | 'enkin'
  | 'enkin_request'
  | 'shokyaku'
  | 'shokyaku_request'
  | 'config'
  | 'equip';

/**
 * biblio action handler 共通の span ラッパ。
 *
 * acquire / inspect / categorize / shelve / multi-shelve / enkin / shokyaku /
 * list-biblio / config / equip の 10 handler が共通で使う (= 12 span 名は
 * [[BiblioActionName]] で固定)。`biblio.${action}` 名で span を開始し、`biblio.request_id` /
 * `biblio.session_id` / `biblio.action` を属性として記録する。exception は
 * recordException + ERROR status で記録、span は finally で必ず end する。
 *
 * @note approval handler 経路 (enkin / shokyaku の confirm) では sessionId に
 *       空文字列が渡される (= approval 後の境界は session を持たない、申請境界の
 *       `enkin_request` / `shokyaku_request` 側が `session_id` を保持する)。
 */
export async function withBiblioActionSpan<T>(
  action: BiblioActionName,
  requestId: string,
  sessionId: string,
  fn: (span: Span) => Promise<T>,
  extraAttributes?: Record<string, string | number | boolean>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(
    `biblio.${action}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        'biblio.request_id': requestId,
        'biblio.session_id': sessionId,
        'biblio.action': action,
        ...(extraAttributes ?? {}),
      },
    },
    async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        // err が non-Error (= string/number throw) の場合に Cloud Trace の例外イベントと
        // ERROR status message が undefined にならないよう instanceof guard で分岐。
        const errorRecord = err instanceof Error ? err : new Error(String(err));
        span.recordException(errorRecord);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorRecord.message });
        // Phase 4 review I1 (silent-failure #1): throw 経路では必ず outcome=failure を反映。
        // 成功経路で `setAttribute('biblio.outcome', ...)` を呼ぶ現行実装では、その setAttribute
        // より後段 (未想定例外) で outcome 属性が欠落し、Cloud Trace / BQ の outcome ベース
        // ダッシュボードから failure が消える silent failure が発生していた。catch 経路での
        // 上書きは「throw したなら outcome は必ず failure が正」なので意味論的に安全。
        // 10+ の biblio handler すべてに恩恵がある一般化。
        span.setAttribute('biblio.outcome', 'failure');
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/** writeBack の SQLITE_BUSY 等への小規模リトライ回数 (1 + 2 = 計 3 attempts)。 */
const WRITEBACK_MAX_RETRIES = 2;
/** 各リトライ前に sleep する基底 (ms)。attempt 倍率で線形バックオフ。 */
const WRITEBACK_RETRY_BASE_MS = 100;

/**
 * biblioName の正規表現 (2 要素 `<owner>--<repo>` または 3 要素 `<owner>--<repo>--<skill>` 形式)。
 *
 * 用途:
 * - dedup key: 別 owner の同名 repo を同一 quarantine dir で衝突させない。GitHub 規約上
 *   `--` は通常 repo 名に含まれず、`<owner>--<repo>` で衝突可能性を実務上ゼロにする。
 *   個別 skill 仕入れ (Phase 3 individual-acquire) では `<owner>--<repo>--<skill>` の
 *   3 要素まで許容する (= 同じ repo 内の別 skill を同一 quarantine に共存させるため)。
 * - path traversal 防御: agent が `inspect_biblio` 等で任意の文字列を送れるため、
 *   `path.join` 前に `../../tmp/evil` 形式を弾く必要がある。
 *
 * 文字クラスは `acquire.ts` の SEGMENT_RE と同じ集合を 2-3 セグメントに繋いだ形
 * (= 3 セグメント目は optional、2 要素のみの M2 全体仕入れ経路は引き続き valid)。
 *
 * 既知の greedy matching 挙動: 文字クラス `[A-Za-z0-9._-]*` が `-` を含むため、
 * `owner---repo` / `owner--repo--` / `owner--repo--skill--extra` 等の形式は **受理される**
 * (= 既存挙動、Phase 4 で 3 要素対応を追加した際も維持)。「先頭が英数字 + パスセパレータ
 * 防御」の最小限制約として運用上問題にならない (= GitHub repo 名にこれらの形は出ない)。
 * 受理範囲のテスト固定は `action-helpers.test.ts` に集約。
 */
export const BIBLIO_NAME_RE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*--[A-Za-z0-9][A-Za-z0-9._-]*(?:--[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

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
 * approval handler 共通の payload parser (= `enkin-action.ts` / `shokyaku-action.ts` で逐語コピー集約)。
 *
 * approval handler に届く `payload` は agent → delivery action handler → `requestApproval`
 * を経由して JSON serialize/deserialize されているため、型として `Record<string, unknown>`。
 * biblioName は string なら採用、category は string + `BIBLIO_CATEGORIES` 通過なら採用、
 * それ以外は安全側のデフォルト `biblio-dev` に落とす。後段で `BIBLIO_CATEGORIES.includes(category)`
 * の guard を呼べばデフォルトを含めて検証可能 (= 旧実装の動作互換)。
 *
 * 逐語コピーの分散を避けるため 1 箇所に集約。将来 category 追加 / 既定値変更の際に
 * 修正点が単一で済む。
 */
export function parseApprovalPayload(payload: Record<string, unknown>): {
  biblioName: string;
  category: BiblioCategory;
} {
  const biblioName = typeof payload.biblioName === 'string' ? payload.biblioName : '';
  const rawCategory = typeof payload.category === 'string' ? payload.category : null;
  const isKnownCategory = rawCategory !== null && BIBLIO_CATEGORIES.includes(rawCategory as BiblioCategory);
  const category: BiblioCategory = isKnownCategory ? (rawCategory as BiblioCategory) : 'biblio-dev';
  // 不正 category を無警告で `biblio-dev` に置換すると、shokyaku_confirm 等の破壊操作で
  // category 化けが起きた際に意図と違う shelf を対象にする上、デバッグ時に「なぜ
  // biblio-dev?」が謎になる (silent failure 撲滅)。fallback 発動時は warn を残す。
  if (rawCategory !== null && !isKnownCategory) {
    log.warn('parseApprovalPayload: unknown category, defaulting to biblio-dev', {
      event: 'biblio.validate',
      outcome: 'fallback',
      original_category: rawCategory,
      biblio_name: biblioName,
    });
  }
  return { biblioName, category };
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
 * 逐語コピーの分散を避けるため 1 箇所に集約。将来 category 追加 / メッセージ変更の際に
 * 修正点が単一で済む。
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
    log.warn(`${actionName} missing name`, {
      event: 'biblio.validate',
      outcome: 'failure',
      session_id: session.id,
    });
    await writeBackMessage(
      inDb,
      `${errorLabel}エラー (invalid_input): name が指定されていません。`,
      respPrefix,
      actionName,
    );
    return null;
  }
  if (!BIBLIO_NAME_RE.test(rawName)) {
    log.warn(`${actionName} invalid name`, {
      event: 'biblio.validate',
      outcome: 'failure',
      biblio_name: rawName,
      session_id: session.id,
    });
    await writeBackMessage(
      inDb,
      `${errorLabel}エラー (invalid_input): name が \`owner--name\` 形式ではありません: "${rawName}"`,
      respPrefix,
      actionName,
    );
    return null;
  }
  if (!rawCategory) {
    log.warn(`${actionName} missing category`, {
      event: 'biblio.validate',
      outcome: 'failure',
      session_id: session.id,
    });
    await writeBackMessage(
      inDb,
      `${errorLabel}エラー (invalid_input): category が指定されていません。`,
      respPrefix,
      actionName,
    );
    return null;
  }
  if (!BIBLIO_CATEGORIES.includes(rawCategory as BiblioCategory)) {
    log.warn(`${actionName} invalid category`, {
      event: 'biblio.validate',
      outcome: 'failure',
      category: rawCategory,
      session_id: session.id,
    });
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
