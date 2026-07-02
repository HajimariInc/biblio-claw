/**
 * Fugue HTTP server の OTel integration test (M4-E Phase 4)。
 *
 * fugue-http.test.ts の mock pattern (listBiblio / shelf-gh / fugue-equipped-biblios / hitl-policy)
 * を port:0 ephemeral bind + 実 HTTP fetch に組み合わせて、Phase 4 で追加した 3 段 trace 構造
 * (auto server span → `fugue.consult`/`fugue.equip` → `biblio.list`/`biblio.equip`) と outcome 属性、
 * `traceparent` header からの trace_id 継承を InMemorySpanExporter で観測する。
 *
 * LOG_FORMAT=json 依存の trace 相関 log field 検証は `fugue-http.otel-log.test.ts` に分離
 * (log.ts の FORMAT は module load 時に評価されるため、env stubbing 経路は独立 file で
 * dynamic import する必要がある、plan Task 10 の Option B 判断)。
 */
import * as otelApi from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListBiblioResult } from '../biblio/types.js';

import { FugueHttpServer } from './fugue-http.js';

const TOKEN = 'otel-test-token-abcdef0123456789abcdef0123456789abcdef01';

vi.mock('../biblio/list-biblio.js', () => ({
  listBiblio: vi.fn(),
}));

vi.mock('../biblio/shelf-gh.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../biblio/shelf-gh.js')>();
  return {
    ...original,
    readListEnv: vi.fn(() => ({ shelfOwner: 'MockOwner', shelfRepo: 'mock-shelf' })),
  };
});

vi.mock('../db/fugue-equipped-biblios.js', () => ({
  insertFugueEquippedBiblio: vi.fn(() => true),
  getFugueEquippedBiblioNames: vi.fn(() => []),
  deleteFugueEquippedBiblioByName: vi.fn(() => 0),
}));

const FIXTURE_RESULT: ListBiblioResult = {
  ok: true,
  items: [
    {
      name: 'HajimariInc--figma-reviewer',
      category: 'biblio-art',
      description: 'Figma design review skill.',
      version: '1.2.0',
    },
    {
      name: 'HajimariInc--code-formatter',
      category: 'biblio-dev',
      description: 'Auto-format TypeScript files.',
      version: '0.5.1',
    },
  ],
  counts: {
    'biblio-dev': 1,
    'biblio-art': 1,
    'biblio-bf': 0,
    'biblio-ai': 0,
    unknown: 0,
  },
  total: 2,
  appliedFilter: null,
};

