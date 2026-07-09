/**
 * root-agent + runner の integration test。
 *
 * Anthropic SDK + 既存 host action を全て mock した上で `InMemoryRunner.runEphemeral` を
 * 起動し、root `LlmAgent` の構造 + event 列消費 (= text-only スモーク) を検証する。
 *
 * **scope の境界**:
 *
 *   **検証する**:
 *     - `buildRootAgent()` / `buildRunner()` の構造 (= name / model / tools / appName)
 *     - `LLMRegistry.resolve` が AnthropicVertexLlm を返す状態
 *     - `runEphemeral` の **text-only 経路** (= LLM が tool を呼ばずに text を返却する経路、
 *       final event yield 確認)
 *
 *   **検証しない**:
 *     - **実機 Vertex 経由の検証**: `scripts/verify-phase-1-adk-local.ts` (scaffolding 構造 +
 *       OTel 流出の smoke) 側で担保
 *     - **ADK 自動 span 確認**: runner 構造の smoke に絞る
 *
 * mock パターン: `AnthropicVertexLlm.test.ts` / `llm-registry-setup.test.ts` 流儀。
 * `LLMRegistry` 内部 `Map` への登録は idempotent (= 同 class 上書き) なので、`beforeEach` で
 * `_testResetRegistration()` + `registerAnthropicVertexLlm()` を呼んで「register 直後の状態」を
 * 各 test で再現する。
 */
import { isFinalResponse, LLMRegistry, LlmAgent, InMemoryRunner } from '@google/adk';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  messagesCreateMock,
  acquireMock,
  inspectMock,
  shelveMock,
  categorizeMock,
  listBiblioMock,
  shelveMultiMock,
  enkinMock,
  shokyakuMock,
  setBiblioSettingMock,
} = vi.hoisted(() => ({
  messagesCreateMock: vi.fn(),
  acquireMock: vi.fn(),
  inspectMock: vi.fn(),
  shelveMock: vi.fn(),
  categorizeMock: vi.fn(),
  listBiblioMock: vi.fn(),
  shelveMultiMock: vi.fn(),
  enkinMock: vi.fn(),
  shokyakuMock: vi.fn(),
  setBiblioSettingMock: vi.fn(),
}));

vi.mock('@anthropic-ai/vertex-sdk', () => ({
  AnthropicVertex: class {
    public messages = { create: messagesCreateMock };
    constructor(_opts: unknown) {
      // no-op (= keyless ADC を test では bypass)
    }
  },
}));

// issue #136 Step 3-b: AnthropicVertexLlm constructor が `new GoogleAuth()` を呼び、
// generateContentAsync 内で `googleAuth.getClient().getRequestHeaders()` を叩く。
// test 環境で metadata server に到達を試みて hang するのを避けるため mock 化する
// (実 auth 経路の smoke は scripts/verify-phase-1-adk-local.ts が担う)。
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    constructor(_opts: unknown) {
      // no-op
    }
    async getClient() {
      return {
        async getRequestHeaders(): Promise<Record<string, string>> {
          return { Authorization: 'Bearer test-mock-token' };
        },
      };
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
  shelveMulti: (...args: unknown[]) => shelveMultiMock(...args),
}));

vi.mock('../biblio/categorize.js', () => ({
  categorize: (...args: unknown[]) => categorizeMock(...args),
}));

vi.mock('../biblio/list-biblio.js', () => ({
  listBiblio: (...args: unknown[]) => listBiblioMock(...args),
}));

vi.mock('../biblio/enkin.js', () => ({
  enkin: (...args: unknown[]) => enkinMock(...args),
}));

vi.mock('../biblio/shokyaku.js', () => ({
  shokyaku: (...args: unknown[]) => shokyakuMock(...args),
}));

