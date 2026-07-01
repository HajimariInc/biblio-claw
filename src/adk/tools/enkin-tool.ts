/**
 * `enkin_biblio` FunctionTool — ADK Runner 配下から既存 host action `enkin()` を呼ぶ HITL 対応 wrap (M4-B Phase 4)。
 *
 * 禁書 = 棚除去 + 装備源残置 (= 再装備可)。破壊操作のため admin 承認を必須とし、`Context.requestConfirmation`
 * API で自動 pause / resume する 2 段構造を採る (adk-js@1.3.0 `@experimental`)。
 *
 * # HITL pause/resume パターン (plan Pattern 2)
 *
 * 1. **初回呼出** (tool_context.toolConfirmation が undefined):
 *    - `BIBLIO_NAME_RE` guard → 不正なら即 fail (`config_error`)
 *    - `tool_context.requestConfirmation({hint, payload: {biblioName, category, action: 'enkin'}})`
 *    - runner が自動 pause (= event.longRunningToolIds に `functionCallId` を populate)
 *    - dispatcher が pending 検知 → `requestAdkApproval` 経由で admin に Slack DM カード配信
 *    - return 値は runner に無視される (= pause で先取り) が型上必要なため pending sentinel を返す
 *
 * 2. **Resume 呼出** (admin が Approve/Reject 押下 → response-handler → resolveAdkApproval →
 *    runAsync に functionResponse を送り込む → tool.execute が toolConfirmation 付きで再実行):
 *    - `tool_context.toolConfirmation.confirmed === true`: 実 `enkin()` を呼出、結果を LLM に返す
 *    - `tool_context.toolConfirmation.confirmed === false`: 拒否応答 (`config_error`, detail に「admin 拒否」)
 *
 * # GOTCHA (plan Task 6)
 *
 * 1. **`requestConfirmation` 呼出後の return 値は runner に無視される** (runner が pause で先取り)、
 *    ただし型上 `EnkinResult` 返却が必要なため pending sentinel を return (= 実行されない dead code だが型合わせ)
 * 2. **承認 reject 時の reason 分類**: 既存 `UnshelveFailureReason` に `user_rejected` 相当なし。
 *    Phase 4 では `config_error` に集約 (= 型変更を避け、detail 文字列で patron 認知)。
 *    将来 Phase 90 で `UnshelveFailureReason` に `'user_rejected'` 追加を検討
 * 3. **description に「Requires admin approval via Slack DM Approve/Reject card」明示** — LLM が
 *    「承認が必要な破壊操作」と認識できるように
 * 4. **log event 命名**: `adk.tool.enkin.confirmation_requested` (初回) / `adk.tool.enkin.resumed`
 *    (resume) / `adk.tool.enkin.unexpected_error` (throw) の 3 種、structured log 追跡用
 */
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { BIBLIO_NAME_RE } from '../../biblio/action-helpers.js';
import { enkin } from '../../biblio/enkin.js';
import { BIBLIO_CATEGORIES, type EnkinResult } from '../../biblio/types.js';
import { log } from '../../log.js';

import { resolveToolCtx } from './tool-ctx.js';

const EnkinBiblioInput = z.object({
  biblioName: z
    .string()
    .describe(
      'Biblio name in "<owner>--<repo>" or "<owner>--<repo>--<skill>" format (e.g. "example-org--biblio-min"). Use the biblioName returned by list_biblio or specified explicitly by the patron.',
    ),
  category: z
    .enum(BIBLIO_CATEGORIES)
    .describe('Shelf namespace the biblio currently lives in. One of: biblio-dev, biblio-art, biblio-bf, biblio-ai.'),
});

export const enkinBiblioTool = new FunctionTool({
  name: 'enkin_biblio',
  description:
    'Ban a biblio from the shelf (removal) while keeping the equipment source intact (= re-equipable). **Requires admin approval via Slack DM Approve/Reject card before execution.** Returns EnkinResult { ok: true, biblioName, category, prUrl, prNumber, branchName } on success, or { ok: false, biblioName, reason, detail } on failure/rejection (reasons: not_shelved, github_api_error, invalid_category, config_error — config_error is also used for admin rejection).',
  parameters: EnkinBiblioInput,
  execute: async ({ biblioName, category }, tool_context): Promise<EnkinResult> => {
    const { requestId, sessionId } = resolveToolCtx(tool_context);

    // Path-traversal 防御 (inspect-tool.ts Phase 3 と同流儀)
    if (!BIBLIO_NAME_RE.test(biblioName)) {
      log.warn('ADK tool: enkin_biblio invalid name (path-traversal guard)', {
        event: 'adk.tool.enkin.schema_invalid',
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

    // Resume 経路: tool_context.toolConfirmation が存在 = 前回 pause から復帰
    if (tool_context?.toolConfirmation) {
      const confirmed = tool_context.toolConfirmation.confirmed;
      log.info('ADK tool: enkin_biblio resumed from approval', {
        event: 'adk.tool.enkin.resumed',
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
          detail: 'admin によって禁書が拒否されました。',
        };
      }
      // 承認済 → 実 enkin() 呼出
      try {
        return await enkin({ biblioName, category }, { ctx: { requestId, sessionId } });
      } catch (err) {
        log.error('ADK tool: enkin_biblio unexpected throw after approval', {
          event: 'adk.tool.enkin.unexpected_error',
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
    // tool_context が undefined になる経路は現実的に到達しない (= adk-js@1.3.0 の runAsync 経路では
    // 必ず Context が渡る) が、型上 optional のため fallback として requestConfirmation を呼ばず
    // fail-closed に倒す (= silent skip 禁止、request が pause できないなら実行もできない)。
    if (!tool_context) {
      log.error('ADK tool: enkin_biblio tool_context undefined (cannot request confirmation)', {
        event: 'adk.tool.enkin.no_context',
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
    log.info('ADK tool: enkin_biblio requesting confirmation', {
      event: 'adk.tool.enkin.confirmation_requested',
      request_id: requestId,
      session_id: sessionId,
      biblio_name: biblioName,
      category,
    });
    tool_context.requestConfirmation({
      hint: `禁書: ${biblioName} (${category}) を棚から除去します。装備源は残置 (= 再装備可)。承認しますか?`,
      payload: { biblioName, category, action: 'enkin' as const },
    });
    // 型上 EnkinResult を返す必要があるが、runner は pause で先取りするためこの return は
    // 実行されない (= dead code、型合わせ)。GOTCHA 1 参照。
    return {
      ok: false,
      biblioName,
      reason: 'config_error',
      detail: '(承認待ち)',
    };
  },
});
