/**
 * AnthropicVertexLlm のユニットテスト。
 *
 * `src/biblio/vertex-client.test.ts` の `vi.hoisted` モック + InMemorySpanExporter パターン
 * を写経。AsyncGenerator + abortSignal + gen_ai.* span attribute の structural fix で
 * regression を防ぐ。
 *
 * gen_ai.* span 計装の OTel setup/teardown は `describe` スコープの `beforeEach` / `afterEach`
 * で集約 (= assertion 失敗時も確実に cleanup される、test 間の TracerProvider リークを防ぐ)。
 */
import type { InMemorySpanExporter, BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import type * as OtelApiType from '@opentelemetry/api';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { messagesCreateMock } = vi.hoisted(() => ({
  messagesCreateMock: vi.fn(),
}));

vi.mock('@anthropic-ai/vertex-sdk', () => ({
  AnthropicVertex: class {
    public messages = { create: messagesCreateMock };
    constructor(_opts: unknown) {
      // no-op (= keyless ADC 経路の SDK 内部初期化を test では bypass)
    }
  },
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { AnthropicVertexLlm } from './AnthropicVertexLlm.js';
import { log } from '../log.js';

beforeEach(() => {
  messagesCreateMock.mockReset();
  vi.mocked(log.debug).mockReset();
  vi.mocked(log.info).mockReset();
  vi.mocked(log.warn).mockReset();
  vi.mocked(log.error).mockReset();
});

/** Phase 0 用の minimal LlmRequest シミュレータ (= contents だけ持つ structural 型)。 */
function llmRequest(text: string, opts?: { maxOutputTokens?: number; systemInstruction?: unknown }) {
  return {
    contents: [{ role: 'user', parts: [{ text }] }],
    config: {
      ...(opts?.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
      ...(opts?.systemInstruction !== undefined ? { systemInstruction: opts.systemInstruction } : {}),
    },
    // BaseLlm が require する shape の minimum を unknown 経由で渡す。
  } as unknown as Parameters<AnthropicVertexLlm['generateContentAsync']>[0];
}

describe('AnthropicVertexLlm — generateContentAsync 正常系', () => {
  it('AsyncGenerator で LlmResponse を 1 件 yield する', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: 'OK' }],
      usage: { input_tokens: 42, output_tokens: 7 },
    });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    const responses: unknown[] = [];
    for await (const r of llm.generateContentAsync(llmRequest('Hello'))) {
      responses.push(r);
    }
    expect(responses).toHaveLength(1);
    const r = responses[0] as { content?: { parts?: Array<{ text?: string }> } };
    expect(r.content?.parts?.[0]?.text).toBe('OK');
  });

  it('contents を Anthropic messages 形式に変換して SDK に渡す (role=model → assistant マップ)', async () => {
    messagesCreateMock.mockResolvedValue({ content: [{ type: 'text', text: 'x' }] });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    const req = {
      contents: [
        { role: 'user', parts: [{ text: 'q1' }] },
        { role: 'model', parts: [{ text: 'a1' }] },
        { role: 'user', parts: [{ text: 'q2' }] },
      ],
      config: {},
    } as unknown as Parameters<AnthropicVertexLlm['generateContentAsync']>[0];
    // 1 yield だけ pull すれば十分 (= 残りは drain 不要、AsyncGenerator は close される)
    const it_ = llm.generateContentAsync(req);
    await it_.next();
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
    const callArgs = messagesCreateMock.mock.calls[0][0] as {
      model: string;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(callArgs.model).toBe('claude-sonnet-4-6');
    expect(callArgs.max_tokens).toBe(1024); // default
    expect(callArgs.messages).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
  });

  it('config.systemInstruction を flatten して system 引数に載せる', async () => {
    messagesCreateMock.mockResolvedValue({ content: [{ type: 'text', text: 'x' }] });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    await llm.generateContentAsync(llmRequest('q', { systemInstruction: 'you are a librarian' })).next();
    const callArgs = messagesCreateMock.mock.calls[0][0] as { system?: string };
    expect(callArgs.system).toBe('you are a librarian');
  });

  it('systemInstruction が Content[] のとき parts.text を join して flatten する', async () => {
    messagesCreateMock.mockResolvedValue({ content: [{ type: 'text', text: 'x' }] });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    const si = [{ parts: [{ text: 'rule 1' }] }, { parts: [{ text: 'rule 2' }] }];
    await llm.generateContentAsync(llmRequest('q', { systemInstruction: si })).next();
    const callArgs = messagesCreateMock.mock.calls[0][0] as { system?: string };
    expect(callArgs.system).toBe('rule 1\nrule 2');
  });

  it('config.maxOutputTokens が指定されたら max_tokens に伝搬する', async () => {
    messagesCreateMock.mockResolvedValue({ content: [{ type: 'text', text: 'x' }] });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    await llm.generateContentAsync(llmRequest('q', { maxOutputTokens: 256 })).next();
    const callArgs = messagesCreateMock.mock.calls[0][0] as { max_tokens: number };
    expect(callArgs.max_tokens).toBe(256);
  });

  it('text が空 / content 不在のとき errorCode=EMPTY_TEXT を返す', async () => {
    messagesCreateMock.mockResolvedValue({ content: [{ type: 'tool_use' }], stop_reason: 'tool_use' });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    const res = (await llm.generateContentAsync(llmRequest('q')).next()).value as {
      errorCode?: string;
      errorMessage?: string;
    };
    expect(res.errorCode).toBe('EMPTY_TEXT');
    expect(res.errorMessage).toContain('tool_use');
  });
});

describe('AnthropicVertexLlm — edge case 修正', () => {
  it('空配列 systemInstruction で system field が SDK に渡らない (= `system: ""` 防御)', async () => {
    messagesCreateMock.mockResolvedValue({ content: [{ type: 'text', text: 'OK' }] });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    // 空配列 systemInstruction は truthy だが flatten で '' になる → system field 省略されること
    await llm.generateContentAsync(llmRequest('q', { systemInstruction: [] })).next();
    const callArgs = messagesCreateMock.mock.calls[0][0] as { system?: string };
    expect(callArgs.system).toBeUndefined();
  });

  it('parts のない Content[] systemInstruction も system field 省略される (= `{parts: []}` 防御)', async () => {
    messagesCreateMock.mockResolvedValue({ content: [{ type: 'text', text: 'OK' }] });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    await llm
      .generateContentAsync(llmRequest('q', { systemInstruction: [{ parts: [] }, { parts: [{ text: '' }] }] }))
      .next();
    const callArgs = messagesCreateMock.mock.calls[0][0] as { system?: string };
    expect(callArgs.system).toBeUndefined();
  });

  it('空 contents で EMPTY_MESSAGES が yield される (= SDK 呼出回避)', async () => {
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    const req = {
      contents: [],
      config: {},
    } as unknown as Parameters<AnthropicVertexLlm['generateContentAsync']>[0];
    const res = (await llm.generateContentAsync(req).next()).value as {
      errorCode?: string;
      errorMessage?: string;
    };
    expect(res.errorCode).toBe('EMPTY_MESSAGES');
    expect(messagesCreateMock).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ outcome: 'empty_messages' }),
    );
  });

  it('全 parts が空テキストの contents も EMPTY_MESSAGES (= I3 fix、Phase 1+ multi-modal 経路)', async () => {
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    const req = {
      contents: [
        { role: 'user', parts: [{ text: '' }] },
        { role: 'user', parts: [] },
      ],
      config: {},
    } as unknown as Parameters<AnthropicVertexLlm['generateContentAsync']>[0];
    const res = (await llm.generateContentAsync(req).next()).value as { errorCode?: string };
    expect(res.errorCode).toBe('EMPTY_MESSAGES');
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it('未知ロール (tool/function/system) が user に fallback + log.warn (= I2 fix)', async () => {
    messagesCreateMock.mockResolvedValue({ content: [{ type: 'text', text: 'OK' }] });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    const req = {
      contents: [
        { role: 'tool', parts: [{ text: 'tool result' }] },
        { role: 'function', parts: [{ text: 'function output' }] },
        { role: 'system', parts: [{ text: 'system note' }] },
      ],
      config: {},
    } as unknown as Parameters<AnthropicVertexLlm['generateContentAsync']>[0];
    await llm.generateContentAsync(req).next();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        outcome: 'unknown_role_mapped_to_user',
        original_role: 'tool',
      }),
    );
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ original_role: 'function' }),
    );
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ original_role: 'system' }),
    );
    // 未知ロール 3 件すべて user に fallback される
    const callArgs = messagesCreateMock.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(callArgs.messages.every((m) => m.role === 'user')).toBe(true);
  });

  it('SDK 呼出 catch で log.error が呼ばれる (= I5 fix、OTel degraded fallback 経路の保険)', async () => {
    messagesCreateMock.mockRejectedValue(new Error('Vertex 503'));
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    await expect(async () => {
      for await (const _ of llm.generateContentAsync(llmRequest('q'))) {
        void _;
      }
    }).rejects.toThrow(/Vertex 503/);
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: 'adk.anthropic_vertex_llm.generate',
        outcome: 'failure',
      }),
    );
  });

  it('EMPTY_TEXT 戻り値時に log.warn (= C3 fix、意味的失敗の構造化ログ可視化)', async () => {
    messagesCreateMock.mockResolvedValue({ content: [{ type: 'tool_use' }], stop_reason: 'tool_use' });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    await llm.generateContentAsync(llmRequest('q')).next();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        outcome: 'empty_text',
        stop_reason: 'tool_use',
      }),
    );
  });
});

