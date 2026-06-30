/**
 * `shelve_biblio` FunctionTool — ADK Runner 配下から既存 host action `shelve()` を呼ぶ wrap (M4-B Phase 1)。
 *
 * `inspect_biblio` で ACCEPT 判定された biblio を棚 (= HajimariInc/biblio-shelf) に陳列する draft PR を
 * 作成する。設計理念は `acquire-tool.ts` 冒頭ドキュメント参照。
 *
 * **GOTCHA (plan Task 4)**:
 *   1. `BIBLIO_CATEGORIES` を `z.enum` に hardcode せず、`as const` 配列を動的参照する
 *      (= 型 + 値の単一源、`BIBLIO_CATEGORIES` を 1 箇所修正すれば LLM 公開 schema も追従)
 *   2. `shelveMulti` (= 複数 skill 跨ぎ陳列) の tool 化は本 Phase で見送り (= 任意 Phase 4)、
 *      単一 `shelve()` のみで MVP 成立 (Plan §意思決定ログ)
 */
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { shelve } from '../../biblio/shelve.js';
import { BIBLIO_CATEGORIES, type ShelveResult } from '../../biblio/types.js';
import { log } from '../../log.js';

const ShelveBiblioInput = z.object({
  biblioName: z
    .string()
    .describe(
      'Biblio name in "<owner>--<repo>" or "<owner>--<repo>--<skill>" format (e.g. "example-org--biblio-min"). Use the biblioName returned by acquire_biblio / inspect_biblio.',
    ),
  category: z
    .enum(BIBLIO_CATEGORIES)
    .describe(
      'Target shelf namespace. One of: biblio-dev (developer tools), biblio-art (creative), biblio-bf (back-office), biblio-ai (AI orchestration).',
    ),
  reason: z
    .string()
    .min(1)
    .max(200)
    .describe('Short reason for shelving in this category (1-200 chars). Will be included in the draft PR body.'),
});

/**
 * `shelve_biblio` tool。`quarantineRoot` / `shelfRoot` の opts は test/verify 専用なので tool 経路では渡さない。
 */
export const shelveBiblioTool = new FunctionTool({
  name: 'shelve_biblio',
  description:
    'Shelve an ACCEPTed biblio into a shelf category by creating a draft PR. Returns ShelveResult { ok: true, prUrl, prNumber, branchName } on success, or { ok: false, reason, detail } on failure (reasons: already_shelved, quarantine_missing, github_api_error, rename_error, invalid_category, config_error).',
  parameters: ShelveBiblioInput,
  execute: async ({ biblioName, category, reason }, tool_context): Promise<ShelveResult> => {
    const requestId = tool_context?.invocationContext.invocationId ?? crypto.randomUUID();
    const sessionId = tool_context?.invocationContext.session.id ?? '';
    log.info('ADK tool: shelve_biblio invoked', {
      event: 'adk.tool.shelve.invoke',
      request_id: requestId,
      session_id: sessionId,
      biblio_name: biblioName,
      category,
    });
    return await shelve({ biblioName, category, reason }, { ctx: { requestId, sessionId } });
  },
});
