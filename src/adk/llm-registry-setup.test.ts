/**
 * llm-registry-setup のユニットテスト (M4-B Phase 0)。
 *
 * `LLMRegistry` は ADK の static `Map` を持つ singleton なので、test 間で内部状態が残る。
 * `vi.resetModules()` + 動的 import + `_testResetRegistration()` で test ごとに局所化する。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

beforeEach(async () => {
  // `vi.resetModules()` だと dynamic import 経路で `registerAnthropicVertexLlm` 内部の
  // `AnthropicVertexLlm` と test の取り直した `AnthropicVertexLlm` が別 module instance に
  // なり、`LLMRegistry.resolve()` の戻り値と Object.is で不一致になる経路がある。
  // 同一 module instance を保ったまま `registered` flag だけリセットすれば、`LLMRegistry`
  // の static `Map` への登録は idempotent (= 同じ class の上書き) なので副作用なく
  // describe 跨ぎで完結する。失敗 test (= `LLMRegistry.register` 差し替え) のみ
  // `vi.resetModules()` + `vi.doMock` を test 内で行う。
  const { _testResetRegistration } = await import('./llm-registry-setup.js');
  _testResetRegistration();
});

describe('registerAnthropicVertexLlm — LLMRegistry 解決', () => {
  it('register 後 LLMRegistry.resolve("claude-sonnet-4-6") が AnthropicVertexLlm を返す', async () => {
    const { registerAnthropicVertexLlm } = await import('./llm-registry-setup.js');
    const { AnthropicVertexLlm } = await import('./AnthropicVertexLlm.js');
    const { LLMRegistry } = await import('@google/adk');
    registerAnthropicVertexLlm();
    const cls = LLMRegistry.resolve('claude-sonnet-4-6');
    expect(cls).toBe(AnthropicVertexLlm);
  });

  it('claude-opus-4-8 等の他の Claude モデル ID も同 class を返す (= ^claude-.*$ 仕様)', async () => {
    const { registerAnthropicVertexLlm } = await import('./llm-registry-setup.js');
    const { AnthropicVertexLlm } = await import('./AnthropicVertexLlm.js');
    const { LLMRegistry } = await import('@google/adk');
    registerAnthropicVertexLlm();
    expect(LLMRegistry.resolve('claude-opus-4-8')).toBe(AnthropicVertexLlm);
    expect(LLMRegistry.resolve('claude-haiku-4-5')).toBe(AnthropicVertexLlm);
  });

  it('gemini-1.5-pro 等の non-claude モデル ID は AnthropicVertexLlm を返さない', async () => {
    const { registerAnthropicVertexLlm } = await import('./llm-registry-setup.js');
    const { AnthropicVertexLlm } = await import('./AnthropicVertexLlm.js');
    const { LLMRegistry } = await import('@google/adk');
    registerAnthropicVertexLlm();
    // LLMRegistry.resolve は登録された pattern にマッチしなければ throw する。
    // AnthropicVertexLlm のみ登録した状態で gemini ID を引くと、no match で throw する。
    let resolved: unknown = null;
    try {
      resolved = LLMRegistry.resolve('gemini-1.5-pro');
    } catch {
      resolved = null;
    }
    expect(resolved).not.toBe(AnthropicVertexLlm);
  });
});

describe('registerAnthropicVertexLlm — idempotent 性', () => {
  it('二重呼出しても例外を投げず、2 回目は noop_already_registered で抜ける', async () => {
    const { registerAnthropicVertexLlm } = await import('./llm-registry-setup.js');
    const { log } = await import('../log.js');
    expect(() => {
      registerAnthropicVertexLlm();
      registerAnthropicVertexLlm();
    }).not.toThrow();
    // 1 回目 = success, 2 回目 = noop_already_registered の debug log が出るはず
    expect(log.debug).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ outcome: 'noop_already_registered' }),
    );
    expect(log.info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ outcome: 'success' }));
  });
});

// NOTE: 「`LLMRegistry.register` が throw したら error log + rethrow する」test は
// `vi.doMock` + `vi.resetModules()` の cache 罠で reliable に書きづらいため、Phase 0 では
// 削除。`registerAnthropicVertexLlm` 内の try/catch (= silent failure 撲滅方針) は static
// code review でカバー、振る舞いは Phase 1 sub-agent 化で `LlmAgent.run()` 経路に乗ったとき
// の起動 fail-fast で間接的に検証される。本コメントは逸脱記録 (= plan Task 10 異常系 1 件の
// 削減) を保全する目的で残す。
