import { describe, expect, it, beforeAll } from 'vitest';
import { context, propagation, trace, ROOT_CONTEXT } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, AlwaysOnSampler, ParentBasedSampler } from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';

import { injectTraceContextToEnv, extractTraceContextFromEnv } from '../index.js';

// host: inject → agent (= 別 process の env) → extract で trace ID が同一に
// 復元されることを実検証する round-trip テスト。env-propagation.test.ts は
// Setter/Getter の振る舞いのみで OTel propagation 統合は別途必要。

describe('trace context env round-trip', () => {
  beforeAll(() => {
    // active span を context.active() で参照できるよう ContextManager を設定
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    // BasicTracerProvider (auto-instrumentations なし、起動軽量) で active span を作る
    const provider = new BasicTracerProvider({
      sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
    });
    trace.setGlobalTracerProvider(provider);
  });

  it('inject した active span の trace ID を extract で復元できる', () => {
    const tracer = trace.getTracer('roundtrip-test');
    tracer.startActiveSpan('parent-span', (span) => {
      const expectedTraceId = span.spanContext().traceId;

      const carrier: Record<string, string> = {};
      injectTraceContextToEnv(carrier);

      // UPPERCASE Setter 経由で TRACEPARENT が書かれる
      expect(carrier.TRACEPARENT).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

      const extractedCtx = extractTraceContextFromEnv(carrier);
      const extractedSpan = trace.getSpan(extractedCtx);
      expect(extractedSpan?.spanContext().traceId).toBe(expectedTraceId);

      span.end();
    });
  });

  it('active span 無し時は carrier が空のまま (= inject no-op)', () => {
    // ROOT_CONTEXT 配下で実行 (= active span 無し)
    context.with(ROOT_CONTEXT, () => {
      const carrier: Record<string, string> = {};
      injectTraceContextToEnv(carrier);
      expect(carrier.TRACEPARENT).toBeUndefined();
    });
  });

  it('env 不在時に extractTraceContextFromEnv は ROOT_CONTEXT を返す', () => {
    const extractedCtx = extractTraceContextFromEnv({});
    // ROOT_CONTEXT には span が乗っていない
    expect(trace.getSpan(extractedCtx)).toBeUndefined();
  });
});
