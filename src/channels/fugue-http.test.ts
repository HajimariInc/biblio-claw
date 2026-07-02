/**
 * Fugue HTTP server unit tests (M4-E Phase 1)。
 *
 * ephemeral port (`port: 0`) を bind して実 HTTP request を fetch で叩き、
 * lifecycle + auth 4 分岐 + path 3 分岐 + Zod validation + body edge cases +
 * security invariant (auth-before-routing) の合計 12 ケースを検証する。
 * `port: 0` を bind すると Node が空き port を自動で割り当てる = test 間の衝突なし。
 */
import http from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListBiblioResult } from '../biblio/types.js';

import { FugueHttpServer } from './fugue-http.js';

const TOKEN = 'test-token-abcdef0123456789abcdef0123456789abcdef01';

// Phase 2 consult 実装は `listBiblio` を in-process で呼ぶ。実 marketplace 到達は
// CI 環境で rate limit / flaky の原因になる (SHELF_REPO_OWNER / SHELF_REPO_NAME 未設定
// で 503 になるケースも含む) ため、`vi.mock` で fixture 化する。実 API 疎通は
// Task 6 手動 E2E (Fake Fugue Client + pnpm run dev) で確認する mixed strategy。
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

// Phase 2 test の fixture — 実 marketplace 相当の 3 items (biblio-dev x 2, biblio-art x 1)。
const FIXTURE_RESULT: ListBiblioResult = {
  ok: true,
  items: [
    {
      name: 'HajimariInc--figma-reviewer',
      category: 'biblio-art',
      description: 'Figma design review skill for AI agents.',
      version: '1.2.0',
    },
    {
      name: 'HajimariInc--code-formatter',
      category: 'biblio-dev',
      description: 'Auto-format TypeScript files with prettier.',
      version: '0.5.1',
    },
    {
      name: 'HajimariInc--test-runner',
      category: 'biblio-dev',
      description: 'Run vitest and report failures.',
      version: '2.0.0',
    },
  ],
  counts: {
    'biblio-dev': 2,
    'biblio-art': 1,
    'biblio-bf': 0,
    'biblio-ai': 0,
    unknown: 0,
  },
  total: 3,
  appliedFilter: null,
};

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

  // NOTE (Phase 2): 旧 Phase 1 の "consult skeleton stub 200 応答" テストは Phase 2 で
  // consult schema が full spec (`query` / `mode` 必須) に置き換わったため削除。
  // Phase 2 の consult 応答は下段 `describe('handleConsult (Phase 2 implementation)', ...)`
  // で fixture を注入した 8 case が担保する。equip 側 skeleton stub は Phase 3 まで温存。

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

