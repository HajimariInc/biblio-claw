/**
 * `categorize_biblio` FunctionTool — ADK Runner 配下から既存 host action `categorize()` を呼ぶ wrap (M4-B Phase 4)。
 *
 * ACCEPT 済 biblio を 4 namespace (biblio-dev/art/bf/ai) に判定する。Vertex × Anthropic Claude
 * が判定し、`CategoryResult` を返す。設計理念は `acquire-tool.ts` / `inspect-tool.ts` 冒頭
 * ドキュメント参照 (`FunctionTool` wrap 流儀、`withBiblioActionSpan` を tool 内で呼ばない、
 * `BIBLIO_NAME_RE` guard で path-traversal 防御、`throw しない` 契約は既存 handler と同じ)。
 */
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { BIBLIO_NAME_RE } from '../../biblio/action-helpers.js';
import { categorize } from '../../biblio/categorize.js';
import type { CategoryResult } from '../../biblio/types.js';
import { log } from '../../log.js';

import { resolveToolCtx } from './tool-ctx.js';

const CategorizeBiblioInput = z.object({
  biblioName: z
    .string()
    .describe(
      'Biblio name in "<owner>--<repo>" or "<owner>--<repo>--<skill>" format (e.g. "example-org--biblio-min"). Use the biblioName returned by acquire_biblio / inspect_biblio.',
    ),
});

export const categorizeBiblioTool = new FunctionTool({
  name: 'categorize_biblio',
  description:
    'Categorize an ACCEPTed biblio into one of 4 shelf namespaces (biblio-dev / biblio-art / biblio-bf / biblio-ai) via Vertex × Anthropic Claude. Returns CategoryResult { ok: true, biblioName, category, reason } on success, or { ok: false, reason, detail } on failure (reasons: quarantine_missing, llm_error, parse_error, invalid_category).',
  parameters: CategorizeBiblioInput,
  execute: async ({ biblioName }, tool_context): Promise<CategoryResult> => {
    const { requestId, sessionId } = resolveToolCtx(tool_context);
    // Path-traversal 防御 (inspect-tool.ts Phase 3 と同流儀): categorize.ts 内部で
    // `path.join(quarantineRoot, biblioName)` が走るため、不正 name は fail-closed に。
    // `CategoryFailureReason` には `schema_invalid` がないため `quarantine_missing` に集約
    // する (= 実質「不正 name の quarantine dir は存在し得ない」意味合いで一致)。
    if (!BIBLIO_NAME_RE.test(biblioName)) {
      log.warn('ADK tool: categorize_biblio invalid name (path-traversal guard)', {
        event: 'adk.tool.categorize.schema_invalid',
        request_id: requestId,
        session_id: sessionId,
        biblio_name: biblioName,
      });
      return {
        ok: false,
        biblioName,
        reason: 'quarantine_missing',
        detail: `biblioName does not match BIBLIO_NAME_RE: ${biblioName}`,
      };
    }
    log.info('ADK tool: categorize_biblio invoked', {
      event: 'adk.tool.categorize.invoke',
      request_id: requestId,
      session_id: sessionId,
      biblio_name: biblioName,
    });
    try {
      return await categorize({ biblioName }, { ctx: { requestId, sessionId } });
    } catch (err) {
      // `categorize()` は throw しない契約 (= CategoryResult.ok=false に倒す)。万一の unexpected throw
      // を server-side log で可視化してから rethrow する (= silent-failure-hunter I1)。
      log.error('ADK tool: categorize_biblio unexpected throw', {
        event: 'adk.tool.categorize.unexpected_error',
        request_id: requestId,
        session_id: sessionId,
        biblio_name: biblioName,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});
