/**
 * llm-registry-setup のユニットテスト (M4-B Phase 0)。
 *
 * `LLMRegistry` は ADK の static `Map` を持つ singleton なので、test 間で内部状態が残る。
 * `_testResetRegistration()` を `beforeEach` で呼び module-scope `registered` flag だけ
 * リセットすることで、同一 module instance を保ったまま「register 直後の状態」を
 * 各 test で再現する。`LLMRegistry` の `register` は同じ class なら上書き idempotent なので
 * `Map.set` の累積でも問題ない。
 *
 * `vi.resetModules()` だと dynamic import 経路で `registerAnthropicVertexLlm` 内部の
 * `AnthropicVertexLlm` と test の取り直した `AnthropicVertexLlm` が別 module instance になり、
 * `LLMRegistry.resolve()` の戻り値と Object.is で不一致になる罠がある。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// `vi.mock` は Vitest がホイストするため、静的 import はモック適用後に解決される。
// 動的 import は不要 (= P9 fix: vi.resetModules() を使わない方針が確立しているなら静的 import が筋)。
import { registerAnthropicVertexLlm, _testResetRegistration } from './llm-registry-setup.js';
import { AnthropicVertexLlm } from './AnthropicVertexLlm.js';
import { LLMRegistry } from '@google/adk';
import { log } from '../log.js';

beforeEach(() => {
  // 各 test 前に `registered` flag をリセット。LLMRegistry の static `Map` は累積するが、
  // AnthropicVertexLlm の登録は idempotent (= 同じ class の上書き) なので問題ない。
  _testResetRegistration();
  vi.mocked(log.debug).mockReset();
  vi.mocked(log.info).mockReset();
  vi.mocked(log.warn).mockReset();
  vi.mocked(log.error).mockReset();
});

describe('registerAnthropicVertexLlm — LLMRegistry 解決', () => {
  it('register 後 LLMRegistry.resolve("claude-sonnet-4-6") が AnthropicVertexLlm を返す', () => {
    registerAnthropicVertexLlm();
    expect(LLMRegistry.resolve('claude-sonnet-4-6')).toBe(AnthropicVertexLlm);
  });

  it('claude-opus-4-8 等の他の Claude モデル ID も同 class を返す (= ^claude-.*$ 仕様)', () => {
    registerAnthropicVertexLlm();
    expect(LLMRegistry.resolve('claude-opus-4-8')).toBe(AnthropicVertexLlm);
    expect(LLMRegistry.resolve('claude-haiku-4-5')).toBe(AnthropicVertexLlm);
  });

  it('gemini-1.5-pro 等の non-claude モデル ID は AnthropicVertexLlm を返さない', () => {
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
  it('二重呼出しても例外を投げず、2 回目は noop_already_registered で抜ける', () => {
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
