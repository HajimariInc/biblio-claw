/**
 * `shelve_biblio_multi` FunctionTool — ADK Runner 配下から既存 host action `shelveMulti()` を呼ぶ wrap。
 *
 * 複数 (biblioName, category, reason) を 1 PR にまとめて陳列する。単一 skill / 単一 category
 * なら `shelve_biblio` を使う (= 単一経路は既存の branch 名 / commit message / PR body を維持する
 * shelveMulti 内の分岐で完全互換)。設計理念は `acquire-tool.ts` / `shelve-tool.ts` 冒頭
 * ドキュメント参照。
 *
 * **GOTCHA**:
 *   1. 各 `biblioName` に対して execute 冒頭で `BIBLIO_NAME_RE` guard を loop で走らせる
 *      (= per-req 物理移動が `path.join(shelfRoot, category, biblioName)` を通るため path-traversal 防御)。
 *      reject 時は `failMulti` 相当の `MultiShelveResult.ok=false` を return。
 *   2. `SHELVE_REASON_MAX_LEN` は `shelve-tool.ts` と同値の 200 char (= 二重定義だが、tool 層 export
 *      の import 依存を減らすため hardcode。将来 shared const 化する場合は 1 箇所に集約)。
 *   3. `items.length` の運用上限 (~10 件目安) は Zod schema では強制せず tool description に記載のみ
 *      (= `MAX_BLOBS_PER_PR` で hard limit の代替、strict enforce は `shelveMulti()` 内部の
 *      `github_api_error` fail-close に任せる)。
 */
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { BIBLIO_NAME_RE } from '../../biblio/action-helpers.js';
import { shelveMulti } from '../../biblio/shelve.js';
import { BIBLIO_CATEGORIES, type MultiShelveResult } from '../../biblio/types.js';
import { log } from '../../log.js';

import { resolveToolCtx } from './tool-ctx.js';

const SHELVE_REASON_MAX_LEN = 200;

const ShelveBiblioMultiInput = z.object({
  items: z
    .array(
      z.object({
        biblioName: z
          .string()
          .describe(
            'Biblio name in "<owner>--<repo>" or "<owner>--<repo>--<skill>" format (e.g. "HajimariInc--test-biblio-minimal").',
          ),
        category: z
          .enum(BIBLIO_CATEGORIES)
          .describe('Target shelf namespace. One of: biblio-dev, biblio-art, biblio-bf, biblio-ai.'),
        reason: z
          .string()
          .min(1)
          .max(SHELVE_REASON_MAX_LEN)
          .describe(
            `Short reason for shelving this biblio in the given category (1-${SHELVE_REASON_MAX_LEN} chars). Will be included in the PR body under a per-category section.`,
          ),
      }),
    )
    .min(1)
    .describe(
      'Array of { biblioName, category, reason } items. Use shelve_biblio for single-item shelving. Recommended max ~10 items per call (hard limit enforced by MAX_BLOBS_PER_PR inside shelveMulti).',
    ),
});

export const shelveBiblioMultiTool = new FunctionTool({
  name: 'shelve_biblio_multi',
  description:
    'Shelve multiple ACCEPTed biblios into potentially different categories in a single draft PR. All items succeed or all fail (atomic, no partial success). Returns MultiShelveResult { ok: true, prUrl, prNumber, branchName, items } on success, or { ok: false, reason, detail, items } on failure (reasons include empty_items, duplicate_biblio_name, already_shelved, quarantine_missing, github_api_error, rename_error, invalid_category, config_error).',
  parameters: ShelveBiblioMultiInput,
  execute: async ({ items }, tool_context): Promise<MultiShelveResult> => {
    const { requestId, sessionId } = resolveToolCtx(tool_context);
    // Path-traversal 防御: 各 biblioName を BIBLIO_NAME_RE で loop check。1 件でも不正なら
    // shelveMulti を呼ばず fail-closed に。`MultiShelveFailureReason` には `schema_invalid` が
    // 無いため `invalid_category` に集約するのは意味的に不適切 → 既存 `config_error` を
    // 借用 (= 「入力設定不備」の意味合いで一致、`shelveMulti()` の env 欠落と同じ扱い)。
    for (const item of items) {
      if (!BIBLIO_NAME_RE.test(item.biblioName)) {
        log.warn('ADK tool: shelve_biblio_multi invalid name (path-traversal guard)', {
          event: 'adk.tool.shelve_multi.schema_invalid',
          request_id: requestId,
          session_id: sessionId,
          biblio_name: item.biblioName,
        });
        return {
          ok: false,
          reason: 'config_error',
          detail: `biblioName does not match BIBLIO_NAME_RE: ${item.biblioName}`,
          items: items.map((i) => ({ biblioName: i.biblioName, category: i.category })),
        };
      }
    }
    log.info('ADK tool: shelve_biblio_multi invoked', {
      event: 'adk.tool.shelve_multi.invoke',
      request_id: requestId,
      session_id: sessionId,
      count: items.length,
      biblios: items.map((i) => ({ biblioName: i.biblioName, category: i.category })),
    });
    try {
      return await shelveMulti(items, { ctx: { requestId, sessionId } });
    } catch (err) {
      // `shelveMulti()` は throw しない契約 (= MultiShelveResult.ok=false に倒す)。
      // 万一の unexpected throw を server-side log で可視化してから rethrow (= silent failure 撲滅)。
      log.error('ADK tool: shelve_biblio_multi unexpected throw', {
        event: 'adk.tool.shelve_multi.unexpected_error',
        request_id: requestId,
        session_id: sessionId,
        count: items.length,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});
