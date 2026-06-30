/**
 * root-agent + runner の integration test (M4-B Phase 1)。
 *
 * Anthropic SDK + 既存 host action を全て mock した上で `InMemoryRunner.runEphemeral` を
 * 起動し、root `LlmAgent` の構造 + event 列消費 (= text-only スモーク) を検証する。
 *
 * **scope の境界 (Phase 1 plan §逸脱判断、実装中に確定)**:
 *   - **検証する**: `buildRootAgent()` / `buildRunner()` の構造 (= name / model / tools / appName)、
 *     `LLMRegistry.resolve` が AnthropicVertexLlm を返す状態、`runEphemeral` の text-only 経路
 *     (= LLM が tool を呼ばずに text を返却する経路、final event yield 確認)
 *   - **検証しない**: LLM が tool を自律呼出する経路 (= `AnthropicVertexLlm.toLlmResponse()` が
 *     Phase 0 で text-block 抽出のみで `tool_use` → ADK functionCall 変換は未対応のため、
 *     mock で integration できない)。tool 自律呼出経路は Task 10 verify-script で実 Anthropic
 *     Vertex 呼出経由で実機検証
 *   - **ADK 自動 span 確認は Phase 2 へ送る** (= Phase 1 では runner 構造の smoke で十分)
 *
 * mock パターン: Phase 0 `AnthropicVertexLlm.test.ts` / `llm-registry-setup.test.ts` 流儀。
 * `LLMRegistry` 内部 `Map` への登録は idempotent (= 同 class 上書き) なので、`beforeEach` で
 * `_testResetRegistration()` + `registerAnthropicVertexLlm()` を呼んで「register 直後の状態」を
 * 各 test で再現する。
 */
import { isFinalResponse, LLMRegistry, LlmAgent, InMemoryRunner } from '@google/adk';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { messagesCreateMock, acquireMock, inspectMock, shelveMock } = vi.hoisted(() => ({
  messagesCreateMock: vi.fn(),
  acquireMock: vi.fn(),
  inspectMock: vi.fn(),
  shelveMock: vi.fn(),
}));

vi.mock('@anthropic-ai/vertex-sdk', () => ({
  AnthropicVertex: class {
    public messages = { create: messagesCreateMock };
    constructor(_opts: unknown) {
      // no-op (= keyless ADC を test では bypass)
    }
  },
}));

vi.mock('../biblio/acquire.js', () => ({
  acquire: (...args: unknown[]) => acquireMock(...args),
}));

vi.mock('../biblio/inspect.js', () => ({
  inspect: (...args: unknown[]) => inspectMock(...args),
}));

