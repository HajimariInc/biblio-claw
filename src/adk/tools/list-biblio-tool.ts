/**
 * `list_biblio` FunctionTool — ADK Runner 配下から既存 host action `listBiblio()` を呼ぶ wrap。
 *
 * 棚 (HajimariInc/biblio-shelf) の marketplace.json から蔵書一覧を取得する。category 未指定で
 * 全件、指定時はそのカテゴリで絞り込み。404 (marketplace.json 未存在) は「棚が空」として
 * ok:true / items:[] を返す (listBiblio() の契約)。設計理念は `acquire-tool.ts` 冒頭ドキュメント参照。
 */
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { listBiblio } from '../../biblio/list-biblio.js';
import { BIBLIO_CATEGORIES, type ListBiblioResult } from '../../biblio/types.js';
import { log } from '../../log.js';

import { resolveToolCtx } from './tool-ctx.js';

const ListBiblioInput = z.object({
  category: z
    .enum(BIBLIO_CATEGORIES)
    .optional()
    .describe(
      'Filter by shelf namespace. One of: biblio-dev (developer tools), biblio-art (creative), biblio-bf (back-office), biblio-ai (AI orchestration). Omit to list all categories.',
    ),
});

export const listBiblioTool = new FunctionTool({
  name: 'list_biblio',
  description:
    'List biblios currently shelved on the shelf (HajimariInc/biblio-shelf). Optionally filter by category. Returns ListBiblioResult { ok: true, items, counts, total, appliedFilter } — counts is always the total (pre-filter) breakdown by category, items is the post-filter list. Empty shelf (404) returns ok:true with empty items.',
  parameters: ListBiblioInput,
  execute: async ({ category }, tool_context): Promise<ListBiblioResult> => {
    const { requestId, sessionId } = resolveToolCtx(tool_context);
    log.info('ADK tool: list_biblio invoked', {
      event: 'adk.tool.list.invoke',
      request_id: requestId,
      session_id: sessionId,
      category: category ?? null,
    });
    try {
      // category を明示的に条件付きで渡す (= undefined 時は params オブジェクトから省く)
      // listBiblio() は `params.category ?? null` で吸収するため、どちらでも同じ挙動だが
      // 「未指定 = 全件」の意図を型で表現するため spread pattern を使う。
      const params = category !== undefined ? { category } : {};
      return await listBiblio(params, { ctx: { requestId, sessionId } });
    } catch (err) {
      // `listBiblio()` は throw しない契約 (= ok:true 固定、404 も空リストで正常応答)。
      // 万一の unexpected throw を server-side log で可視化してから rethrow する (= silent failure 撲滅)。
      log.error('ADK tool: list_biblio unexpected throw', {
        event: 'adk.tool.list.unexpected_error',
        request_id: requestId,
        session_id: sessionId,
        category: category ?? null,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});
