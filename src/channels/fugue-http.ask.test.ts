/**
 * Fugue HTTP server の `POST /v1/channels/fugue/ask` skeleton test。
 *
 * fugue-http.gate.test.ts の mock pattern を写経 (listBiblio / shelf-gh / fugue-equipped-biblios
 * は ask 経路では使わないが、既存 test file 側の mock 慣習に合わせて空 mock を張っておく =
 * import 副作用が同一状態で走ることを保証)。実 HTTP fetch で以下を検証:
 *
 * skeleton reply は廃止され、backend (agent-container) 未接続時は
 * `resolveFugueAskConfig()` の DB lookup も throw する (initDb 未実行のテスト env)。fail-open で
 * `status:'error'` + `warnings:['ask_config_missing']` + `summary:'ask backend failed:
 * ask_config_missing'` の errorReply を 200 で返す (AD の本義契約: 5xx を出さない)。
 * spawn 経路の完全 test は `fugue-http.ask.wiring.test.ts` を参照。本 test file は:
 *   - 200 errorReply (config missing shape)
 *   - Zod validation (400)
 *   - 401 no-auth path enumeration guard
 *   - span 属性 (fugue.ask + intent/outcome) は error outcome で検証
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { FUGUE_ASK_INTENTS, type FugueAskReplyT } from './fugue-schemas.js';
import { FugueHttpServer } from './fugue-http.js';

const TOKEN = 'ask-test-token-abcdef0123456789abcdef0123456789abcdef01';

// ask 経路は listBiblio を呼ばないが、既存 fugue-http.*.test.ts の全 file が同じ mock を張って
// いる慣習に沿わせる (import 副作用の均一化)。default は無害な値を返す。
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

// Phase 1 では gate を呼ばない (Phase 2 で追加予定)。誤って gate が呼び込まれたら test が
// fail するように spy を張っておく (regression 保険、gate.test.ts と同じ手法)。
vi.mock('../gate/gate.js', () => ({
  isGateEnabled: vi.fn(() => false),
  evaluateGate: vi.fn(),
  withGateSpan: vi.fn(async (_text: string, fn: (span: unknown) => Promise<unknown>) => fn({ setAttribute: vi.fn() })),
}));

vi.mock('../gate/audit-log.js', () => ({
  appendGateAuditLog: vi.fn(),
}));

vi.mock('../modules/approvals/notify-admin.js', () => ({
  notifyAdmin: vi.fn().mockResolvedValue('sent'),
}));

let server: FugueHttpServer;
let baseUrl: string;

beforeEach(async () => {
  server = new FugueHttpServer({ port: 0, host: '127.0.0.1', expectedToken: TOKEN });
  const started = await server.start();
  baseUrl = `http://127.0.0.1:${started.port}`;
});

afterEach(async () => {
  await server.stop();
});

async function postAsk(body: unknown, options: { auth?: boolean } = { auth: true }): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.auth !== false) {
    headers.Authorization = `Bearer ${TOKEN}`;
  }
  return fetch(`${baseUrl}/v1/channels/fugue/ask`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('handleAsk (config missing errorReply)', () => {
  it('200 errorReply with minimum valid body (config missing = DB lookup throw, fail-open)', async () => {
    const res = await postAsk({ schema_version: '1', request_id: 'req-ask-1', query: 'test query' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FugueAskReplyT;
    expect(body).toMatchObject({
      schema_version: '1',
      request_id: 'req-ask-1',
      operation: 'ask',
      status: 'error',
      findings: [],
      sources: [],
      raw: {},
      warnings: ['ask_config_missing'],
    });
    expect(typeof body.summary).toBe('string');
    expect(body.summary.length).toBeGreaterThan(0);
  });

  it('processing_time_ms is a non-negative integer', async () => {
    const res = await postAsk({ schema_version: '1', request_id: 'req-ask-ptm', query: 'x' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FugueAskReplyT;
    expect(Number.isInteger(body.processing_time_ms)).toBe(true);
    expect(body.processing_time_ms).toBeGreaterThanOrEqual(0);
  });

  // A1-12: FUGUE_ASK_INTENTS の 3 リテラル (search-web / drive-lookup / general) を it.each で網羅。
  it.each(FUGUE_ASK_INTENTS)('accepts intent field as literal (%s)', async (intent) => {
    const res = await postAsk({
      schema_version: '1',
      request_id: `req-ask-intent-${intent}`,
      query: 'test',
      intent,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FugueAskReplyT;
    expect(body.status).toBe('error');
    expect(body.operation).toBe('ask');
  });

  it('accepts intent field as null', async () => {
    const res = await postAsk({
      schema_version: '1',
      request_id: 'req-ask-intent-null',
      query: 'test',
      intent: null,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FugueAskReplyT;
    expect(body.status).toBe('error');
  });

  it('accepts context_hint as record', async () => {
    const res = await postAsk({
      schema_version: '1',
      request_id: 'req-ask-ctx-rec',
      query: 'test',
      context_hint: { screen_summary: 'foo', active_tab: 'bar' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FugueAskReplyT;
    expect(body.status).toBe('error');
    // Phase 3 config missing errorReply は raw を空 object で emit する (agent-container 起動しない経路)。
    expect(body.raw).toEqual({});
  });

  it('accepts context_hint as null', async () => {
    const res = await postAsk({
      schema_version: '1',
      request_id: 'req-ask-ctx-null',
      query: 'test',
      context_hint: null,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FugueAskReplyT;
    expect(body.status).toBe('error');
  });

  it('accepts long query up to 2000 chars (upper bound)', async () => {
    const longQuery = 'x'.repeat(2000);
    const res = await postAsk({ schema_version: '1', request_id: 'req-ask-max', query: longQuery });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FugueAskReplyT;
    expect(body.status).toBe('error');
  });

  it('400 on missing schema_version', async () => {
    const res = await postAsk({ request_id: 'req-ask-no-ver', query: 'test' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues?: unknown[] };
    expect(body.error).toBe('invalid_input');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues!.length).toBeGreaterThan(0);
  });

  it('400 on invalid intent literal', async () => {
    const res = await postAsk({
      schema_version: '1',
      request_id: 'req-ask-bad-intent',
      query: 'test',
      intent: 'not-a-valid-intent',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues?: unknown[] };
    expect(body.error).toBe('invalid_input');
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('400 on empty query (min(1) fail)', async () => {
    const res = await postAsk({ schema_version: '1', request_id: 'req-ask-empty', query: '' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_input');
  });

  it('400 on query exceeding 2000 chars', async () => {
    const tooLong = 'x'.repeat(2001);
    const res = await postAsk({ schema_version: '1', request_id: 'req-ask-toolong', query: tooLong });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_input');
  });

  it('400 on request_id exceeding 64 chars', async () => {
    const longId = 'a'.repeat(65);
    const res = await postAsk({ schema_version: '1', request_id: longId, query: 'test' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_input');
  });

  it('400 on numeric schema_version (z.literal("1") string-only)', async () => {
    const res = await postAsk({ schema_version: 1, request_id: 'req-ask-numver', query: 'test' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_input');
  });

  it('401 on missing Authorization for /ask (auth check runs before path routing)', async () => {
    // /ask path でも auth 未認証は 404 ではなく 401 (path enumeration 遮断の不変条件)。
    const res = await postAsk({ schema_version: '1', request_id: 'req-ask-noauth', query: 'test' }, { auth: false });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'unauthorized' });
    expect(body).not.toHaveProperty('reason');
  });

  it('404 unknown path behavior is preserved after ASK_PATH insertion', async () => {
    // ask 追加後も未定義 path (`/v1/channels/fugue/invoke`) が 404 を返すこと = path 分岐追加で
    // fallback を壊していないこと。
    const res = await fetch(`${baseUrl}/v1/channels/fugue/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ schema_version: '1', request_id: 'req-ask-unk' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: 'not_found' });
  });
});

/**
 * `handleAsk` の span 属性 (`fugue.ask` 名 + channel / fugue.operation / fugue.request_id /
 * fugue.intent / fugue.outcome) を実 HTTP 経由で検証する。
 *
 * intent の `undefined`/`null`/リテラルの 3 パスを文字列 `'null'` / literal 名に畳み込む正規化
 * (`fugue-http.ts:1207`) は handleAsk 固有の新規ドメインロジックであり、typo や setAttribute 漏れ
 * があっても 200 応答自体は正しく返るため通常の response body test では検知不能。
 * `INTENT_GATE_MISMATCH` 判定の入力になるため、HTTP 経由の実結合 assertion を固める。
 *
 * `fugue-http.otel.test.ts` の consult / equip パターンを写経。
 */
