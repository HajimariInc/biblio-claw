/**
 * Fugue HTTP server unit tests (M4-E Phase 1)。
 *
 * ephemeral port (`port: 0`) を bind して実 HTTP request を fetch で叩き、
 * lifecycle + auth 4 分岐 + path 3 分岐 + Zod validation + body edge cases +
 * security invariant (auth-before-routing) の合計 12 ケースを検証する。
 * `port: 0` を bind すると Node が空き port を自動で割り当てる = test 間の衝突なし。
 */
import http from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FugueHttpServer } from './fugue-http.js';

const TOKEN = 'test-token-abcdef0123456789abcdef0123456789abcdef01';

describe('FugueHttpServer', () => {
  let server: FugueHttpServer;
  let port: number;

  beforeEach(async () => {
    server = new FugueHttpServer({ port: 0, host: '127.0.0.1', expectedToken: TOKEN });
    const started = await server.start();
    port = started.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('lifecycle: isListening() flips true→false across start/stop', async () => {
    expect(server.isListening()).toBe(true);
    await server.stop();
    expect(server.isListening()).toBe(false);
  });

  it('lifecycle: start() is idempotent when called twice', async () => {
    // beforeEach で 1 回 start 済。もう 1 回呼んでも throw せず同じ port を返す。
    const second = await server.start();
    expect(second.port).toBe(port);
    expect(server.isListening()).toBe(true);
  });

  it('401 without exposing reason when Authorization header is missing (S4)', async () => {
    // S4 対応: reason はサーバログ限定、client 応答は `{error: 'unauthorized'}` のみ。
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema_version: '1', request_id: 'req-nohdr' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'unauthorized' });
    expect(body).not.toHaveProperty('reason');
  });

  it('401 without exposing reason when Authorization is not Bearer (S4)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic dXNlcjpwYXNz',
      },
      body: JSON.stringify({ schema_version: '1', request_id: 'req-scheme' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'unauthorized' });
    expect(body).not.toHaveProperty('reason');
  });

  it('401 without exposing reason when Bearer token does not match (S4)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token-that-differs-in-value-and-length',
      },
      body: JSON.stringify({ schema_version: '1', request_id: 'req-badtok' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'unauthorized' });
    expect(body).not.toHaveProperty('reason');
  });

  it('200 skeleton response on POST /v1/channels/fugue/consult with valid Bearer + body', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ schema_version: '1', request_id: 'req-consult-ok' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      schema_version: '1',
      request_id: 'req-consult-ok',
      operation: 'consult',
      status: 'ok',
      stub: true,
    });
  });

  it('200 skeleton response on POST /v1/channels/fugue/equip with valid Bearer + body', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/equip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ schema_version: '1', request_id: 'req-equip-ok' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      schema_version: '1',
      request_id: 'req-equip-ok',
      operation: 'equip',
      status: 'ok',
      stub: true,
    });
  });

  it('404 on unknown path even with valid Bearer', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/invoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ schema_version: '1', request_id: 'req-unknown' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'not_found' });
  });

  it('400 on Zod validation failure (schema_version: "2")', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ schema_version: '2', request_id: 'req-badver' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues?: unknown[] };
    expect(body).toMatchObject({ error: 'invalid_input' });
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues!.length).toBeGreaterThan(0);
  });

  it('400 with detail=body is not valid JSON when body is malformed (S6)', async () => {
    // S6 対応: 非 JSON body → 400 分岐は Zod validation 失敗とは異なる response shape
    // (`detail` を返し `issues` を返さない)。この分岐が silent 罠にならないよう固定化。
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: '{not valid json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail?: string; issues?: unknown };
    expect(body.error).toBe('invalid_input');
    expect(body.detail).toBe('body is not valid JSON');
    expect(body.issues).toBeUndefined();
  });

  it('401 (not 404) on unknown path when Authorization is missing — auth is checked before routing (S8)', async () => {
    // S8 対応: 「未認証クライアントに有効な path の存在を漏らさない」security invariant を
    // 固定化。リファクタで auth check と path routing の順序が入れ替わると path enumeration
    // の隙が生まれる。
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema_version: '1', request_id: 'req-auth-before-route' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'unauthorized' });
  });
});

describe('FugueHttpServer stop() OS port release (Level 4 手動 E2E の automated 補完)', () => {
  // S7 に相当する probe test は Level 4 実測 + 上記 `isListening()` false 遷移で担保済で
  // 実装したが、DEN さん指示 (Wave4 まで全部修正) に沿って追加検証として置く。
  // 実 port bind で「close() のコールバックが確かに発火して port を返却したか」を確認。
  it('stop() releases the OS port so a fresh server can rebind it immediately', async () => {
    const s = new FugueHttpServer({ port: 0, host: '127.0.0.1', expectedToken: TOKEN });
    const started = await s.start();
    const boundPort = started.port;
    await s.stop();
    // 同じ port を fresh な http.Server で bind し直せることを確認。close コールバックが
    // 未配線だと port が握られたままで listen が EADDRINUSE で throw する。
    const probe = http.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(boundPort, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });
});
