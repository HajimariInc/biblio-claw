import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { context, propagation, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, AlwaysOnSampler, ParentBasedSampler } from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';

import { getTraceLogFields } from './trace-fields.js';

describe('getTraceLogFields (agent)', () => {
  let provider: BasicTracerProvider;

  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    provider = new BasicTracerProvider({
      sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
    });
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    await provider?.shutdown().catch(() => undefined);
    trace.disable();
    propagation.disable();
    context.disable();
  });

  it('active span 不在時は空オブジェクト', () => {
    expect(getTraceLogFields()).toEqual({});
  });

  it('active span 有り時に 3 reserved field', () => {
    const tracer = trace.getTracer('agent-trace-fields-test');
    tracer.startActiveSpan('test', (span) => {
      const fields = getTraceLogFields();
      expect(fields['logging.googleapis.com/trace']).toMatch(/^[0-9a-f]{32}$/);
      expect(fields['logging.googleapis.com/spanId']).toMatch(/^[0-9a-f]{16}$/);
      expect(fields['logging.googleapis.com/trace_sampled']).toBe(true);
      span.end();
    });
  });
});
