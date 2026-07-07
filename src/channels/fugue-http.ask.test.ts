/**
 * Fugue HTTP server の M4-H Phase 1 `POST /v1/channels/fugue/ask` skeleton test。
 *
 * fugue-http.gate.test.ts の mock pattern を写経 (listBiblio / shelf-gh / fugue-equipped-biblios
 * は ask 経路では使わないが、既存 test file 側の mock 慣習に合わせて空 mock を張っておく =
 * import 副作用が同一状態で走ることを保証)。実 HTTP fetch で以下を検証:
 *
 * - 200 skeleton 応答 (status='not_available' + warnings=['skeleton_response'] + 固定 shape)
 * - intent field: literal / null / 未指定の 3 パスで 200 (`.optional().nullable()`)
 * - context_hint: record / null / 未指定の 3 パスで 200
 * - 400 Zod validation fail (schema_version 欠落 / invalid intent literal / query 空 / request_id 過長)
 * - 401 no auth (`/ask` でも 404 にならない = auth check が path 分岐より前という不変)
 * - processing_time_ms が non-negative integer
 * - 404 unknown path が既存挙動維持 (`/invoke` 経路)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

interface FugueAskReplyShape {
  schema_version: '1';
  request_id: string;
  operation: 'ask';
  status: 'ok' | 'denied' | 'not_available' | 'error';
  summary: string;
  findings: unknown[];
  sources: unknown[];
  raw: Record<string, unknown>;
  processing_time_ms: number;
  warnings: string[];
}

describe('handleAsk (M4-H Phase 1 skeleton)', () => {
  it('200 skeleton response with minimum valid body', async () => {
    const res = await postAsk({ schema_version: '1', request_id: 'req-ask-1', query: 'test query' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FugueAskReplyShape;
    expect(body).toMatchObject({
      schema_version: '1',
      request_id: 'req-ask-1',
      operation: 'ask',
      status: 'not_available',
      findings: [],
      sources: [],
      raw: {},
      warnings: ['skeleton_response'],
    });
    expect(typeof body.summary).toBe('string');
    expect(body.summary.length).toBeGreaterThan(0);
  });

  it('processing_time_ms is a non-negative integer', async () => {
    const res = await postAsk({ schema_version: '1', request_id: 'req-ask-ptm', query: 'x' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FugueAskReplyShape;
    expect(Number.isInteger(body.processing_time_ms)).toBe(true);
    expect(body.processing_time_ms).toBeGreaterThanOrEqual(0);
  });

  it('accepts intent field as literal (search-web)', async () => {
    const res = await postAsk({
      schema_version: '1',
      request_id: 'req-ask-intent-lit',
      query: 'test',
      intent: 'search-web',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FugueAskReplyShape;
    expect(body.status).toBe('not_available');
    expect(body.operation).toBe('ask');
  });

  it('accepts intent field as literal (drive-lookup)', async () => {
    const res = await postAsk({
      schema_version: '1',
      request_id: 'req-ask-intent-drv',
      query: 'test',
      intent: 'drive-lookup',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FugueAskReplyShape;
    expect(body.status).toBe('not_available');
  });

  it('accepts intent field as null', async () => {
    const res = await postAsk({
      schema_version: '1',
      request_id: 'req-ask-intent-null',
      query: 'test',
      intent: null,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FugueAskReplyShape;
    expect(body.status).toBe('not_available');
  });

  it('accepts context_hint as record', async () => {
    const res = await postAsk({
      schema_version: '1',
      request_id: 'req-ask-ctx-rec',
      query: 'test',
      context_hint: { screen_summary: 'foo', active_tab: 'bar' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FugueAskReplyShape;
    expect(body.status).toBe('not_available');
    // Phase 1 skeleton は context_hint を応答に反映しない (Phase 3 で backend に渡す予定)。
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
    const body = (await res.json()) as FugueAskReplyShape;
    expect(body.status).toBe('not_available');
  });

  it('accepts long query up to 2000 chars (upper bound)', async () => {
    const longQuery = 'x'.repeat(2000);
    const res = await postAsk({ schema_version: '1', request_id: 'req-ask-max', query: longQuery });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FugueAskReplyShape;
    expect(body.status).toBe('not_available');
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