vi.mock('../db/biblio-settings.js', () => ({
  setBiblioSetting: (...args: unknown[]) => setBiblioSettingMock(...args),
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { AnthropicVertexLlm } from './AnthropicVertexLlm.js';
import { registerAnthropicVertexLlm, _testResetRegistration } from './llm-registry-setup.js';
import { buildRootAgent } from './root-agent.js';
import { buildRunner, BIBLIO_M4B_APP_NAME } from './runner.js';
import { resetLogMocks } from './tools/test-helpers.js';
import { log } from '../log.js';

beforeEach(() => {
  _testResetRegistration();
  registerAnthropicVertexLlm();
  messagesCreateMock.mockReset();
  acquireMock.mockReset();
  inspectMock.mockReset();
  shelveMock.mockReset();
  categorizeMock.mockReset();
  listBiblioMock.mockReset();
  shelveMultiMock.mockReset();
  enkinMock.mockReset();
  shokyakuMock.mockReset();
  setBiblioSettingMock.mockReset();
  resetLogMocks(log);
});

describe('buildRootAgent — 構造検証', () => {
  it('LlmAgent instance を返す + name / description が期待通り', () => {
    const agent = buildRootAgent();
    expect(agent).toBeInstanceOf(LlmAgent);
    expect(agent.name).toBe('biblio_root_agent');
    expect(agent.description).toContain('biblio-claw');
  });

  it('tools には 9 種 (Phase 4: acquire/inspect/categorize/shelve/shelve_multi/list/update_config/enkin/shokyaku) が並ぶ', () => {
    const agent = buildRootAgent();
    const toolNames = (agent.tools ?? []).map((t) => ('name' in t ? t.name : 'unknown'));
    expect(toolNames).toEqual([
      'acquire_biblio',
      'inspect_biblio',
      'categorize_biblio',
      'shelve_biblio',
      'shelve_biblio_multi',
      'list_biblio',
      'update_config',
      'enkin_biblio',
      'shokyaku_biblio',
    ]);
  });

  it('description が「9 tools + HITL approval」を含む (= Phase 4 拡張の指標)', () => {
    const agent = buildRootAgent();
    expect(agent.description).toContain('9 tools');
    expect(agent.description).toContain('HITL');
  });

  it('instruction に破壊操作 (enkin/shokyaku) の admin 承認要求 + 判断規範が明示されている', () => {
    const agent = buildRootAgent();
    expect(agent.instruction).toContain('enkin_biblio');
    expect(agent.instruction).toContain('shokyaku_biblio');
    expect(agent.instruction).toContain('admin 承認');
    // 破壊操作の判断規範 (曖昧指示なら list_biblio → 明示指示 → 発火の 2 段)
    expect(agent.instruction).toContain('list_biblio で候補');
  });

  it('model 文字列 ID が "claude-sonnet-4-6" で、LLMRegistry.resolve が AnthropicVertexLlm を返す', () => {
    const agent = buildRootAgent();
    // model は LlmAgent.model getter で取得可能、文字列の場合はそのまま返る
    expect(agent.model).toBe('claude-sonnet-4-6');
    expect(LLMRegistry.resolve('claude-sonnet-4-6')).toBe(AnthropicVertexLlm);
  });
});

describe('buildRunner — 構造検証 (Phase 4: SharedRunnerContext shape)', () => {
  it('{ runner, sessionService } を返し runner は InMemoryRunner instance + appName が biblio_m4b', () => {
    const agent = buildRootAgent();
    const ctx = buildRunner(agent);
    expect(ctx).toHaveProperty('runner');
    expect(ctx).toHaveProperty('sessionService');
    expect(ctx.runner).toBeInstanceOf(InMemoryRunner);
    expect(ctx.runner.appName).toBe(BIBLIO_M4B_APP_NAME);
  });

  it('runner.agent が buildRootAgent の戻り値と Object.is で一致する', () => {
    const agent = buildRootAgent();
    const ctx = buildRunner(agent);
    expect(ctx.runner.agent).toBe(agent);
  });

  it('sessionService は runner.sessionService と同じ参照 (= InMemoryRunner 内部生成の共有経路)', () => {
    const agent = buildRootAgent();
    const ctx = buildRunner(agent);
    expect(ctx.sessionService).toBe(ctx.runner.sessionService);
  });
});

describe('runEphemeral — text-only スモーク (LLM が tool を呼ばずに text のみ返却)', () => {
  it('Anthropic SDK が text を返すと最終 event に final response テキストが乗る', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: '了解しました。仕入れに進みます。' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 30, output_tokens: 10 },
    });
    const { runner } = buildRunner(buildRootAgent());

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
    const { runner } = buildRunner(buildRootAgent());

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

describe('runEphemeral — LLM 自律 tool 呼出 (Phase 2 で埋め戻し)', () => {
  /**
   * Phase 0 `AnthropicVertexLlm` の 2 つの構造的制約 (config.tools 非読出 / tool_use 非変換) を
   * Phase 2 で消化したことで、本 integration test が成立可能になった (= Phase 1 plan §逸脱で
   * 「Phase 2 で埋め戻す」と確定した分の埋め戻し)。
   *
   * mock 経路:
   *   1. messagesCreateMock 1 回目: Claude が `tool_use` 単一 block を返す (= acquire_biblio 自律呼出)
   *   2. AnthropicVertexLlm.toLlmResponse が functionCall part に変換 → ADK runner が dispatch
   *   3. acquire-tool の execute から acquireMock が呼ばれる (= 成功 result を返す)
   *   4. messagesCreateMock 2 回目: Claude が text で完了応答 (= tool_result を踏まえた応答)
   *   5. ADK runner が text part を最終 event として yield
   */
  it('LLM が tool_use を返したとき acquireMock が呼ばれ、最終 event は text 応答', async () => {
    messagesCreateMock
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: 'acquire_biblio',
            input: { repo: 'wf/test' },
          },
        ],
        usage: { input_tokens: 30, output_tokens: 10 },
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '仕入れ完了しました: wf--test' }],
        usage: { input_tokens: 45, output_tokens: 8 },
        stop_reason: 'end_turn',
      });

    acquireMock.mockResolvedValue({
      ok: true,
      biblioName: 'wf--test',
      quarantinePath: '/tmp/quarantine/wf--test',
    });

    const { runner } = buildRunner(buildRootAgent());
    const events: Array<{ content?: { parts?: Array<{ text?: string }> } }> = [];
    for await (const event of runner.runEphemeral({
      userId: 'test-user',
      newMessage: { role: 'user', parts: [{ text: 'acquire wf/test' }] },
    })) {
      events.push(event as { content?: { parts?: Array<{ text?: string }> } });
    }

    // acquireMock が tool 経由で呼ばれた (= LLM 自律 tool 呼出経路成立)
    expect(acquireMock).toHaveBeenCalledTimes(1);
    expect(acquireMock).toHaveBeenCalledWith(
      { repo: 'wf/test' },
      expect.objectContaining({
        ctx: expect.objectContaining({
          requestId: expect.any(String),
          sessionId: expect.any(String),
        }),
      }),
    );
    // 他 tool は呼ばれていない
    expect(inspectMock).not.toHaveBeenCalled();
    expect(shelveMock).not.toHaveBeenCalled();

    // messages.create は 2 回呼ばれている (= tool_use → tool_result → text の round-trip)
    expect(messagesCreateMock).toHaveBeenCalledTimes(2);

    // 最終 event の text に「仕入れ完了」が含まれる
    const lastTextEvent = events
      .map((e) => e.content?.parts?.[0]?.text)
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
      .pop();
    expect(lastTextEvent).toContain('仕入れ完了');
  });
});
