/**
 * `inspect_biblio` FunctionTool — ADK Runner 配下から既存 host action `inspect()` を呼ぶ wrap (M4-B Phase 1)。
 *
 * `acquire_biblio` で quarantine に置かれた biblio を 3 軸 (schema → license → dangerous) で検査し、
 * ACCEPT / HOLD / REJECT を返す。設計理念は `acquire-tool.ts` 冒頭ドキュメント参照。
 *
 * **GOTCHA (plan Task 3)**: `BIBLIO_NAME_RE` (= path traversal 防御線) の再現は tool レベルで
 * 重複させない (= `inspect()` 内部で同等 validation が走る、防御の二重化は HOLD 出力の
 * 一貫性を崩す)。Zod schema は `biblioName: z.string()` のみで `inspect()` の戻り値 error path
 * (= `verdict: 'HOLD' | 'REJECT'`) に任せる。
 */
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { inspect } from '../../biblio/inspect.js';
import type { InspectResult } from '../../biblio/types.js';
import { log } from '../../log.js';

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
    const requestId = tool_context?.invocationContext.invocationId ?? crypto.randomUUID();
    const sessionId = tool_context?.invocationContext.session.id ?? '';
    log.info('ADK tool: inspect_biblio invoked', {
      event: 'adk.tool.inspect.invoke',
      request_id: requestId,
      session_id: sessionId,
      biblio_name: biblioName,
    });
    return await inspect({ biblioName }, { ctx: { requestId, sessionId } });
  },
});
