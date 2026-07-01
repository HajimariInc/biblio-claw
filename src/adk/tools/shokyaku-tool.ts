/**
 * `shokyaku_biblio` FunctionTool — ADK Runner 配下から既存 host action `shokyaku()` を呼ぶ HITL 対応 wrap (M4-B Phase 4)。
 *
 * 焼却 = 棚除去 + 装備源物理削除 + 全 session の装備リスト個別削除 (= 再装備不可)。破壊操作
 * かつ物理削除を伴うため、admin 承認を必須とし、`Context.requestConfirmation` API で自動 pause /
 * resume する 2 段構造を採る (adk-js@1.3.0 `@experimental`)。設計理念は `enkin-tool.ts` 冒頭参照。
 *
 * # enkin との違い
 *
 * 1. hint 文言に「装備源も物理削除 = 再装備不可」を明示 (= 禁書との違いを admin が判断可能に)
 * 2. Resume 成功時に `result.cleanupWarning` が存在すれば log.warn で追跡 (patron 通知は
 *    LLM が result を見て整形、tool 層では返り値を LLM に渡すのみ)
 * 3. return type は `ShokyakuResult` (= `UnshelveResult` + `cleanupWarning?` 拡張)
 */
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { BIBLIO_NAME_RE } from '../../biblio/action-helpers.js';
import { shokyaku } from '../../biblio/shokyaku.js';
import { BIBLIO_CATEGORIES, type ShokyakuResult } from '../../biblio/types.js';
import { log } from '../../log.js';

import type { HitlConfirmationPayload } from './hitl-types.js';
import { resolveToolCtx } from './tool-ctx.js';

const ShokyakuBiblioInput = z.object({
  biblioName: z
    .string()
    .describe(
      'Biblio name in "<owner>--<repo>" or "<owner>--<repo>--<skill>" format (e.g. "example-org--biblio-min"). Use the biblioName returned by list_biblio or specified explicitly by the patron.',
    ),
  category: z
    .enum(BIBLIO_CATEGORIES)
    .describe('Shelf namespace the biblio currently lives in. One of: biblio-dev, biblio-art, biblio-bf, biblio-ai.'),
});

export const shokyakuBiblioTool = new FunctionTool({
  name: 'shokyaku_biblio',
  description:
    'Burn a biblio: remove from the shelf AND physically delete the equipment source (= NOT re-equipable). **This is a destructive, irreversible operation. Requires admin approval via Slack DM Approve/Reject card before execution.** Returns ShokyakuResult { ok: true, biblioName, category, prUrl, prNumber, branchName, cleanupWarning? } on success (cleanupWarning is set if host-side cleanup partially failed but the shelf PR succeeded), or { ok: false, biblioName, reason, detail } on failure/rejection (reasons: not_shelved, github_api_error, invalid_category, config_error — config_error is also used for admin rejection).',
  parameters: ShokyakuBiblioInput,
  execute: async ({ biblioName, category }, tool_context): Promise<ShokyakuResult> => {
    const { requestId, sessionId } = resolveToolCtx(tool_context);

    // Path-traversal 防御 (enkin-tool.ts と同流儀)
    if (!BIBLIO_NAME_RE.test(biblioName)) {
      log.warn('ADK tool: shokyaku_biblio invalid name (path-traversal guard)', {
        event: 'adk.tool.shokyaku.schema_invalid',
        request_id: requestId,
        session_id: sessionId,
        biblio_name: biblioName,
      });
      return {
        ok: false,
        biblioName,
        reason: 'config_error',
        detail: `biblioName does not match BIBLIO_NAME_RE: ${biblioName}`,
      };
    }

    // Resume 経路
    if (tool_context?.toolConfirmation) {
      const confirmed = tool_context.toolConfirmation.confirmed;
      log.info('ADK tool: shokyaku_biblio resumed from approval', {
        event: 'adk.tool.shokyaku.resumed',
        request_id: requestId,
        session_id: sessionId,
        biblio_name: biblioName,
        category,
        confirmed,
      });
      if (!confirmed) {
        return {
          ok: false,
          biblioName,
          reason: 'config_error',
          detail: 'admin によって焼却が拒否されました。',
        };
      }
      try {
        const result = await shokyaku({ biblioName, category }, { ctx: { requestId, sessionId } });
        // cleanupWarning の発生を log.warn で追跡 (Task 7 GOTCHA 2、patron 通知は LLM が result を見て整形)
        if (result.ok && result.cleanupWarning) {
          log.warn('ADK tool: shokyaku_biblio cleanup warning', {
            event: 'adk.tool.shokyaku.cleanup_warning',
            request_id: requestId,
            session_id: sessionId,
            biblio_name: biblioName,
            category,
            cleanup_warning: result.cleanupWarning,
          });
        }
        return result;
      } catch (err) {
        log.error('ADK tool: shokyaku_biblio unexpected throw after approval', {
          event: 'adk.tool.shokyaku.unexpected_error',
          request_id: requestId,
          session_id: sessionId,
          biblio_name: biblioName,
          category,
          err: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    // 初回呼出: 承認要求 → runner が自動 pause
    if (!tool_context) {
      log.error('ADK tool: shokyaku_biblio tool_context undefined (cannot request confirmation)', {
        event: 'adk.tool.shokyaku.no_context',
        request_id: requestId,
        session_id: sessionId,
        biblio_name: biblioName,
      });
      return {
        ok: false,
        biblioName,
        reason: 'config_error',
        detail: 'ADK tool_context 不在で承認要求が発火できません (internal error)。',
      };
    }
    log.info('ADK tool: shokyaku_biblio requesting confirmation', {
      event: 'adk.tool.shokyaku.confirmation_requested',
      request_id: requestId,
      session_id: sessionId,
      biblio_name: biblioName,
      category,
    });
    const confirmationPayload: HitlConfirmationPayload = { biblioName, category, action: 'shokyaku' };
    tool_context.requestConfirmation({
      hint: `焼却: ${biblioName} (${category}) を棚から除去し、装備源も物理削除します (= 再装備不可、破壊操作)。承認しますか?`,
      payload: confirmationPayload,
    });
    return {
      ok: false,
      biblioName,
      reason: 'config_error',
      detail: '(承認待ち)',
    };
  },
});
