/**
 * Fugue HTTP server unit tests (M4-E Phase 1)。
 *
 * ephemeral port (`port: 0`) を bind して実 HTTP request を fetch で叩き、
 * lifecycle + auth 4 分岐 + path 3 分岐 + Zod validation の合計 9 ケースを検証する。
 * `port: 0` を bind すると Node が空き port を自動で割り当てる = test 間の衝突なし。
 */
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

  it('401 when Authorization header is missing', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema_version: '1', request_id: 'req-nohdr' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'unauthorized', reason: 'no_header' });
  });

  it('401 with reason=bad_scheme when Authorization is not Bearer', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic dXNlcjpwYXNz',
      },
      body: JSON.stringify({ schema_version: '1', request_id: 'req-scheme' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'unauthorized', reason: 'bad_scheme' });
  });

  it('401 with reason=bad_token when Bearer token does not match', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token-that-differs-in-value-and-length',
      },
      body: JSON.stringify({ schema_version: '1', request_id: 'req-badtok' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'unauthorized', reason: 'bad_token' });
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
});