describe('handleAsk span attributes', () => {
  let memoryExporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let server: FugueHttpServer;
  let baseUrl: string;

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

  beforeEach(async () => {
    memoryExporter.reset();
    server = new FugueHttpServer({ port: 0, host: '127.0.0.1', expectedToken: TOKEN });
    const started = await server.start();
    baseUrl = `http://127.0.0.1:${started.port}`;
  });

  afterEach(async () => {
    await server.stop();
  });

  async function postAskSpan(body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/v1/channels/fugue/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
  }

  it('fugue.ask span (INTERNAL kind) が発火し、基本属性が刻まれる', async () => {
    const res = await postAskSpan({ schema_version: '1', request_id: 'req-span-basic', query: 'test' });
    expect(res.status).toBe(200);

    const spans = memoryExporter.getFinishedSpans();
    const fugue = spans.find((s) => s.name === 'fugue.ask');
    expect(fugue).toBeDefined();
    expect(fugue!.kind).toBe(otelApi.SpanKind.INTERNAL);
    expect(fugue!.attributes.channel).toBe('fugue');
    expect(fugue!.attributes['fugue.operation']).toBe('ask');
    expect(fugue!.attributes['fugue.request_id']).toBe('req-span-basic');
  });

  it.each(FUGUE_ASK_INTENTS)('intent literal (%s) は fugue.intent 属性にそのまま刻まれる', async (intent) => {
    const res = await postAskSpan({
      schema_version: '1',
      request_id: `req-span-intent-${intent}`,
      query: 'test',
      intent,
    });
    expect(res.status).toBe(200);
    const fugue = memoryExporter.getFinishedSpans().find((s) => s.name === 'fugue.ask');
    expect(fugue?.attributes['fugue.intent']).toBe(intent);
  });

  it('intent 未指定は fugue.intent="null" に畳み込まれる', async () => {
    const res = await postAskSpan({ schema_version: '1', request_id: 'req-span-intent-undef', query: 'test' });
    expect(res.status).toBe(200);
    const fugue = memoryExporter.getFinishedSpans().find((s) => s.name === 'fugue.ask');
    expect(fugue?.attributes['fugue.intent']).toBe('null');
  });

  it('intent: null も fugue.intent="null" に畳み込まれる (`.optional().nullable()` の 2 パス集約)', async () => {
    const res = await postAskSpan({
      schema_version: '1',
      request_id: 'req-span-intent-null',
      query: 'test',
      intent: null,
    });
    expect(res.status).toBe(200);
    const fugue = memoryExporter.getFinishedSpans().find((s) => s.name === 'fugue.ask');
    expect(fugue?.attributes['fugue.intent']).toBe('null');
  });

  it('Phase 3 config missing の fugue.outcome は error に刻まれる', async () => {
    const res = await postAskSpan({ schema_version: '1', request_id: 'req-span-outcome', query: 'test' });
    expect(res.status).toBe(200);
    const fugue = memoryExporter.getFinishedSpans().find((s) => s.name === 'fugue.ask');
    expect(fugue?.attributes['fugue.outcome']).toBe('error');
  });
});
