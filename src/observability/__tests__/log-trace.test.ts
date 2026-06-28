import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { context, propagation, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, AlwaysOnSampler, ParentBasedSampler } from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';

describe('emitJson with active trace context', () => {
  let provider: BasicTracerProvider;
  const originalFormat = process.env.LOG_FORMAT;
  const originalLevel = process.env.LOG_LEVEL;
  const writes: string[] = [];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    process.env.LOG_FORMAT = 'json';
    process.env.LOG_LEVEL = 'debug';
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    provider = new BasicTracerProvider({
      sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
    });
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    process.env.LOG_FORMAT = originalFormat;
    process.env.LOG_LEVEL = originalLevel;
    await provider?.shutdown().catch(() => undefined);
    trace.disable();
    propagation.disable();
    context.disable();
  });

  beforeEach(() => {
    writes.length = 0;
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('active span 内の log は payload に trace field を持つ', async () => {
    const { log } = await import('../../log.js');
    const tracer = trace.getTracer('log-trace-test');
    tracer.startActiveSpan('parent', (span) => {
      log.info('hello', { foo: 'bar' });
      span.end();
    });
    expect(writes.length).toBeGreaterThan(0);
    const payload = JSON.parse(writes[0]);
    expect(payload['logging.googleapis.com/trace']).toMatch(/^[0-9a-f]{32}$/);
    expect(payload['logging.googleapis.com/spanId']).toMatch(/^[0-9a-f]{16}$/);
    expect(payload['logging.googleapis.com/trace_sampled']).toBe(true);
    expect(payload.foo).toBe('bar');
  });

  it('active span 不在時は trace field 無し (= 既存と互換)', async () => {
    const { log } = await import('../../log.js');
    log.info('no-span');
    const payload = JSON.parse(writes[0]);
    expect(payload['logging.googleapis.com/trace']).toBeUndefined();
    expect(payload['logging.googleapis.com/spanId']).toBeUndefined();
  });
});
