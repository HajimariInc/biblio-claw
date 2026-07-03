/**
 * HTTP header 用 TextMapGetter (`httpHeadersGetter`) と `extractTraceContextFromHttpHeaders`
 * の contract test (M4-E Phase 4)。
 *
 * env-propagation の pattern (`propagation-roundtrip.test.ts`) を Fugue channel の HTTP header
 * carrier 版に写経した位置付け。W3C propagator の global 設定は本 test file 内で完結させ、
 * 他 test file への leakage を防ぐため afterAll で必ず reset する (M4-A で確立済の
 * 「global state を触る test は必ず reset」慣習)。
 */
import type { IncomingHttpHeaders } from 'node:http';

import { context, propagation, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extractTraceContextFromHttpHeaders, httpHeadersGetter } from '../http-propagation.js';

describe('httpHeadersGetter', () => {
  it('lowercase key で string 値を返す (Node.js 通常経路)', () => {
    const headers: IncomingHttpHeaders = { traceparent: '00-abc-def-01' };
    expect(httpHeadersGetter.get(headers, 'traceparent')).toBe('00-abc-def-01');
  });

  it('mixed case key でも lowercase 化して解決する (case-insensitive 契約)', () => {
    const headers: IncomingHttpHeaders = { traceparent: '00-abc-def-01' };
    expect(httpHeadersGetter.get(headers, 'Traceparent')).toBe('00-abc-def-01');
    expect(httpHeadersGetter.get(headers, 'TRACEPARENT')).toBe('00-abc-def-01');
  });

  it('値が string[] のとき先頭を採用する (W3C first-hit 準拠)', () => {
    const headers: IncomingHttpHeaders = { 'x-multi': ['first', 'second'] } as IncomingHttpHeaders;
    expect(httpHeadersGetter.get(headers, 'x-multi')).toBe('first');
  });

  it('key 不在で undefined を返す', () => {
    const headers: IncomingHttpHeaders = {};
    expect(httpHeadersGetter.get(headers, 'traceparent')).toBeUndefined();
  });

  it('keys() で全 header 名を返す (order 非保証、集合で比較)', () => {
    const headers: IncomingHttpHeaders = { traceparent: 'x', authorization: 'y' };
    expect(httpHeadersGetter.keys(headers).sort()).toEqual(['authorization', 'traceparent']);
  });
});

describe('extractTraceContextFromHttpHeaders', () => {
  let provider: BasicTracerProvider;

  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    provider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    await provider?.shutdown().catch(() => undefined);
    trace.disable();
    propagation.disable();
    context.disable();
  });

  it('valid traceparent header から trace_id を復元する', () => {
    const headers: IncomingHttpHeaders = {
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    };
    const ctx = extractTraceContextFromHttpHeaders(headers);
    const span = trace.getSpan(ctx);
    expect(span?.spanContext().traceId).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('traceparent 不在時は ROOT_CONTEXT を返す (silent fallback)', () => {
    const headers: IncomingHttpHeaders = {};
    const ctx = extractTraceContextFromHttpHeaders(headers);
    expect(trace.getSpan(ctx)).toBeUndefined();
  });

  it('traceparent malformed (grammar 違反) 時は ROOT_CONTEXT を返す (silent fallback)', () => {
    const headers: IncomingHttpHeaders = { traceparent: 'not-a-valid-header' };
    const ctx = extractTraceContextFromHttpHeaders(headers);
    expect(trace.getSpan(ctx)).toBeUndefined();
  });

  // PR #135 review 提案 6b 対応: Phase 4 review C1 で `base=context.active()` デフォルト引数を
  // 導入した目的 = 将来 auto HTTP SERVER span 層が発火した際に、既存 active span を破壊せず
  // extract を適用する契約。既存 test (`traceparent 不在時は ROOT_CONTEXT`) は active span 不在の
  // シナリオしかカバーしていないため、`ROOT_CONTEXT` を明示 base に渡す旧実装と挙動が区別できない。
  // pre-existing active span がある状態で本 test を追加することで、非破壊性を初めて固定化する
  // (2 段構造 → 将来 3 段化される可逆性の保険設計の存在証明)。
  it('traceparent 不在時に既存の active span を破壊しない (base=context.active() の非破壊契約)', () => {
    const tracer = provider.getTracer('test-non-destructive');
    const parentSpan = tracer.startSpan('pre-existing-active-span');
    const ctxWithParent = trace.setSpan(context.active(), parentSpan);
    context.with(ctxWithParent, () => {
      const result = extractTraceContextFromHttpHeaders({});
      // 既存 SERVER span (parentSpan) が返り値 context にそのまま保持される = 破壊しない。
      // 旧実装 (`base = ROOT_CONTEXT`) なら trace.getSpan(result) が undefined になる。
      expect(trace.getSpan(result)).toBe(parentSpan);
    });
    parentSpan.end();
  });

  it('valid traceparent header ありで既存 active span を上書きする (header 優先契約)', () => {
    // 上記の裏返し = 非破壊性は「header 有時は上書きする」契約と両立する。
    const tracer = provider.getTracer('test-header-priority');
    const parentSpan = tracer.startSpan('pre-existing-active-span-2');
    const ctxWithParent = trace.setSpan(context.active(), parentSpan);
    const headerTraceId = '0af7651916cd43dd8448eb211c80319c';
    context.with(ctxWithParent, () => {
      const result = extractTraceContextFromHttpHeaders({
        traceparent: `00-${headerTraceId}-b7ad6b7169203331-01`,
      });
      // header 由来の trace_id が active に = 既存 span は上書きされる。
      expect(trace.getSpan(result)?.spanContext().traceId).toBe(headerTraceId);
    });
    parentSpan.end();
  });
});
