/**
 * AnthropicVertexLlm のユニットテスト (M4-B Phase 0)。
 *
 * `src/biblio/vertex-client.test.ts` の `vi.hoisted` モック + InMemorySpanExporter パターン
 * を写経。AsyncGenerator + abortSignal + gen_ai.* span attribute の structural fix で
 * Phase 1 以降の regression を防ぐ。
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

describe('AnthropicVertexLlm — Critical/Important 修正 (PR #89 review)', () => {
  it('空配列 systemInstruction で system field が SDK に渡らない (= C1 fix、`system: ""` 防御)', async () => {
    messagesCreateMock.mockResolvedValue({ content: [{ type: 'text', text: 'OK' }] });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    // 空配列 systemInstruction は truthy だが flatten で '' になる → system field 省略されること
    await llm.generateContentAsync(llmRequest('q', { systemInstruction: [] })).next();
    const callArgs = messagesCreateMock.mock.calls[0][0] as { system?: string };
    expect(callArgs.system).toBeUndefined();
  });

  it('parts のない Content[] systemInstruction も system field 省略される (= C1 fix、`{parts: []}` 防御)', async () => {
    messagesCreateMock.mockResolvedValue({ content: [{ type: 'text', text: 'OK' }] });
    const llm = new AnthropicVertexLlm({ model: 'claude-sonnet-4-6' });
    await llm
      .generateContentAsync(llmRequest('q', { systemInstruction: [{ parts: [] }, { parts: [{ text: '' }] }] }))
      .next();
    const callArgs = messagesCreateMock.mock.calls[0][0] as { system?: string };
    expect(callArgs.system).toBeUndefined();
  });

  it('空 contents で EMPTY_MESSAGES が yield される (= I3 fix、SDK 呼出回避)', async () => {
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
