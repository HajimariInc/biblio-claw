/**
 * AnthropicVertexLlm 呼出コンテキスト伝搬用 AsyncLocalStorage (issue #136 Step 0-b)。
 *
 * ADK Runner 経由の LLM 呼出は `AnthropicVertexLlm.generateContentAsync` に
 * 直接 arg で `requestId` / `sessionId` を渡す経路がない (ADK BaseLlm の abstract
 * signature が固定)。dispatcher.ts の `runner.runAsync()` 呼出を本 store で
 * wrap しておくと、内部から呼ばれる LLM 経路がどんな callchain でも
 * `getAnthropicVertexRequestContext()` で拾える。
 *
 * Node 20+ 標準の `async_hooks.AsyncLocalStorage` は同期呼出 + Promise / async
 * 経路の両方で context を保持する (setTimeout や setImmediate も含む)。将来
 * worker_threads / vm.Script 経由の callchain を導入する PR では Router pattern
 * に置換する判断 (別 issue 候補、issue #136 エッジケース表 §AsyncLocalStorage)。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type AnthropicVertexRequestContext = {
  requestId: string;
  sessionId: string;
  channelType: string;
};

const store = new AsyncLocalStorage<AnthropicVertexRequestContext>();

/** dispatcher.ts の runner.runAsync 呼出全体を wrap する。 */
export function runWithAnthropicVertexRequestContext<T>(
  ctx: AnthropicVertexRequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return store.run(ctx, fn);
}

/** AnthropicVertexLlm.generateContentAsync 内で呼ぶ。store 外から呼ばれた場合は
 *  undefined (呼出側で空文字 fallback + `context_missing:true` フラグ emit、
 *  silent 化しない = 「AsyncLocalStorage の外から呼ばれた」を可観測にする)。 */
export function getAnthropicVertexRequestContext(): AnthropicVertexRequestContext | undefined {
  return store.getStore();
}
