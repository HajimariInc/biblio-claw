/**
 * AnthropicVertexLlm のユニットテスト (M4-B Phase 0)。
 *
 * `src/biblio/vertex-client.test.ts` の `vi.hoisted` モック + InMemorySpanExporter パターン
 * を写経。AsyncGenerator + abortSignal + gen_ai.* span attribute の structural fix で
 * Phase 1 以降の regression を防ぐ。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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

beforeEach(() => {
  messagesCreateMock.mockReset();
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

describe('AnthropicVertexLlm — gen_ai.* span 計装', () => {
  it('span 名 = chat <model> + provider/model/usage 属性が立つ', async () => {
    const otelApi = await import('@opentelemetry/api');
    const sdk = await import('@opentelemetry/sdk-trace-base');
    const alsHooks = await import('@opentelemetry/context-async-hooks');
    const memoryExporter = new sdk.InMemorySpanExporter();
    otelApi.context.setGlobalContextManager(new alsHooks.AsyncLocalStorageContextManager().enable());
    const provider = new sdk.BasicTracerProvider({
      sampler: new sdk.ParentBasedSampler({ root: new sdk.AlwaysOnSampler() }),
      spanProcessors: [new sdk.SimpleSpanProcessor(memoryExporter)],
    });
    otelApi.trace.setGlobalTracerProvider(provider);

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

    memoryExporter.reset();
    await provider.shutdown().catch(() => undefined);
    otelApi.trace.disable();
    otelApi.context.disable();
  });

  it('region != global のとき server.address に region prefix が付く', async () => {
    const otelApi = await import('@opentelemetry/api');
    const sdk = await import('@opentelemetry/sdk-trace-base');
    const alsHooks = await import('@opentelemetry/context-async-hooks');
    const memoryExporter = new sdk.InMemorySpanExporter();
    otelApi.context.setGlobalContextManager(new alsHooks.AsyncLocalStorageContextManager().enable());
    const provider = new sdk.BasicTracerProvider({
      sampler: new sdk.ParentBasedSampler({ root: new sdk.AlwaysOnSampler() }),
      spanProcessors: [new sdk.SimpleSpanProcessor(memoryExporter)],
    });
    otelApi.trace.setGlobalTracerProvider(provider);

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
      memoryExporter.reset();
      await provider.shutdown().catch(() => undefined);
      otelApi.trace.disable();
      otelApi.context.disable();
    }
  });
});

describe('AnthropicVertexLlm — 異常系', () => {
  it('SDK が throw すると span.recordException + setStatus(ERROR) を立てて rethrow する', async () => {
    const otelApi = await import('@opentelemetry/api');
    const sdk = await import('@opentelemetry/sdk-trace-base');
    const alsHooks = await import('@opentelemetry/context-async-hooks');
    const memoryExporter = new sdk.InMemorySpanExporter();
    otelApi.context.setGlobalContextManager(new alsHooks.AsyncLocalStorageContextManager().enable());
    const provider = new sdk.BasicTracerProvider({
      sampler: new sdk.ParentBasedSampler({ root: new sdk.AlwaysOnSampler() }),
      spanProcessors: [new sdk.SimpleSpanProcessor(memoryExporter)],
    });
    otelApi.trace.setGlobalTracerProvider(provider);

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

    memoryExporter.reset();
    await provider.shutdown().catch(() => undefined);
    otelApi.trace.disable();
    otelApi.context.disable();
  });

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
