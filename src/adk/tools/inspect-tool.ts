/**
 * `inspect_biblio` FunctionTool — ADK Runner 配下から既存 host action `inspect()` を呼ぶ wrap (M4-B Phase 1)。
 *
 * `acquire_biblio` で quarantine に置かれた biblio を 3 軸 (schema → license → dangerous) で検査し、
 * ACCEPT / HOLD / REJECT を返す。設計理念は `acquire-tool.ts` 冒頭ドキュメント参照。
 *
 * **GOTCHA — `BIBLIO_NAME_RE` 防御線の所在** (= comment-analyzer C5 で事実訂正):
 *   `BIBLIO_NAME_RE` (path traversal 防御線) は `src/biblio/inspect.ts` 内部には **存在しない**。
 *   実際の所在は `src/biblio/inspect-action.ts:50` (= MCP delivery handler 経路) と
 *   `src/biblio/equip.ts:71` のみ。MCP/delivery 経路では action handler 入口で validation 済の
 *   `biblioName` が `inspect()` に渡される前提。一方、本 ADK tool 経路は **acquire_biblio の戻り値
 *   `biblioName` をそのまま inspect_biblio に渡す前提** (= LLM が再構築せずパススルー) のため、
 *   `inspect()` 自身は `path.join(quarantineRoot, biblioName)` (= 正規化のみ、traversal 拒否なし)
 *   で受ける。
 *
 *   **影響と申し送り** (= Phase 3 Slack 本番化前):
 *     - 現状 Phase 1 では local verify-script のみで起動するため攻撃面なし
 *     - Phase 3 で Slack patron 経路 → ADK Runner → LLM 自律呼出 → 不正 `biblioName` 直接渡し
 *       が成立した場合、`schema_invalid` REJECT に倒れるがファイルシステム探索は実行される
 *     - tool 層での `BIBLIO_NAME_RE` 同等 validation 追加を Phase 3 で検討すべき (= 別 issue
 *       として記録するか、本 PR フォローアップで対応)
 */
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { inspect } from '../../biblio/inspect.js';
import type { InspectResult } from '../../biblio/types.js';
import { log } from '../../log.js';

import { resolveToolCtx } from './tool-ctx.js';

const InspectBiblioInput = z.object({
  biblioName: z
    .string()
    .describe(
      'Biblio name in "<owner>--<repo>" or "<owner>--<repo>--<skill>" format (e.g. "example-org--biblio-min"). Use the biblioName returned by acquire_biblio.',
    ),
});

/**
 * `inspect_biblio` tool。`inspect()` への `quarantineRoot` opts は test/verify 専用なので
 * tool 経路では渡さない (= 本番 `${DATA_DIR}/quarantine` を使う)。
 */
export const inspectBiblioTool = new FunctionTool({
  name: 'inspect_biblio',
  description:
    'Inspect an acquired biblio for shelf eligibility using 3 axes (schema → license → dangerous code). Returns InspectResult { verdict: "ACCEPT" | "HOLD" | "REJECT" } with biblioName and (on HOLD/REJECT) reason + detail (schema_invalid, license_denied, license_unknown, dangerous_code, inspect_error).',
  parameters: InspectBiblioInput,
  execute: async ({ biblioName }, tool_context): Promise<InspectResult> => {
    const { requestId, sessionId } = resolveToolCtx(tool_context);
    log.info('ADK tool: inspect_biblio invoked', {
      event: 'adk.tool.inspect.invoke',
      request_id: requestId,
      session_id: sessionId,
      biblio_name: biblioName,
    });
    try {
      return await inspect({ biblioName }, { ctx: { requestId, sessionId } });
    } catch (err) {
      // `inspect()` は throw しない契約 (= HOLD/inspect_error に倒す)。万一の unexpected throw を
      // server-side log で可視化してから rethrow する (= silent-failure-hunter I1)。
      log.error('ADK tool: inspect_biblio unexpected throw', {
        event: 'adk.tool.inspect.unexpected_error',
        request_id: requestId,
        session_id: sessionId,
        biblio_name: biblioName,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});