describe('handleConsult (Phase 2 implementation)', () => {
  let server: FugueHttpServer;
  let port: number;

  beforeEach(async () => {
    server = new FugueHttpServer({ port: 0, host: '127.0.0.1', expectedToken: TOKEN });
    const started = await server.start();
    port = started.port;
    // 各 test で default fixture を注入 (mockResolvedValueOnce は 1 呼び出しだけ有効)。
    const { listBiblio } = await import('../biblio/list-biblio.js');
    vi.mocked(listBiblio).mockResolvedValue(FIXTURE_RESULT);
  });

  afterEach(async () => {
    await server.stop();
    vi.clearAllMocks();
  });

  it('200 with skills_found + summary when query matches shelf items (status: ok)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-consult-hit',
        query: 'Figma',
        mode: 'review-with-ad',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      operation: string;
      status: string;
      summary: string;
      skills_found: unknown[];
      raw: Record<string, unknown>;
      processing_time_ms: number;
      warnings: unknown[];
      request_id: string;
      schema_version: string;
    };
    expect(body.operation).toBe('consult');
    expect(body.status).toBe('ok');
    expect(body.request_id).toBe('req-consult-hit');
    expect(body.schema_version).toBe('1');
    expect(body.summary.length).toBeGreaterThan(0);
    expect(body.summary.length).toBeLessThanOrEqual(500);
    // "Figma" は fixture の biblio-art item の description に含まれるためヒット。
    expect(body.skills_found.length).toBeGreaterThan(0);
    expect(body.warnings).toEqual([]);
    expect(body.processing_time_ms).toBeGreaterThanOrEqual(0);
    // raw に listBiblio 概要 + query + mode が echo される (判断 G)。
    expect(body.raw).toMatchObject({
      query: 'Figma',
      mode: 'review-with-ad',
      listBiblio: { total: 3 },
    });
  });

  it('200 with status: not_found + summary "該当なし" when no items match', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-consult-miss',
        query: 'nonexistent-xyz-guaranteed-no-match',
        mode: 'ask-ad',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      summary: string;
      skills_found: unknown[];
    };
    expect(body.status).toBe('not_found');
    expect(body.skills_found).toEqual([]);
    expect(body.summary).toContain('該当なし');
  });

  it('SkillRef shape: id / name / description / manifest_url / equipped=false', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-shape',
        query: 'formatter',
        mode: 'ask-ad',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills_found: unknown[] };
    expect(body.skills_found.length).toBeGreaterThan(0);
    const first = body.skills_found[0] as {
      id: string;
      name: string;
      description: string;
      manifest_url: string;
      equipped: boolean;
    };
    expect(typeof first.id).toBe('string');
    expect(typeof first.name).toBe('string');
    expect(typeof first.description).toBe('string');
    // Phase 2 判断 B: equipped は常に false (Fugue に session 概念なし)。
    expect(first.equipped).toBe(false);
    // manifest_url は棚 GitHub tree URL に組み立て済 (readListEnv() の mock 値を経由)。
    expect(first.manifest_url).toMatch(
      /^https:\/\/github\.com\/MockOwner\/mock-shelf\/tree\/main\/biblio-(dev|art|bf|ai)\//,
    );
  });

  it('400 on invalid mode literal', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-badmode',
        query: 'test',
        mode: 'invalid-mode',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues?: unknown[] };
    expect(body.error).toBe('invalid_input');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues!.length).toBeGreaterThan(0);
  });

  it('400 on query exceeding max_length (501 chars)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-longquery',
        query: 'a'.repeat(501),
        mode: 'ask-ad',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues?: unknown[] };
    expect(body.error).toBe('invalid_input');
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('200 accepts context_hint (nested dict) without affecting search results', async () => {
    // Phase 2 判断 E: context_hint は受理のみで検索ロジック非反映。
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-ctx',
        query: 'formatter',
        mode: 'coaching-with-ad',
        context_hint: { screen_summary: 'foo', nested: { baz: 1 } },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; skills_found: unknown[] };
    // formatter に一致する item は fixture に存在するため ok。context_hint は無視。
    expect(body.status).toBe('ok');
    expect(body.skills_found.length).toBeGreaterThan(0);
  });

  it('503 with reason=env_missing when listBiblio throws env-missing error', async () => {
    const { listBiblio } = await import('../biblio/list-biblio.js');
    vi.mocked(listBiblio).mockRejectedValueOnce(
      new Error('list: required env missing: SHELF_REPO_OWNER, SHELF_REPO_NAME'),
    );
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-env-missing',
        query: 'anything',
        mode: 'ask-ad',
      }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe('unavailable');
    expect(body.reason).toBe('env_missing');
  });

  it('503 with reason=github_http when listBiblio throws GhHttpError', async () => {
    const { listBiblio } = await import('../biblio/list-biblio.js');
    const ghErr = new Error('GET contents/marketplace.json → 503 Service Unavailable');
    ghErr.name = 'GhHttpError';
    vi.mocked(listBiblio).mockRejectedValueOnce(ghErr);
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-gh-err',
        query: 'anything',
        mode: 'ask-ad',
      }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe('unavailable');
    expect(body.reason).toBe('github_http');
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
