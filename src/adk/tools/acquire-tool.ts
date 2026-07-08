/**
 * `acquire_biblio` FunctionTool — ADK Runner 配下から既存 host action `acquire()` を呼ぶ wrap。
 *
 * `LlmAgent.tools` に渡す `BaseTool` インスタンス。LLM が tool 自律選択した時に `execute` が
 * 呼ばれ、既存 `src/biblio/acquire.ts:acquire()` 純粋関数 (= touch せず再利用) に委譲する。
 *
 * **設計判断**:
 *   - `FunctionTool` wrap 流儀 (= adk-js 公式 sample `customer_service` 流儀、`BaseAgent` 継承 /
 *     `AgentTool` wrap は不採用 = issue #334 の sub-agent intermediate event 隠蔽回避)
 *   - `withBiblioActionSpan` を tool 内で呼ばない (= ADK 自動 span `execute_tool` に任せる、
 *     重複 span 防止。delivery action handler 経路 = 並走維持で `withBiblioActionSpan` 継続)
 *   - Zod schema は `repo` 1 つだけ (= 個別 skill `owner/repo/skill` は `normalizeRepo` 内で吸収、
 *     tool レベルでは patron 入力の string 1 つに集約 = LLM 推論コスト最小化)
 *
 * **既存 host action 経路との並走**:
 *   - MCP → outbound.db → delivery → `acquire-action.ts` → `withBiblioActionSpan` →
 *     `acquire()` → `writeBackMessage` 経路は本番運用継続 (= Slack 経路の本番動線)
 */
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { acquire } from '../../biblio/acquire.js';
import type { AcquireResult } from '../../biblio/types.js';
import { log } from '../../log.js';

import { resolveToolCtx } from './tool-ctx.js';

/**
 * Zod schema for `acquire_biblio` 入力。`repo` 1 つに集約 (= `owner/repo` / `owner/repo/skill` /
 * GitHub URL を `normalizeRepo()` が分岐する)。describe で LLM への explanation を付ける。
 */
const AcquireBiblioInput = z.object({
  repo: z
    .string()
    .describe(
      'GitHub repository in "owner/repo" or "owner/repo/skill" format (e.g. "example-org/biblio-min" or "anthropics/claude-plugins-official/my-skill"). Full GitHub URLs are also accepted.',
    ),
});

/**
 * ADK Runner 配下に登録する `acquire_biblio` tool。
 *
 * **`name` 明示が必須** (GOTCHA):
 *   `name` を省略すると adk-js が fallback として `execute.name` を使う (`function_tool.js:32-35`)。
 *   object literal property shorthand で渡した async arrow function は ECMAScript の name inference
 *   により `.name === 'execute'` になるため、ADK は truthy な `'execute'` を受けて exception を
 *   投げずに **tool 名 `'execute'` のままサイレント登録**する。LLM 公開時に `acquire_biblio` でない
 *   `'execute'` という奇妙な名前が見え、tool 自律選択経路が壊れる (= runtime error は出ない、
 *   静かに誤名で動き続ける罠)。本ファイルでは `name: 'acquire_biblio'` で明示してこれを回避。
 */
export const acquireBiblioTool = new FunctionTool({
  name: 'acquire_biblio',
  description:
    'Acquire a skill (biblio) from a GitHub repository into the biblio system. The skill is fetched into quarantine for subsequent inspection. Returns AcquireResult { ok: true, biblioName, quarantinePath } on success, or { ok: false, reason, detail } on failure (reasons: invalid_input, not_found, manifest_missing, clone_failed, threshold_exceeded, internal, marketplace_source_root, marketplace_source_external).',
  parameters: AcquireBiblioInput,
  execute: async ({ repo }, tool_context): Promise<AcquireResult> => {
    // ctx 抽出は共通ヘルパ `resolveToolCtx` (= ReadonlyContext getter 経由 + fallback 戦略を集約) に委譲。
    // `tool_context` が undefined になる経路は **ADK 内部の edge case** (= ADK が toolContext を省略する
    // 稀な経路への防御線、現在の adk-js@1.3.0 では `runEphemeral` 経路で自動 session 作成されるため
    // 通常は発生しない。unit test 経路も `mockToolContext` を必ず渡すため該当しない)。
    const { requestId, sessionId } = resolveToolCtx(tool_context);
    log.info('ADK tool: acquire_biblio invoked', {
      event: 'adk.tool.acquire.invoke',
      request_id: requestId,
      session_id: sessionId,
      repo,
    });
    try {
      return await acquire({ repo }, { ctx: { requestId, sessionId } });
    } catch (err) {
      // `acquire()` は throw しない契約 (= Result.ok discriminated union)。万が一 unexpected throw が
      // 起きた場合、ADK は内部で `Error in tool acquire_biblio: <msg>` で re-throw して original stack
      // trace を消失させる。server-side ログがゼロになる罠を防ぐため
      // ここで log.error を 1 度残してから rethrow する (= biblio-claw §silent failure 撲滅方針)。
      log.error('ADK tool: acquire_biblio unexpected throw', {
        event: 'adk.tool.acquire.unexpected_error',
        request_id: requestId,
        session_id: sessionId,
        repo,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});
