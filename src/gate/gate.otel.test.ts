/**
 * `withGateSpan` の OTel span 属性値検証。
 *
 * `fugue-entry-span.test.ts` の `InMemorySpanExporter` パターンを写経し、`withGateSpan` の中で
 * 呼出側が `span.setAttribute` で刻んだ値が実際に finished span の attributes に載ることを
 * 検証する。従来 `gate.test.ts` の withGateSpan 検証は shape assert のみ (`span` オブジェクトが
 * fn に渡ることのみ) だったため、実際の router.ts / fugue-http.ts 側の呼出で属性名タイポ /
 * 属性欠落が起きても検知できない空白地帯だった。
 */
import * as otelApi from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { withGateSpan } from './gate.js';

describe('withGateSpan (OTel InMemorySpanExporter で属性値検証)', () => {
  let memoryExporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeAll(() => {
    otelApi.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    memoryExporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
      spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
    });
    otelApi.trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    await provider?.shutdown().catch(() => undefined);
    otelApi.trace.disable();
    otelApi.context.disable();
  });

  beforeEach(() => {
    memoryExporter.reset();
  });

  it('gate.classify span を立てて INTERNAL kind + gate.text_digest + gate.model 属性を初期設定する', async () => {
    await withGateSpan('hello world', async () => 0);
    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('gate.classify');
    expect(spans[0].kind).toBe(otelApi.SpanKind.INTERNAL);
    expect(spans[0].attributes['gate.text_digest']).toBe('hello world');
    expect(spans[0].attributes['gate.model']).toBeDefined();
  });

  it('呼出側 setAttribute で刻んだ gate.classification / gate.layer_hit / gate.reason / gate.latency_ms / gate.degraded が finished span に載る', async () => {
    await withGateSpan('anything', async (span) => {
      span.setAttribute('gate.classification', 'in-secure');
      span.setAttribute('gate.layer_hit', 'layer1');
      span.setAttribute('gate.reason', 'instruction override');
      span.setAttribute('gate.latency_ms', 42);
      span.setAttribute('gate.outcome', 'blocked');
      span.setAttribute('gate.degraded', true);
    });
    const spans = memoryExporter.getFinishedSpans();
    expect(spans[0].attributes['gate.classification']).toBe('in-secure');
    expect(spans[0].attributes['gate.layer_hit']).toBe('layer1');
    expect(spans[0].attributes['gate.reason']).toBe('instruction override');
    expect(spans[0].attributes['gate.latency_ms']).toBe(42);
    expect(spans[0].attributes['gate.outcome']).toBe('blocked');
    expect(spans[0].attributes['gate.degraded']).toBe(true);
  });

  it('text_digest は 200 chars で truncate + ... suffix', async () => {
    const long = 'x'.repeat(300);
    await withGateSpan(long, async () => 0);
    const spans = memoryExporter.getFinishedSpans();
    const digest = spans[0].attributes['gate.text_digest'] as string;
    expect(digest.length).toBe(200 + 3);
    expect(digest.endsWith('...')).toBe(true);
  });

  it('fn throw 時に recordException + ERROR status + gate.outcome=error を刻む (silent-failure 撲滅)', async () => {
    await expect(
      withGateSpan('trigger', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(otelApi.SpanStatusCode.ERROR);
    expect(spans[0].status.message).toBe('boom');
    expect(spans[0].attributes['gate.outcome']).toBe('error');
    expect(spans[0].events.some((e) => e.name === 'exception')).toBe(true);
  });
});
