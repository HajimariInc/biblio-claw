/**
 * `resolveToolCtx` — ADK tool 共通の `requestId` / `sessionId` 抽出ヘルパ (M4-B Phase 1)。
 *
 * 3 tool (`acquire` / `inspect` / `shelve`) の execute 内で同じ 2 行が複製されていたため抽出
 * (= code-simplifier S11c 推奨)。**ADK の公開 API 面である `ReadonlyContext` の getter (=
 * `invocationId` / `sessionId`)** を経由することで、ADK 内部実装変更 (例:
 * `invocationContext.session.id` のリネーム / 派生値化) に対する resilience を確保する
 * (= type-design-analyzer S8 推奨)。
 *
 * **fallback 戦略の使い分け** (= type-design-analyzer S9-b 推奨、意図を型から読み取れないため
 * コードコメントで明示):
 *
 *   - `requestId`: `tool_context` 不在経路 (= ADK 内部の edge case、或いは unit test 経由で
 *     ADK が toolContext を省略するケース) で `crypto.randomUUID()` を **自動生成**。理由:
 *     既存 host action (`acquire-action.ts` 等) は `requestId` を log key としてそのまま log line
 *     に流すため、空文字が混入すると Cloud Logging で「未指定の請求」と区別できなくなる罠を
 *     回避。`crypto.randomUUID()` は Node 24 builtin global の `globalThis.crypto.randomUUID()`
 *     で常に string を返す = `?? ''` の右辺は不要
 *
 *   - `sessionId`: 同経路で **空文字 sentinel**。理由: 既存 `acquire-action.ts` / `inspect-action.ts`
 *     等の delivery handler が空文字 sessionId を許容している前提 (= NanoClaw 流儀で session
 *     未割当のときに `session.id` が空文字で流れる経路あり) と一貫させる。`requestId` のような
 *     自動生成 fallback を採るとログ集約時に偽の session を作る副作用があるため、空文字 sentinel
 *     を意図的に選択
 */
import type { Context } from '@google/adk';

export interface ToolCtx {
  requestId: string;
  sessionId: string;
}

/**
 * `tool_context` (= ADK `Context`) から `requestId` / `sessionId` を取り出す。
 * `tool_context` が undefined のときの fallback 戦略については本ファイル冒頭ドキュメント参照。
 */
export function resolveToolCtx(tool_context: Context | undefined): ToolCtx {
  return {
    requestId: tool_context?.invocationId ?? crypto.randomUUID(),
    sessionId: tool_context?.sessionId ?? '',
  };
}