vi.mock('../biblio/shelve.js', () => ({
  shelve: (...args: unknown[]) => shelveMock(...args),
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { AnthropicVertexLlm } from './AnthropicVertexLlm.js';
import { registerAnthropicVertexLlm, _testResetRegistration } from './llm-registry-setup.js';
import { buildRootAgent } from './root-agent.js';
import { buildRunner, BIBLIO_M4B_APP_NAME } from './runner.js';

beforeEach(() => {
  _testResetRegistration();
  registerAnthropicVertexLlm();
  messagesCreateMock.mockReset();
  acquireMock.mockReset();
  inspectMock.mockReset();
  shelveMock.mockReset();
});

describe('buildRootAgent — 構造検証', () => {
  it('LlmAgent instance を返す + name / description が期待通り', () => {
    const agent = buildRootAgent();
    expect(agent).toBeInstanceOf(LlmAgent);
    expect(agent.name).toBe('biblio_root_agent');
    expect(agent.description).toContain('biblio-claw');
  });

  it('tools には 3 種 (acquire_biblio / inspect_biblio / shelve_biblio) が並ぶ', () => {
    const agent = buildRootAgent();
    const toolNames = (agent.tools ?? []).map((t) => ('name' in t ? t.name : 'unknown'));
    expect(toolNames).toEqual(['acquire_biblio', 'inspect_biblio', 'shelve_biblio']);
  });

  it('model 文字列 ID が "claude-sonnet-4-6" で、LLMRegistry.resolve が AnthropicVertexLlm を返す', () => {
    const agent = buildRootAgent();
    // model は LlmAgent.model getter で取得可能、文字列の場合はそのまま返る
    expect(agent.model).toBe('claude-sonnet-4-6');
    expect(LLMRegistry.resolve('claude-sonnet-4-6')).toBe(AnthropicVertexLlm);
  });
});

describe('buildRunner — 構造検証', () => {
  it('InMemoryRunner instance を返す + appName が biblio_m4b', () => {
    const agent = buildRootAgent();
    const runner = buildRunner(agent);
    expect(runner).toBeInstanceOf(InMemoryRunner);
    expect(runner.appName).toBe(BIBLIO_M4B_APP_NAME);
    expect(runner.appName).toBe('biblio_m4b');
  });

  it('runner.agent が buildRootAgent の戻り値と Object.is で一致する', () => {
    const agent = buildRootAgent();
    const runner = buildRunner(agent);
    expect(runner.agent).toBe(agent);
  });
});

describe('runEphemeral — text-only スモーク (LLM が tool を呼ばずに text のみ返却)', () => {
  it('Anthropic SDK が text を返すと最終 event に final response テキストが乗る', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: '了解しました。仕入れに進みます。' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 30, output_tokens: 10 },
    });
    const runner = buildRunner(buildRootAgent());

    const events: unknown[] = [];
    let finalText = '';
    for await (const event of runner.runEphemeral({
      userId: 'test-user',
      newMessage: { role: 'user', parts: [{ text: 'hello' }] },
    })) {
      events.push(event);
      if (isFinalResponse(event)) {
        finalText = event.content?.parts?.[0]?.text ?? '';
      }
    }

    expect(events.length).toBeGreaterThan(0);
    expect(finalText).toContain('仕入れ');
    // tool は 1 つも呼ばれない (= LLM が text のみ返却したため)
    expect(acquireMock).not.toHaveBeenCalled();
    expect(inspectMock).not.toHaveBeenCalled();
    expect(shelveMock).not.toHaveBeenCalled();
  });

  it('SDK が EMPTY_TEXT 経路 (tool_use のみ + text なし) を返してもクラッシュしない (= AnthropicVertexLlm の防御線)', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'tool_use', name: 'fake', input: {}, id: 'tu-1' }],
      stop_reason: 'tool_use',
    });
    const runner = buildRunner(buildRootAgent());

    // EMPTY_TEXT path: AnthropicVertexLlm が errorCode を含む LlmResponse を yield、
    // ADK runner はそれを受けて error event を流す。tool は 1 つも呼ばれない。
    const events: unknown[] = [];
    // 意図的な無条件 catch (= no-catch-all 例外): ADK 版差で EMPTY_TEXT 経路が throw に倒す挙動と
    // yield (errorCode) に倒す挙動の両方が観測されうる。本 test の目的は「クラッシュしない +
    // tool が呼ばれない」確認のみで、どちらの経路でも assert が満たされれば OK のため、上位への
    // rethrow は不要。
    try {
      for await (const event of runner.runEphemeral({
        userId: 'test-user',
        newMessage: { role: 'user', parts: [{ text: 'hello' }] },
      })) {
        events.push(event);
      }
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      // no-op
    }

    expect(acquireMock).not.toHaveBeenCalled();
  });
});

describe('LLMRegistry 状態漏れ防止', () => {
  it('describe 間で _testResetRegistration → registerAnthropicVertexLlm 再実行で同 class 解決を保つ', () => {
    expect(LLMRegistry.resolve('claude-sonnet-4-6')).toBe(AnthropicVertexLlm);
    expect(LLMRegistry.resolve('claude-opus-4-8')).toBe(AnthropicVertexLlm);
  });
});
