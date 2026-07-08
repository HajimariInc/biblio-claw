/**
 * `update_config` FunctionTool — ADK Runner 配下から biblio 設定 (allowlist: ACQUIRE_SKILL_THRESHOLD)
 * を動的変更する wrap。
 *
 * `setBiblioSetting()` を直接呼び、delivery 経路の `config-action.ts` は経由しない (= ADK 経路には
 * session が無く `isConfigChangeAllowed(session)` の admin check が呼べないため、admin check は
 * ADK 経路では省略する設計判断)。allowlist と key-specific value validation は共通コード
 * (`BIBLIO_SETTING_KEYS` + `validateValueForKey`) を import して二重定義を避ける。
 *
 * 設計理念は `acquire-tool.ts` 冒頭ドキュメント参照。
 */
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { validateValueForKey } from '../../biblio/config-validation.js';
import { BIBLIO_SETTING_KEYS, type BiblioSettingKey } from '../../biblio/types.js';
import { setBiblioSetting } from '../../db/biblio-settings.js';
import { log } from '../../log.js';

import { resolveToolCtx } from './tool-ctx.js';

/**
 * tool 内部 return type (= 新規、`src/biblio/types.ts` には置かない = ADK 経路専用の
 * discriminated union、delivery 経路は writeBackMessage で文字列を返すため独自 shape 不要)。
 */
export type ConfigUpdateResult =
  { ok: true; key: BiblioSettingKey; value: string } | { ok: false; reason: 'invalid_value'; detail: string };

const UpdateConfigInput = z.object({
  key: z
    .enum(BIBLIO_SETTING_KEYS)
    .describe(
      'Setting key. Allowlist: ACQUIRE_SKILL_THRESHOLD (positive integer as string, e.g., "25"). Any key outside the allowlist is rejected by Zod schema validation.',
    ),
  value: z
    .string()
    .min(1)
    .describe('Setting value as a string. For ACQUIRE_SKILL_THRESHOLD, this must be a positive integer (e.g., "25").'),
});

export const updateConfigTool = new FunctionTool({
  name: 'update_config',
  description:
    'Update a biblio setting dynamically (allowlist: ACQUIRE_SKILL_THRESHOLD). The change takes effect from the next acquire() call. Returns { ok: true, key, value } on success, or { ok: false, reason: "invalid_value", detail } on value validation failure. Admin check is NOT enforced in this ADK path — Zod schema restricts the key allowlist, and routing-level access control is assumed.',
  parameters: UpdateConfigInput,
  execute: async ({ key, value }, tool_context): Promise<ConfigUpdateResult> => {
    const { requestId, sessionId } = resolveToolCtx(tool_context);
    log.info('ADK tool: update_config invoked', {
      event: 'adk.tool.config.invoke',
      request_id: requestId,
      session_id: sessionId,
      key,
      value,
    });
    // key-specific value validation (delivery 経路の config-action.ts と同じ logic を共通関数から呼ぶ)
    const valueErr = validateValueForKey(key, value);
    if (valueErr !== null) {
      log.warn('ADK tool: update_config invalid value for key', {
        event: 'adk.tool.config.invalid_value',
        request_id: requestId,
        session_id: sessionId,
        key,
        value,
      });
      return { ok: false, reason: 'invalid_value', detail: valueErr };
    }
    try {
      setBiblioSetting(key, value);
      log.info('ADK tool: update_config applied', {
        event: 'adk.tool.config.applied',
        request_id: requestId,
        session_id: sessionId,
        key,
        value,
      });
      return { ok: true, key, value };
    } catch (err) {
      // `setBiblioSetting()` は throw しない設計だが、DB layer の予期しない障害 (SQLITE_BUSY 等) を
      // silent に握ると patron 認知と実態が乖離するため、log.error で可視化してから rethrow する
      // (= silent failure 撲滅、他 tool と同流儀)。
      log.error('ADK tool: update_config unexpected throw', {
        event: 'adk.tool.config.unexpected_error',
        request_id: requestId,
        session_id: sessionId,
        key,
        value,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});