describe('AnthropicVertexLlm — gen_ai.* span 計装', () => {
  // I7 fix: OTel の setup/teardown を describe スコープに集約。`beforeEach` / `afterEach`
  // 経由で各 test の assertion 失敗時も確実に cleanup される (= 旧実装で test 1 だけ try/finally
  // なしだった TracerProvider リーク経路を解消)。
  let otelApi: typeof OtelApiType;
  let memoryExporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(async () => {
    otelApi = await import('@opentelemetry/api');
    const sdk = await import('@opentelemetry/sdk-trace-base');
    const alsHooks = await import('@opentelemetry/context-async-hooks');
    memoryExporter = new sdk.InMemorySpanExporter();
    otelApi.context.setGlobalContextManager(new alsHooks.AsyncLocalStorageContextManager().enable());
    provider = new sdk.BasicTracerProvider({
      sampler: new sdk.ParentBasedSampler({ root: new sdk.AlwaysOnSampler() }),
      spanProcessors: [new sdk.SimpleSpanProcessor(memoryExporter)],
    });
    otelApi.trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    memoryExporter.reset();
    await provider.shutdown().catch(() => undefined);
    otelApi.trace.disable();
    otelApi.context.disable();
  });

  it('span 名 = chat <model> + provider/model/usage 属性が立つ', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: 'OK' }],
      usage: { input_tokens: 123, output_tokens: 45, cache_read_input_tokens: 7 },
    });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    for await (const _ of llm.generateContentAsync(llmRequest('Hello'))) {
      void _;
    }

    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.name).toBe('chat claude-sonnet-4-6');
    expect(span.attributes['gen_ai.operation.name']).toBe('chat');
    expect(span.attributes['gen_ai.provider.name']).toBe('gcp.vertex_ai');
    expect(span.attributes['gen_ai.request.model']).toBe('claude-sonnet-4-6');
    expect(span.attributes['gen_ai.usage.input_tokens']).toBe(123);
    expect(span.attributes['gen_ai.usage.output_tokens']).toBe(45);
    expect(span.attributes['gen_ai.usage.cache_read.input_tokens']).toBe(7);
    expect(span.attributes['server.address']).toBe('aiplatform.googleapis.com');
  });

  it('region != global のとき server.address に region prefix が付く', async () => {
    // env var 操作のみ try/finally で守る (OTel teardown は afterEach に委譲)
    const prevRegion = process.env.CLOUD_ML_REGION;
    process.env.CLOUD_ML_REGION = 'us-central1';
    try {
      messagesCreateMock.mockResolvedValue({ content: [{ type: 'text', text: 'x' }] });
      const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
      for await (const _ of llm.generateContentAsync(llmRequest('q'))) {
        void _;
      }
      const spans = memoryExporter.getFinishedSpans();
      expect(spans[0].attributes['server.address']).toBe('us-central1-aiplatform.googleapis.com');
    } finally {
      if (prevRegion === undefined) delete process.env.CLOUD_ML_REGION;
      else process.env.CLOUD_ML_REGION = prevRegion;
    }
  });

  it('SDK が throw すると span.recordException + setStatus(ERROR) を立てて rethrow する', async () => {
    messagesCreateMock.mockRejectedValue(new Error('Vertex 503 — service unavailable'));
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });

    await expect(async () => {
      for await (const _ of llm.generateContentAsync(llmRequest('q'))) {
        void _;
      }
    }).rejects.toThrow(/Vertex 503/);

    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(otelApi.SpanStatusCode.ERROR);
    expect(spans[0].status.message).toContain('Vertex 503');
    // recordException で event が立つ (= Cloud Trace UI で exception 表示の根拠)
    expect(spans[0].events.length).toBeGreaterThanOrEqual(1);
  });

  it('EMPTY_TEXT 戻り値時に span が ERROR (= C3 fix、意味的失敗で SUCCESS のままにしない)', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'tool_use' }],
      stop_reason: 'tool_use',
    });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    // `.next()` 1 回だと yield で止まったまま finally が走らず span.end() されない。
    // `for await` で generator を完全 drain することで finally に進ませる。
    for await (const _ of llm.generateContentAsync(llmRequest('q'))) {
      void _;
    }

    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(otelApi.SpanStatusCode.ERROR);
    expect(spans[0].status.message).toContain('tool_use');
  });

  it('EMPTY_MESSAGES 経路でも span が ERROR (= I3 fix、SDK 呼出前 fail-fast)', async () => {
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    const req = {
      contents: [],
      config: {},
    } as unknown as Parameters<AnthropicVertexLlm['generateContentAsync']>[0];
    for await (const _ of llm.generateContentAsync(req)) {
      void _;
    }

    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(otelApi.SpanStatusCode.ERROR);
  });
});

