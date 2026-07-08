/**
 * `inspect_biblio` FunctionTool — ADK Runner 配下から既存 host action `inspect()` を呼ぶ wrap。
 *
 * `acquire_biblio` で quarantine に置かれた biblio を 3 軸 (schema → license → dangerous) で検査し、
 * ACCEPT / HOLD / REJECT を返す。設計理念は `acquire-tool.ts` 冒頭ドキュメント参照。
 *
 * **`BIBLIO_NAME_RE` 防御線** (= tool 層への追加):
 *   `BIBLIO_NAME_RE` (path traversal 防御線) は `src/biblio/inspect.ts` 内部には存在せず、
 *   従来は `src/biblio/inspect-action.ts:50` (= MCP delivery handler 経路) と
 *   `src/biblio/equip.ts:71` のみが持っていた。ADK tool 経路 (= LLM 自律呼出) は
 *   acquire_biblio の戻り値 `biblioName` をそのまま inspect_biblio に渡す前提だが、
 *   CLI/Slack 経路が本番化した以降、LLM が不正 `biblioName` を直接構成して
 *   投入する経路が現実的な攻撃面になる。ここで `execute` 冒頭に BIBLIO_NAME_RE guard を
 *   追加して fail-closed に REJECT + schema_invalid を返す (= inspect-action.ts の
 *   validation と同等)。
 */
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { BIBLIO_NAME_RE } from '../../biblio/action-helpers.js';
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
    // Path-traversal 防御: CLI/Slack 経路 + LLM 自律呼出が本番化して以降、
    // `biblioName` は LLM 生成の未検証文字列として扱う必要がある。`inspect-action.ts:50`
    // と同じ regex で fail-closed に REJECT + schema_invalid を返す。
    if (!BIBLIO_NAME_RE.test(biblioName)) {
      log.warn('ADK tool: inspect_biblio invalid name (path-traversal guard)', {
        event: 'adk.tool.inspect.schema_invalid',
        request_id: requestId,
        session_id: sessionId,
        biblio_name: biblioName,
      });
      return {
        verdict: 'REJECT',
        biblioName,
        reason: 'schema_invalid',
        detail: `biblioName does not match BIBLIO_NAME_RE: ${biblioName}`,
      };
    }
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
      // server-side log で可視化してから rethrow する (= silent failure 撲滅)。
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