describe('FugueHttpServer OTel integration (Phase 4)', () => {
  let memoryExporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let server: FugueHttpServer;
  let baseUrl: string;

  beforeAll(() => {
    otelApi.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    otelApi.propagation.setGlobalPropagator(new W3CTraceContextPropagator());
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
    otelApi.propagation.disable();
    otelApi.context.disable();
  });

  beforeEach(async () => {
    memoryExporter.reset();
    // listBiblio は各 test で mockResolvedValueOnce / mockRejectedValueOnce で書き分ける
    // (default は FIXTURE_RESULT を返す)。
    const { listBiblio } = await import('../biblio/list-biblio.js');
    vi.mocked(listBiblio).mockResolvedValue(FIXTURE_RESULT);
    server = new FugueHttpServer({ port: 0, host: '127.0.0.1', expectedToken: TOKEN });
    const started = await server.start();
    baseUrl = `http://127.0.0.1:${started.port}`;
  });

  afterEach(async () => {
    await server.stop();
    vi.mocked((await import('../biblio/list-biblio.js')).listBiblio).mockReset();
  });

  it('consult で fugue.consult 親 → biblio.list 子 の 3 段構造 (中央 + 下 layer) が発火する', async () => {
    const res = await fetch(`${baseUrl}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-otel-1',
        query: 'Figma',
        mode: 'ask-ad',
      }),
    });
    expect(res.status).toBe(200);

    const spans = memoryExporter.getFinishedSpans();
    const fugue = spans.find((s) => s.name === 'fugue.consult');
    const biblio = spans.find((s) => s.name === 'biblio.list');
    expect(fugue).toBeDefined();
    expect(biblio).toBeDefined();
    expect(biblio!.parentSpanContext?.spanId).toBe(fugue!.spanContext().spanId);
    expect(biblio!.spanContext().traceId).toBe(fugue!.spanContext().traceId);
    expect(fugue!.kind).toBe(otelApi.SpanKind.INTERNAL);
    expect(fugue!.attributes.channel).toBe('fugue');
    expect(fugue!.attributes['fugue.operation']).toBe('consult');
    expect(fugue!.attributes['fugue.request_id']).toBe('req-otel-1');
    expect(fugue!.attributes['fugue.mode']).toBe('ask-ad');
  });

  it('valid traceparent header 送信時に fugue.consult span の trace_id が継承される', async () => {
    const parentTraceId = '0af7651916cd43dd8448eb211c80319c';
    const res = await fetch(`${baseUrl}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
        traceparent: `00-${parentTraceId}-b7ad6b7169203331-01`,
      },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-otel-tp',
        query: 'Figma',
        mode: 'ask-ad',
      }),
    });
    expect(res.status).toBe(200);

    const spans = memoryExporter.getFinishedSpans();
    const fugue = spans.find((s) => s.name === 'fugue.consult')!;
    expect(fugue.spanContext().traceId).toBe(parentTraceId);
    // biblio.list も同じ trace_id を継承する (3 段構造の trace 連続性)。
    const biblio = spans.find((s) => s.name === 'biblio.list')!;
    expect(biblio.spanContext().traceId).toBe(parentTraceId);
  });

  it('consult 成功経路で fugue.outcome=ok が付与される', async () => {
    const res = await fetch(`${baseUrl}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-otel-ok',
        query: 'Figma',
        mode: 'ask-ad',
      }),
    });
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');

    const fugue = memoryExporter.getFinishedSpans().find((s) => s.name === 'fugue.consult')!;
    expect(fugue.attributes['fugue.outcome']).toBe('ok');
    expect(fugue.status.code).toBe(otelApi.SpanStatusCode.UNSET);
  });

  it('consult 0 件経路 (query 不一致) で fugue.outcome=not_found が付与される', async () => {
    const res = await fetch(`${baseUrl}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-otel-notfound',
        query: 'no-such-keyword-in-fixture',
        mode: 'ask-ad',
      }),
    });
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('not_found');

    const fugue = memoryExporter.getFinishedSpans().find((s) => s.name === 'fugue.consult')!;
    expect(fugue.attributes['fugue.outcome']).toBe('not_found');
  });

  it('consult listBiblio throw 経路で fugue.outcome=error + biblio.list は ERROR status', async () => {
    const { listBiblio } = await import('../biblio/list-biblio.js');
    vi.mocked(listBiblio).mockRejectedValueOnce(new Error('simulated network error'));

    const res = await fetch(`${baseUrl}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-otel-err',
        query: 'Figma',
        mode: 'ask-ad',
      }),
    });
    // AD の本義: listBiblio throw は 200 + status:'error' で運ぶ (5xx を出さない)。
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('error');

    const spans = memoryExporter.getFinishedSpans();
    const fugue = spans.find((s) => s.name === 'fugue.consult')!;
    const biblio = spans.find((s) => s.name === 'biblio.list')!;
    expect(fugue.attributes['fugue.outcome']).toBe('error');
    // biblio.list は ERROR status (分岐内で明示的に setStatus)。
    // fugue.consult 側は 200 応答なので status UNSET のまま (outcome 属性のみで error 表現)。
    expect(biblio.status.code).toBe(otelApi.SpanStatusCode.ERROR);
    expect(fugue.status.code).toBe(otelApi.SpanStatusCode.UNSET);
  });

  it('equip 成功経路で fugue.equip → biblio.equip 3 段 + fugue.outcome=equipped', async () => {
    const res = await fetch(`${baseUrl}/v1/channels/fugue/equip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-eq-otel',
        skill_id: 'HajimariInc--figma-reviewer',
        channel: 'fugue',
      }),
    });
    expect(res.status).toBe(200);

    const spans = memoryExporter.getFinishedSpans();
    const fugue = spans.find((s) => s.name === 'fugue.equip')!;
    const biblio = spans.find((s) => s.name === 'biblio.equip')!;
    expect(fugue.attributes.channel).toBe('fugue');
    expect(fugue.attributes['fugue.operation']).toBe('equip');
    expect(fugue.attributes['fugue.outcome']).toBe('equipped');
    expect(biblio.parentSpanContext?.spanId).toBe(fugue.spanContext().spanId);
  });
});
