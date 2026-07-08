/**
 * Fugue HTTP server の OTel integration test。
 *
 * fugue-http.test.ts の mock pattern (listBiblio / shelf-gh / fugue-equipped-biblios / hitl-policy)
 * を port:0 ephemeral bind + 実 HTTP fetch に組み合わせて、**2 段 trace 構造**
 * (`fugue.consult`/`fugue.equip` → `biblio.list`/`biblio.equip`) と outcome 属性、`traceparent`
 * header からの trace_id 継承を InMemorySpanExporter で観測する。
 *
 * **auto server span 層 (kind=SERVER、HttpInstrumentation 経由) は本 test の scope 外**
 * (本 repo の ESM + `--import` 起動構成で HttpInstrumentation は現状未発火のため、real NodeSDK
 * + HttpInstrumentation を registration する統合 test は ESM フック整備後に別途組む予定 =
 * `docs/operations-runbook.md` §ESM フック判断 参照)。本 test は BasicTracerProvider による中央
 * (fugue) + 下 (biblio) の 2 layer 検証に特化し、上層 (auto server span) の親子関係検証は現状
 * unit test で担わない意思決定。
 *
 * LOG_FORMAT=json 依存の trace 相関 log field 検証は `fugue-http.otel-log.test.ts` に分離
 * (log.ts の FORMAT は module load 時に評価されるため、env stubbing 経路は独立 file で
 * dynamic import する必要がある)。
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

  it('consult で fugue.consult 親 → biblio.list 子 の 2 段構造 (中央 + 下 layer) が発火する', async () => {
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
    // biblio.list も同じ trace_id を継承する (2 段構造の trace 連続性)。
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

  it('equip 成功経路で fugue.equip → biblio.equip 2 段 + fugue.outcome=equipped', async () => {
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

  // equip 系失敗/欠落分岐の span 属性検証。
  // 従来 equip 側の OTel テストは成功 1 case のみで、not_found / already_equipped /
  // partial_failure (listBiblio throw / DB write throw) の 4 分岐は response body test 側で
  // しか担保されておらず、setAttribute のタイポや消し忘れが silent regression 化する構造。
  it('equip not_found 経路で fugue.outcome=not_found + biblio.equip.biblio.outcome=not_found', async () => {
    const res = await fetch(`${baseUrl}/v1/channels/fugue/equip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-eq-nf-otel',
        skill_id: 'HajimariInc--does-not-exist',
        channel: 'fugue',
      }),
    });
    expect(res.status).toBe(200);

    const spans = memoryExporter.getFinishedSpans();
    const fugue = spans.find((s) => s.name === 'fugue.equip')!;
    const biblio = spans.find((s) => s.name === 'biblio.equip')!;
    expect(fugue.attributes['fugue.outcome']).toBe('not_found');
    expect(biblio.attributes['biblio.outcome']).toBe('not_found');
    // 200 応答なので fugue span status は UNSET のまま (outcome 属性で表現)。
    expect(fugue.status.code).toBe(otelApi.SpanStatusCode.UNSET);
  });

  it('equip already_equipped 経路で fugue.outcome=already_equipped が付与される', async () => {
    const equipped = await import('../db/fugue-equipped-biblios.js');
    // insertFugueEquippedBiblio が false 返却 = 既装備 (INSERT OR IGNORE + info.changes === 0)。
    vi.mocked(equipped.insertFugueEquippedBiblio).mockReturnValueOnce(false);

    const res = await fetch(`${baseUrl}/v1/channels/fugue/equip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-eq-ae-otel',
        skill_id: 'HajimariInc--figma-reviewer',
        channel: 'fugue',
      }),
    });
    expect(res.status).toBe(200);

    const fugue = memoryExporter.getFinishedSpans().find((s) => s.name === 'fugue.equip')!;
    expect(fugue.attributes['fugue.outcome']).toBe('already_equipped');
    // biblio.equip の outcome は success (equipped も already_equipped も 200 で装備状態は保証されている)。
    const biblio = memoryExporter.getFinishedSpans().find((s) => s.name === 'biblio.equip')!;
    expect(biblio.attributes['biblio.outcome']).toBe('success');
  });

  it('equip listBiblio throw 経路で fugue.outcome=error + biblio.equip は ERROR status', async () => {
    const { listBiblio } = await import('../biblio/list-biblio.js');
    vi.mocked(listBiblio).mockRejectedValueOnce(new Error('simulated gh outage'));

    const res = await fetch(`${baseUrl}/v1/channels/fugue/equip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-eq-lbf-otel',
        skill_id: 'HajimariInc--figma-reviewer',
        channel: 'fugue',
      }),
    });
    // AD の本義: 200 + status:'error' で運ぶ (5xx を出さない、consult 側と対称)。
    expect(res.status).toBe(200);

    const spans = memoryExporter.getFinishedSpans();
    const fugue = spans.find((s) => s.name === 'fugue.equip')!;
    const biblio = spans.find((s) => s.name === 'biblio.equip')!;
    expect(fugue.attributes['fugue.outcome']).toBe('error');
    expect(biblio.status.code).toBe(otelApi.SpanStatusCode.ERROR);
    // fugue span status は 200 応答経路なので UNSET (consult 側と同じ非対称仕様)。
    expect(fugue.status.code).toBe(otelApi.SpanStatusCode.UNSET);
  });

  it('equip DB write throw 経路で fugue.outcome=error + biblio.equip は ERROR status', async () => {
    const equipped = await import('../db/fugue-equipped-biblios.js');
    vi.mocked(equipped.insertFugueEquippedBiblio).mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });

    const res = await fetch(`${baseUrl}/v1/channels/fugue/equip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-eq-dbw-otel',
        skill_id: 'HajimariInc--figma-reviewer',
        channel: 'fugue',
      }),
    });
    expect(res.status).toBe(200);

    const spans = memoryExporter.getFinishedSpans();
    const fugue = spans.find((s) => s.name === 'fugue.equip')!;
    const biblio = spans.find((s) => s.name === 'biblio.equip')!;
    expect(fugue.attributes['fugue.outcome']).toBe('error');
    expect(biblio.status.code).toBe(otelApi.SpanStatusCode.ERROR);
    expect(biblio.status.message).toBe('equip_state_write_failed');
  });

  // 401 応答で fugue span が発火しないことの regression guard。
  // fugue-http.ts:326-340 の Bearer auth 判定は L347 の runInContext より **前** に位置し、
  // 構造的に 401 応答では withFugueEntrySpan に到達しない。既存 ad-honji.test.ts は status code のみ
  // 確認、本 test は span 発火有無を明示 assert して将来 auth chunk が span 生成の後ろに移動する
  // regression (未認証クライアントへの info leak) を検知可能にする。
  it('401 invalid Bearer 応答で fugue span は発火しない (auth-before-context.with 不変条件)', async () => {
    const res = await fetch(`${baseUrl}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-401-otel',
        query: 'x',
        mode: 'ask-ad',
      }),
    });
    expect(res.status).toBe(401);
    // BasicTracerProvider 経由の fugue/biblio span はどちらも発火していない。
    // auto server span (Phase 5 で発火予定) は本 test に registration していないため、
    // ここでの空 assertion は「Phase 4 で明示的に発火させる span 群」が発火しなかったことを意味する。
    const spans = memoryExporter.getFinishedSpans();
    expect(spans.find((s) => s.name === 'fugue.consult')).toBeUndefined();
    expect(spans.find((s) => s.name === 'fugue.equip')).toBeUndefined();
    expect(spans.find((s) => s.name === 'biblio.list')).toBeUndefined();
    expect(spans.find((s) => s.name === 'biblio.equip')).toBeUndefined();
  });

  // Phase 4 review M1 (silent-failure #2): equipped_state_unavailable の劣化成功で
  // fugue.degraded=true が刻まれることを検証。従来は log.warn のみで span 属性に categorical
  // signal がなく、Cloud Trace の outcome ベース集計で「劣化した成功」が通常の成功と区別不能だった。
  it('consult equipped_state_unavailable 経路で fugue.degraded=true + fugue.outcome=ok (劣化成功)', async () => {
    const equipped = await import('../db/fugue-equipped-biblios.js');
    vi.mocked(equipped.getFugueEquippedBiblioNames).mockImplementationOnce(() => {
      throw new Error('SQLITE_LOCKED: database is locked');
    });

    const res = await fetch(`${baseUrl}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-eq-degraded',
        query: 'Figma',
        mode: 'ask-ad',
      }),
    });
    expect(res.status).toBe(200);

    const fugue = memoryExporter.getFinishedSpans().find((s) => s.name === 'fugue.consult')!;
    expect(fugue.attributes['fugue.outcome']).toBe('ok');
    // 劣化 signal: 装備状態欠落は log.warn だけでなく span 属性でも UI/BQ が検知可能。
    expect(fugue.attributes['fugue.degraded']).toBe(true);
  });
});