describe('AnthropicVertexLlm — 異常系', () => {
  it('connect() は NotImplemented で throw する (Phase 0 scope)', async () => {
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    await expect(llm.connect({} as unknown as Parameters<AnthropicVertexLlm['connect']>[0])).rejects.toThrow(
      /not implemented/i,
    );
  });
});

describe('AnthropicVertexLlm — supportedModels', () => {
  it('^claude-.*$ regex が supportedModels に登録されている', () => {
    expect(AnthropicVertexLlm.supportedModels).toHaveLength(1);
    const re = AnthropicVertexLlm.supportedModels[0] as RegExp;
    expect(re).toBeInstanceOf(RegExp);
    expect(re.test('claude-sonnet-4-6')).toBe(true);
    expect(re.test('claude-opus-4-8')).toBe(true);
    expect(re.test('gemini-2.5-flash')).toBe(false);
  });
});

describe('AnthropicVertexLlm — tool routing (Phase 2)', () => {
  /**
   * Phase 2 で導入した 3 つの拡張経路を unit test で固定する:
   *   (a) `config.tools` → `toAnthropicTools` → `messages.create({tools})` で Anthropic API に
   *       tool 定義が届く
   *   (b) `tool_use` 単一 block → `functionCall` part に変換 (= `id` 保持)
   *   (c) `tool_use` 複数 block → 複数 `functionCall` part に変換 (= multi-block 対応)
   *
   * これにより Phase 0 で Phase 2 申し送りとして残した TODO 3 つ (LlmRequestConfig.tools /
   * messages.create({tools}) / toLlmResponse の tool_use 変換) が消化された状態の回帰を防ぐ。
   */
  function llmRequestWithTools(text: string, tools: Array<{ functionDeclarations?: unknown[] }>) {
    return {
      contents: [{ role: 'user', parts: [{ text }] }],
      config: { tools },
    } as unknown as Parameters<AnthropicVertexLlm['generateContentAsync']>[0];
  }

  it('config.tools 経路: toAnthropicTools 変換後の tools が messages.create に渡る', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'end_turn',
    });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    const req = llmRequestWithTools('test', [
      {
        functionDeclarations: [
          {
            name: 'acquire_biblio',
            description: 'Acquire a skill',
            parameters: { type: 'OBJECT', properties: { repo: { type: 'STRING' } } },
          },
        ],
      },
    ]);
    for await (const _ of llm.generateContentAsync(req)) {
      void _;
    }
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
    const callArgs = messagesCreateMock.mock.calls[0][0] as {
      tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>;
    };
    expect(callArgs.tools).toEqual([
      {
        name: 'acquire_biblio',
        description: 'Acquire a skill',
        input_schema: {
          type: 'object',
          properties: { repo: { type: 'string' } },
        },
      },
    ]);
  });

  it('config.tools が undefined / 空配列のとき tools 引数は SDK に渡らない (= 既存経路保持)', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    // config.tools 指定なし (= llmRequest 既存パターン)
    await llm.generateContentAsync(llmRequest('hello')).next();
    const callArgs = messagesCreateMock.mock.calls[0][0] as { tools?: unknown };
    expect(callArgs.tools).toBeUndefined();

    // 空 entry でも tools は渡らない (= toAnthropicTools が空配列を返す経路)
    messagesCreateMock.mockReset();
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    });
    await llm.generateContentAsync(llmRequestWithTools('hello', [{ functionDeclarations: [] }])).next();
    const callArgs2 = messagesCreateMock.mock.calls[0][0] as { tools?: unknown };
    expect(callArgs2.tools).toBeUndefined();
  });

  it('tool_use 単一 block を functionCall part に変換 + id 保持', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01abc',
          name: 'acquire_biblio',
          input: { repo: 'wf/test' },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'tool_use',
    });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    const results: unknown[] = [];
    for await (const r of llm.generateContentAsync(llmRequest('acquire wf/test'))) {
      results.push(r);
    }
    expect(results).toHaveLength(1);
    const parts = (results[0] as { content: { parts: unknown[] } }).content.parts;
    expect(parts).toEqual([
      {
        functionCall: { id: 'toolu_01abc', name: 'acquire_biblio', args: { repo: 'wf/test' } },
      },
    ]);
  });

  it('multi-block: tool_use 複数 block を複数 functionCall part に変換', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [
        { type: 'tool_use', id: 'toolu_01a', name: 'acquire_biblio', input: { repo: 'wf/a' } },
        { type: 'tool_use', id: 'toolu_01b', name: 'inspect_biblio', input: { biblioName: 'wf--a' } },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'tool_use',
    });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    const results: unknown[] = [];
    for await (const r of llm.generateContentAsync(llmRequest('do both'))) {
      results.push(r);
    }
    const parts = (results[0] as { content: { parts: unknown[] } }).content.parts;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({
      functionCall: { id: 'toolu_01a', name: 'acquire_biblio', args: { repo: 'wf/a' } },
    });
    expect(parts[1]).toEqual({
      functionCall: { id: 'toolu_01b', name: 'inspect_biblio', args: { biblioName: 'wf--a' } },
    });
  });

  it('tool_use と text 混在: tool_use 優先で text 無視 (= 単純化された変換契約)', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [
        { type: 'text', text: 'これから tool を呼びます' },
        { type: 'tool_use', id: 'toolu_01', name: 'acquire_biblio', input: {} },
      ],
      stop_reason: 'tool_use',
    });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    const results: unknown[] = [];
    for await (const r of llm.generateContentAsync(llmRequest('q'))) {
      results.push(r);
    }
    const parts = (results[0] as { content: { parts: unknown[] } }).content.parts;
    // tool_use のみ抽出され、text は dropped
    expect(parts).toHaveLength(1);
    expect((parts[0] as { functionCall: unknown }).functionCall).toBeDefined();
  });

  it('functionResponse part (= 前回 tool 結果) を Anthropic tool_result block に変換 (Phase 2)', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: 'received' }],
      stop_reason: 'end_turn',
    });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    const req = {
      contents: [
        { role: 'user', parts: [{ text: 'acquire wf/test' }] },
        {
          role: 'model',
          parts: [{ functionCall: { id: 'toolu_01', name: 'acquire_biblio', args: { repo: 'wf/test' } } }],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'toolu_01',
                name: 'acquire_biblio',
                response: { ok: true, biblioName: 'wf--test' },
              },
            },
          ],
        },
      ],
      config: {},
    } as unknown as Parameters<AnthropicVertexLlm['generateContentAsync']>[0];
    await llm.generateContentAsync(req).next();
    const callArgs = messagesCreateMock.mock.calls[0][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(callArgs.messages).toHaveLength(3);
    expect(callArgs.messages[0]).toEqual({ role: 'user', content: 'acquire wf/test' });
    expect(callArgs.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_01', name: 'acquire_biblio', input: { repo: 'wf/test' } }],
    });
    expect(callArgs.messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_01',
          content: JSON.stringify({ ok: true, biblioName: 'wf--test' }),
        },
      ],
    });
  });

  it('functionResponse の response が string ならそのまま tool_result.content にする', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    const req = {
      contents: [{ role: 'user', parts: [{ functionResponse: { id: 'toolu_X', response: 'string result' } }] }],
      config: {},
    } as unknown as Parameters<AnthropicVertexLlm['generateContentAsync']>[0];
    await llm.generateContentAsync(req).next();
    const callArgs = messagesCreateMock.mock.calls[0][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const blocks = callArgs.messages[0].content as Array<{ type: string; content?: string }>;
    expect(blocks[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_X',
      content: 'string result',
    });
  });

  it('multi-block message (= text + functionCall 混在) を 1 message に配列 content で詰める', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    const req = {
      contents: [
        {
          role: 'model',
          parts: [
            { text: 'I will call acquire' },
            { functionCall: { id: 'toolu_99', name: 'acquire_biblio', args: { repo: 'a/b' } } },
          ],
        },
      ],
      config: {},
    } as unknown as Parameters<AnthropicVertexLlm['generateContentAsync']>[0];
    await llm.generateContentAsync(req).next();
    const callArgs = messagesCreateMock.mock.calls[0][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(callArgs.messages[0].role).toBe('assistant');
    expect(callArgs.messages[0].content).toEqual([
      { type: 'text', text: 'I will call acquire' },
      { type: 'tool_use', id: 'toolu_99', name: 'acquire_biblio', input: { repo: 'a/b' } },
    ]);
  });

  it('functionCall に id が無いと skip + log.warn (= silent failure 撲滅)', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    const req = {
      contents: [
        {
          role: 'model',
          parts: [{ functionCall: { name: 'no_id', args: {} } }, { text: 'fallback' }],
        },
      ],
      config: {},
    } as unknown as Parameters<AnthropicVertexLlm['generateContentAsync']>[0];
    await llm.generateContentAsync(req).next();
    const callArgs = messagesCreateMock.mock.calls[0][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(callArgs.messages[0]).toEqual({ role: 'assistant', content: 'fallback' });
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: 'adk.anthropic_vertex_llm.skip_invalid_function_call',
        outcome: 'skipped',
      }),
    );
  });

  it('functionResponse に id が無いと skip + log.warn (= functionCall と対称)', async () => {
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    const req = {
      contents: [
        {
          role: 'user',
          // id 不在の functionResponse は skip されるべき (= tool_use_id 対応関係を壊すため)
          parts: [{ functionResponse: { name: 'acquire_biblio', response: { ok: true } } }],
        },
      ],
      config: {},
    } as unknown as Parameters<AnthropicVertexLlm['generateContentAsync']>[0];
    // id 不在 → block skip → contents[0] が空 → EMPTY_MESSAGES 経路
    const result = (await llm.generateContentAsync(req).next()).value as { errorCode?: string };
    expect(result.errorCode).toBe('EMPTY_MESSAGES');
    expect(messagesCreateMock).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: 'adk.anthropic_vertex_llm.skip_invalid_function_response',
        outcome: 'skipped',
      }),
    );
  });

  it('tool_use block が来たが全 id/name 不正で filter 全滅 → warn (= silent failure 撲滅)', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [
        { type: 'tool_use', name: 'acquire_biblio', input: {} }, // id undefined
        { type: 'text', text: 'text fallback' },
      ],
      stop_reason: 'end_turn',
    });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    const results: unknown[] = [];
    for await (const r of llm.generateContentAsync(llmRequest('q'))) {
      results.push(r);
    }
    // text 経路に fall-through するが、tool_use が silent drop された事実を warn で残す
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: 'adk.anthropic_vertex_llm.tool_use_dropped',
        outcome: 'all_dropped',
        raw_count: 1,
      }),
    );
  });

  it('tool_use block の id が string でないとき skip + 残る block 0 件で text 経路へ', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [
        // id が undefined: predicate で skip
        { type: 'tool_use', name: 'acquire_biblio', input: {} },
        { type: 'text', text: 'text fallback' },
      ],
      stop_reason: 'end_turn',
    });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    const results: unknown[] = [];
    for await (const r of llm.generateContentAsync(llmRequest('q'))) {
      results.push(r);
    }
    const parts = (results[0] as { content: { parts: Array<{ text?: string }> } }).content.parts;
    expect(parts[0].text).toBe('text fallback');
  });
});
