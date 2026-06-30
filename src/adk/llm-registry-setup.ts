/**
 * `LLMRegistry.register(AnthropicVertexLlm)` の idempotent entrypoint hook (M4-B Phase 0)。
 *
 * `LlmAgent({model: 'claude-sonnet-4-6'})` の文字列モデル ID 解決を成立させるため、`main()`
 * 冒頭 (= OTel init は `--import` 経路で既に完了済の前提) で本関数を 1 回呼ぶ。`LLMRegistry`
 * の `register` は static `Map` の `set` (= 上書き許容) だが、二重登録の log noise を避けるため
 * module-scope flag で第 2 回以降を no-op 化する (= `src/instrumentation.ts` の起動時 1 回
 * 副作用パターン流儀)。
 *
 * 失敗時は throw で `main()` を抜けさせる: silent に握り潰すと `LlmAgent` 解決時に
 * `LLMRegistry.resolve('claude-sonnet-4-6')` が「Model not found」で死に、起動成功 → 命令実行で
 * 突然死というデバッグ困難経路を生む。biblio-claw の silent failure 撲滅方針 ([[silent_failure_hunter]])
 * と整合。
 */
import { LLMRegistry } from '@google/adk';

import { log } from '../log.js';

import { AnthropicVertexLlm } from './AnthropicVertexLlm.js';

let registered = false;

export function registerAnthropicVertexLlm(): void {
  if (registered) {
    log.debug('AnthropicVertexLlm already registered, skipping', {
      event: 'adk.llm_registry.register',
      outcome: 'noop_already_registered',
    });
    return;
  }
  try {
    LLMRegistry.register(AnthropicVertexLlm);
    registered = true;
    log.info('AnthropicVertexLlm registered to LLMRegistry', {
      event: 'adk.llm_registry.register',
      outcome: 'success',
      supported_models: AnthropicVertexLlm.supportedModels.map((s) => s.toString()),
    });
  } catch (err) {
    log.error('AnthropicVertexLlm registration failed', {
      event: 'adk.llm_registry.register',
      outcome: 'failure',
      err,
    });
    throw err;
  }
}

/**
 * テスト用 — module-scope `registered` flag をリセット。`LLMRegistry` の static `Map` が
 * test 間で残るため、`vi.resetModules()` 後に `import` し直して `registerAnthropicVertexLlm()` を
 * 呼び直す経路で初期化する。本番 code path から呼ばない (= `_test` prefix で意図を表明)。
 */
export function _testResetRegistration(): void {
  registered = false;
}
