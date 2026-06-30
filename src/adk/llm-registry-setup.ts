/**
 * `LLMRegistry.register(AnthropicVertexLlm)` の idempotent entrypoint hook (M4-B Phase 0)。
 *
 * `LlmAgent({model: 'claude-sonnet-4-6'})` の文字列モデル ID 解決を成立させるため、`main()`
 * 冒頭 (= OTel init は `--import` 経路で既に完了済の前提) で本関数を 1 回呼ぶ。`LLMRegistry`
 * の `register` は static `Map` の `set` (= 上書き許容) だが、二重登録の log noise を避けるため
 * module-scope flag で第 2 回以降を no-op 化する (= 起動時 1 回呼び出し規約: `main()` 冒頭の
 * 副作用 hook を idempotent にする biblio-claw 標準)。
 *
 * 失敗時は throw で `main()` を抜けさせる: silent に握り潰すと `LlmAgent` 解決時に
 * `LLMRegistry.resolve('claude-sonnet-4-6')` が「Model not found」で死に、起動成功 → 命令実行で
 * 突然死というデバッグ困難経路を生む。biblio-claw の silent failure 撲滅方針 (= 失敗は必ず
 * throw/log、握り潰さない) と整合。
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
 * @internal テスト専用。本番コードから呼ばないこと。
 *
 * module-scope `registered` flag をリセットする。`LLMRegistry` の static `Map` への登録は
 * idempotent (= `register` は `Map.set` で同じ class なら上書き) のため、test 間で flag だけ
 * リセットすれば describe 跨ぎでも `LLMRegistry.resolve` が同じ class instance を返す。
 *
 * 代替経路 (= `vi.resetModules()`) は dynamic import 経路で `registerAnthropicVertexLlm` 内部の
 * `AnthropicVertexLlm` と test の取り直した `AnthropicVertexLlm` が別 module instance になり、
 * `LLMRegistry.resolve()` の戻り値と Object.is で不一致になる罠がある。詳細は
 * `llm-registry-setup.test.ts` の `beforeEach` コメント参照。
 */
export function _testResetRegistration(): void {
  registered = false;
}
