/**
 * Fugue HTTP server `handleAsk` の OTel integration test (M4-H Phase 4 Task 8)。
 *
 * 検証対象:
 *   - span 名 = `fugue.ask` (kind=INTERNAL)
 *   - span 属性 6 種: `channel` / `fugue.operation` / `fugue.request_id` / `fugue.intent` /
 *     `fugue.outcome` / `fugue.processing_time_ms`
 *   - event 系列: `fugue.ask.invoked` / `.completed` / `.rate_limited` に `operation:'ask'`
 *     が付与される
 *
 * mock pattern は `fugue-http.ask.wiring.test.ts` を写経、span exporter setup は
 * `fugue-http.otel.test.ts` を写経。両方の合体版。fugue-ask config は env override で強制。
 *
 * NOTE: happy path で必要な mock (session-manager / container-runner / db 系) は wiring.test.ts と
 * 同じ pattern。spawn 経路の全 mock を貼り込み、outbound.db は minimal shape で in-memory
 * (SQLite 実 open を避ける)。
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

import { _resetFugueRateLimitForTest } from './fugue-rate-limit.js';
import { FugueHttpServer, _resetFugueAskConfigCache } from './fugue-http.js';

const TOKEN = 'ask-otel-test-token-abcdef0123456789abcdef0123456789abcdef01';
const FUGUE_ASK_AG_ID = 'ag-fugue-ask-otel-mock';
const FUGUE_ASK_MG_ID = 'mg-fugue-ask-otel-mock';

// -----------------------------------------------------------------------------
// vi.mock 定義 (wiring.test.ts の 12 mock + log 経路)
// -----------------------------------------------------------------------------

vi.mock('../biblio/list-biblio.js', () => ({ listBiblio: vi.fn() }));

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

vi.mock('../gate/gate.js', () => ({
  isGateEnabled: vi.fn(() => false),
  evaluateGate: vi.fn(),
  withGateSpan: vi.fn(async (_text: string, fn: (span: unknown) => Promise<unknown>) => fn({ setAttribute: vi.fn() })),
}));

vi.mock('../gate/audit-log.js', () => ({ appendGateAuditLog: vi.fn() }));

vi.mock('../modules/approvals/notify-admin.js', () => ({ notifyAdmin: vi.fn().mockResolvedValue('sent') }));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../session-manager.js', () => ({
  resolveSession: vi.fn(),
  writeSessionMessage: vi.fn(),
  sessionDir: vi.fn(() => '/tmp/fugue-ask-otel-mock'),
  openOutboundDb: vi.fn(),
  isPreSpawnDbOpenError: vi.fn(() => false),
}));

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
}));

vi.mock('../db/sessions.js', () => ({ deleteSession: vi.fn() }));

vi.mock('../db/session-db.js', async () => ({
  markDelivered: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: vi.fn(),
  };
});

vi.mock('../db/agent-groups.js', () => ({
  getAgentGroupByFolder: vi.fn(() => undefined),
}));

vi.mock('../db/messaging-groups.js', () => ({
  getMessagingGroupByPlatform: vi.fn(() => undefined),
}));

interface FakeOutboundMessage {
  id: string;
  seq: number;
  kind: string;
  content: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  in_reply_to: string | null;
}

function buildFakeOutboundDb(rows: FakeOutboundMessage[]): unknown {
  return {
    prepare: vi.fn((sql: string) => {
      if (sql.includes('MAX(seq)')) {
        return { get: vi.fn(() => ({ m: 0 })), run: vi.fn(), all: vi.fn(() => []) };
      }
      if (sql.includes('WHERE seq >')) {
        return { all: vi.fn(() => rows), get: vi.fn(), run: vi.fn() };
      }
      return { run: vi.fn(), all: vi.fn(() => []), get: vi.fn() };
    }),
    close: vi.fn(),
  };
}

function buildValidAskResponseText(payload: {
  summary: string;
  findings?: Array<{ text: string; source_indexes?: number[] }>;
  sources?: Array<{
    kind: 'web' | 'drive';
    title: string;
    url: string;
    snippet: string;
    metadata?: Record<string, unknown>;
  }>;
}): string {
  return `<ask-response>${JSON.stringify({
    summary: payload.summary,
    findings: payload.findings ?? [],
    sources: payload.sources ?? [],
  })}</ask-response>`;
}

function buildMessageContent(bodyText: string): string {
  return JSON.stringify({ text: bodyText });
}

// -----------------------------------------------------------------------------
// server / OTel setup
// -----------------------------------------------------------------------------

let server: FugueHttpServer;
let baseUrl: string;
let memoryExporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

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
  _resetFugueRateLimitForTest();
  process.env.FUGUE_ASK_AGENT_GROUP_ID = FUGUE_ASK_AG_ID;
  process.env.FUGUE_ASK_MESSAGING_GROUP_ID = FUGUE_ASK_MG_ID;
  process.env.FUGUE_ASK_TIMEOUT_MS = '2000';
  _resetFugueAskConfigCache();

  const sessionMgrModule = await import('../session-manager.js');
  const containerModule = await import('../container-runner.js');
  const sessionsModule = await import('../db/sessions.js');
  const sessionDbModule = await import('../db/session-db.js');
  const gateModule = await import('../gate/gate.js');
  const logModule = await import('../log.js');

  vi.mocked(sessionMgrModule.resolveSession).mockReturnValue({
    session: {
      id: 'sess-otel-mock',
      agent_group_id: FUGUE_ASK_AG_ID,
      messaging_group_id: FUGUE_ASK_MG_ID,
      thread_id: 'req-mock',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    },
    created: true,
  });
  vi.mocked(sessionMgrModule.writeSessionMessage).mockImplementation(() => undefined);
  vi.mocked(containerModule.wakeContainer).mockResolvedValue(true);
  vi.mocked(containerModule.killContainer).mockImplementation(() => undefined);
  vi.mocked(sessionsModule.deleteSession).mockImplementation(() => undefined);
  vi.mocked(sessionDbModule.markDelivered).mockImplementation(() => undefined);
  vi.mocked(gateModule.isGateEnabled).mockReturnValue(false);
  const fsModule = await import('node:fs');
  vi.mocked(fsModule.rmSync).mockImplementation(() => undefined);
  vi.mocked(logModule.log.info).mockClear();
  vi.mocked(logModule.log.warn).mockClear();
  vi.mocked(logModule.log.error).mockClear();

  server = new FugueHttpServer({ port: 0, host: '127.0.0.1', expectedToken: TOKEN });
  const started = await server.start();
  baseUrl = `http://127.0.0.1:${started.port}`;
});

afterEach(async () => {
  await server.stop();
  delete process.env.FUGUE_ASK_AGENT_GROUP_ID;
  delete process.env.FUGUE_ASK_MESSAGING_GROUP_ID;
  delete process.env.FUGUE_ASK_TIMEOUT_MS;
  _resetFugueAskConfigCache();
  _resetFugueRateLimitForTest();
});

async function postAsk(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/channels/fugue/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

describe('handleAsk OTel span attributes (M4-H Phase 4)', () => {
  it('emits fugue.ask span with kind INTERNAL and channel/operation/request_id attributes', async () => {
    const sessionMgrModule = await import('../session-manager.js');
    const askText = buildValidAskResponseText({ summary: 'test summary' });
    vi.mocked(sessionMgrModule.openOutboundDb).mockReturnValue(
      buildFakeOutboundDb([
        {
          id: 'msg-1',
          seq: 3,
          kind: 'chat',
          content: buildMessageContent(askText),
          platform_id: null,
          channel_type: null,
          thread_id: null,
          in_reply_to: null,
        },
      ]) as never,
    );

    const res = await postAsk({
      schema_version: '1',
      request_id: 'req-otel-span-1',
      query: 'hello',
      intent: 'general',
    });
    expect(res.status).toBe(200);

    const spans = memoryExporter.getFinishedSpans();
    const fugue = spans.find((s) => s.name === 'fugue.ask');
    expect(fugue).toBeDefined();
    expect(fugue!.kind).toBe(otelApi.SpanKind.INTERNAL);
    expect(fugue!.attributes.channel).toBe('fugue');
    expect(fugue!.attributes['fugue.operation']).toBe('ask');
    expect(fugue!.attributes['fugue.request_id']).toBe('req-otel-span-1');
  });

  it('sets fugue.intent from request body (search-web)', async () => {
    const sessionMgrModule = await import('../session-manager.js');
    const askText = buildValidAskResponseText({ summary: 's' });
    vi.mocked(sessionMgrModule.openOutboundDb).mockReturnValue(
      buildFakeOutboundDb([
        {
          id: 'msg-2',
          seq: 3,
          kind: 'chat',
          content: buildMessageContent(askText),
          platform_id: null,
          channel_type: null,
          thread_id: null,
          in_reply_to: null,
        },
      ]) as never,
    );
    await postAsk({
      schema_version: '1',
      request_id: 'req-intent-1',
      query: 'q',
      intent: 'search-web',
    });
    const fugue = memoryExporter.getFinishedSpans().find((s) => s.name === 'fugue.ask')!;
    expect(fugue.attributes['fugue.intent']).toBe('search-web');
  });

  it('sets fugue.outcome=ok and fugue.processing_time_ms on success path', async () => {
    const sessionMgrModule = await import('../session-manager.js');
    const askText = buildValidAskResponseText({ summary: 'ok' });
    vi.mocked(sessionMgrModule.openOutboundDb).mockReturnValue(
      buildFakeOutboundDb([
        {
          id: 'msg-3',
          seq: 3,
          kind: 'chat',
          content: buildMessageContent(askText),
          platform_id: null,
          channel_type: null,
          thread_id: null,
          in_reply_to: null,
        },
      ]) as never,
    );
    await postAsk({
      schema_version: '1',
      request_id: 'req-ok-1',
      query: 'q',
      intent: 'general',
    });
    const fugue = memoryExporter.getFinishedSpans().find((s) => s.name === 'fugue.ask')!;
    expect(fugue.attributes['fugue.outcome']).toBe('ok');
    expect(typeof fugue.attributes['fugue.processing_time_ms']).toBe('number');
    expect(fugue.attributes['fugue.processing_time_ms']).toBeGreaterThanOrEqual(0);
  });

  it('sets fugue.outcome=error and processing_time_ms on config_missing path', async () => {
    delete process.env.FUGUE_ASK_AGENT_GROUP_ID;
    delete process.env.FUGUE_ASK_MESSAGING_GROUP_ID;
    _resetFugueAskConfigCache();

    const res = await postAsk({
      schema_version: '1',
      request_id: 'req-cfgmiss-1',
      query: 'q',
    });
    expect(res.status).toBe(200);
    const fugue = memoryExporter.getFinishedSpans().find((s) => s.name === 'fugue.ask')!;
    expect(fugue.attributes['fugue.outcome']).toBe('error');
    expect(typeof fugue.attributes['fugue.processing_time_ms']).toBe('number');
  });

  it('rate limit 429: fugue.ask span は生成されない (path 分岐前で早期 return)', async () => {
    process.env.FUGUE_ASK_RATE_POINTS = '2';
    _resetFugueRateLimitForTest();
    const sessionMgrModule = await import('../session-manager.js');
    const askText = buildValidAskResponseText({ summary: 's' });
    vi.mocked(sessionMgrModule.openOutboundDb).mockReturnValue(
      buildFakeOutboundDb([
        {
          id: 'msg-r',
          seq: 3,
          kind: 'chat',
          content: buildMessageContent(askText),
          platform_id: null,
          channel_type: null,
          thread_id: null,
          in_reply_to: null,
        },
      ]) as never,
    );
    // 2 req = allow, 3 req 目 = 429
    const r1 = await postAsk({ schema_version: '1', request_id: 'r1', query: 'q' });
    const r2 = await postAsk({ schema_version: '1', request_id: 'r2', query: 'q' });
    const r3 = await postAsk({ schema_version: '1', request_id: 'r3', query: 'q' });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(r3.headers.get('retry-after')).toMatch(/^\d+$/);
    delete process.env.FUGUE_ASK_RATE_POINTS;

    // rate_limited 経路は span を張らない (path 分岐前で early-return)
    const askSpans = memoryExporter.getFinishedSpans().filter((s) => s.name === 'fugue.ask');
    expect(askSpans).toHaveLength(2); // r1 + r2 のみ、r3 は span なし
  });
});

describe('handleAsk log payload has operation:"ask"', () => {
  it('fugue.ask.invoked event includes operation:"ask"', async () => {
    const sessionMgrModule = await import('../session-manager.js');
    const logModule = await import('../log.js');
    const askText = buildValidAskResponseText({ summary: 's' });
    vi.mocked(sessionMgrModule.openOutboundDb).mockReturnValue(
      buildFakeOutboundDb([
        {
          id: 'msg-log-1',
          seq: 3,
          kind: 'chat',
          content: buildMessageContent(askText),
          platform_id: null,
          channel_type: null,
          thread_id: null,
          in_reply_to: null,
        },
      ]) as never,
    );
    await postAsk({ schema_version: '1', request_id: 'req-log-1', query: 'q' });
    expect(vi.mocked(logModule.log.info)).toHaveBeenCalledWith(
      expect.stringContaining('Fugue ask invoked'),
      expect.objectContaining({
        event: 'fugue.ask.invoked',
        channel: 'fugue',
        operation: 'ask',
        request_id: 'req-log-1',
      }),
    );
  });

  it('fugue.ask.completed event includes operation:"ask" and processing_time_ms', async () => {
    const sessionMgrModule = await import('../session-manager.js');
    const logModule = await import('../log.js');
    const askText = buildValidAskResponseText({ summary: 's' });
    vi.mocked(sessionMgrModule.openOutboundDb).mockReturnValue(
      buildFakeOutboundDb([
        {
          id: 'msg-log-2',
          seq: 3,
          kind: 'chat',
          content: buildMessageContent(askText),
          platform_id: null,
          channel_type: null,
          thread_id: null,
          in_reply_to: null,
        },
      ]) as never,
    );
    await postAsk({ schema_version: '1', request_id: 'req-log-2', query: 'q' });
    expect(vi.mocked(logModule.log.info)).toHaveBeenCalledWith(
      expect.stringContaining('Fugue ask completed'),
      expect.objectContaining({
        event: 'fugue.ask.completed',
        channel: 'fugue',
        operation: 'ask',
        request_id: 'req-log-2',
        processing_time_ms: expect.any(Number),
      }),
    );
  });

  it('fugue.ask.rate_limited event includes operation:"ask" and retry_after_sec', async () => {
    process.env.FUGUE_ASK_RATE_POINTS = '1';
    _resetFugueRateLimitForTest();
    const sessionMgrModule = await import('../session-manager.js');
    const logModule = await import('../log.js');
    const askText = buildValidAskResponseText({ summary: 's' });
    vi.mocked(sessionMgrModule.openOutboundDb).mockReturnValue(
      buildFakeOutboundDb([
        {
          id: 'msg-log-3',
          seq: 3,
          kind: 'chat',
          content: buildMessageContent(askText),
          platform_id: null,
          channel_type: null,
          thread_id: null,
          in_reply_to: null,
        },
      ]) as never,
    );
    await postAsk({ schema_version: '1', request_id: 'r-a', query: 'q' });
    const rateHit = await postAsk({ schema_version: '1', request_id: 'r-b', query: 'q' });
    expect(rateHit.status).toBe(429);
    expect(vi.mocked(logModule.log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('Fugue ask rate limit exceeded'),
      expect.objectContaining({
        event: 'fugue.ask.rate_limited',
        channel: 'fugue',
        operation: 'ask',
        outcome: 'reject',
        retry_after_sec: expect.any(Number),
      }),
    );
    delete process.env.FUGUE_ASK_RATE_POINTS;
  });
});
