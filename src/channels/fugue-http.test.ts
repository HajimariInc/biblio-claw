/**
 * Fugue HTTP server unit tests。
 *
 * ephemeral port (`port: 0`) を bind して実 HTTP request を fetch で叩く構成。
 * `port: 0` を bind すると Node が空き port を自動で割り当てる = test 間の衝突なし。
 *
 * 検証カテゴリ (件数は増減する = 列挙をやめて陳腐化を構造的に回避、実件数は
 * `pnpm test src/channels/fugue-http.test.ts` の Tests 出力を正本とする):
 *
 *   - 骨格: lifecycle (start/stop 冪等) + Bearer auth 3 分岐 (no_header /
 *     bad_scheme / bad_token) + 404 unknown path + Zod validation 400 + body edge cases
 *     (JSON parse 失敗 / body too large) + security invariant (auth-before-routing = 未認証
 *     クライアントに path 存在漏洩しない不変条件)
 *   - consult full spec: query match 200 / not_found 200 / SkillRef shape /
 *     mode (4 enum) / query 境界 (max 500 char) / context_hint (optional + nullable、PII 非ログ) /
 *     部分失敗 4 分類 (env_missing / github_http / marketplace_parse / other) / top 10 truncate
 *     warning / unknown category 除外 warning
 *   - equip full spec: 4 status 応答 (equipped / already_equipped / not_found / error) /
 *     BIBLIO_NAME_RE guard / HITL defensive path / 部分失敗 (listBiblio throw / DB write throw) /
 *     consult 側 equipped flag 継承
 *   - health check: `/healthz` の 3 case (auth check の前で 200 "ok" / malformed
 *     Authorization で 200 = auth bypass 証拠 / POST /healthz で 200 = method 非依存)
 */
import http from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from '../log.js';
import type { BiblioCategory, ListBiblioResult } from '../biblio/types.js';

import { FugueHttpServer } from './fugue-http.js';

const TOKEN = 'test-token-abcdef0123456789abcdef0123456789abcdef01';

// consult 実装は `listBiblio` を in-process で呼ぶ。実 marketplace 到達は
// CI 環境で rate limit / flaky の原因になる (SHELF_REPO_OWNER / SHELF_REPO_NAME 未設定
// で partial_failure になるケースも含む) ため、`vi.mock` で fixture 化する。実 API 疎通は
// 手動 E2E (Fake Fugue Client + pnpm run dev) で確認する mixed strategy。
vi.mock('../biblio/list-biblio.js', () => ({
  listBiblio: vi.fn(),
}));

vi.mock('../biblio/shelf-gh.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../biblio/shelf-gh.js')>();
  return {
    ...original,
    // GhHttpError / MarketplaceParseError は original の実 class を露出させる (partial mock)。
    // classifyListBiblioError の `instanceof` 判定が実 class を必要とするため。
    readListEnv: vi.fn(() => ({ shelfOwner: 'MockOwner', shelfRepo: 'mock-shelf' })),
  };
});

// fugue_equipped_biblios の DB 実体を mock 化。channel test は DB 疎通を触らない
// (DB 実体は fugue-equipped-biblios.test.ts で担保、layering の判断)。
// default は [] / true を返し、既存 test case (lifecycle / auth / 404 / port + consult 実装 +
// port release probe を含む合計 24 case) が壊れない。
vi.mock('../db/fugue-equipped-biblios.js', () => ({
  insertFugueEquippedBiblio: vi.fn(() => true),
  getFugueEquippedBiblioNames: vi.fn(() => []),
  deleteFugueEquippedBiblioByName: vi.fn(() => 0),
}));

// HITL regression 用: Slack HITL 経路の requestApproval が Fugue equip から呼ばれない
// ことを spy で固定する。fugue-http.ts が import していないので default で never called、
// リファクタで誤って呼び込んだら test が fail する保険。
vi.mock('../modules/approvals/primitive.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../modules/approvals/primitive.js')>();
  return {
    ...original,
    requestApproval: vi.fn(),
  };
});

// HITL defensive guard 用: requiresApproval の実装 (Fugue 契約 §6.2) を保ちつつ、
// test でだけ mockReturnValueOnce(true) で defensive branch を発火させ、handleEquip が
// 200 + status:'error' + skill:null + warnings に HITL required 文言で閉じる挙動を検証する。
// default では現行 matrix 通り false を返し、既存の 12 equip case は無変更で PASS する。
vi.mock('../biblio/hitl-policy.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../biblio/hitl-policy.js')>();
  return {
    ...original,
    requiresApproval: vi.fn(original.requiresApproval),
  };
});

// 基本 fixture — 3 items (biblio-art x 1, biblio-dev x 2)。既存の hit/miss テスト用。
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

/** 12 件が同一キーワード 'match-me' に一致する fixture (top10 truncate exercise 用)。 */
function buildLargeFixture(count = 12): ListBiblioResult {
  const CATS: BiblioCategory[] = ['biblio-dev', 'biblio-art', 'biblio-bf', 'biblio-ai'];
  const items = Array.from({ length: count }, (_, i) => ({
    name: `HajimariInc--match-item-${String(i).padStart(2, '0')}`,
    category: CATS[i % 4],
    description: `match-me shared keyword item ${i}.`,
    version: '1.0.0',
  }));
  const counts = {
    'biblio-dev': items.filter((i) => i.category === 'biblio-dev').length,
    'biblio-art': items.filter((i) => i.category === 'biblio-art').length,
    'biblio-bf': items.filter((i) => i.category === 'biblio-bf').length,
    'biblio-ai': items.filter((i) => i.category === 'biblio-ai').length,
    unknown: 0,
  };
  return { ok: true, items, counts, total: count, appliedFilter: null };
}

/** unknown category 混入 fixture (`i.category === 'unknown'` 除外テスト用)。 */
function buildFixtureWithUnknown(): ListBiblioResult {
  return {
    ok: true,
    items: [
      {
        name: 'HajimariInc--ok-one',
        category: 'biblio-dev',
        description: 'match-me ok item 1.',
        version: '1.0.0',
      },
      {
        name: 'HajimariInc--ok-two',
        category: 'biblio-art',
        description: 'match-me ok item 2.',
        version: '1.0.0',
      },
      {
        // `unknown` は BiblioCategory の union 外だが list-biblio.ts の source パース失敗
        // で発生する実体。type assert で fixture に混ぜる。
        name: 'HajimariInc--broken',
        category: 'unknown' as BiblioCategory,
        description: 'match-me broken item.',
        version: '1.0.0',
      },
    ],
    counts: {
      'biblio-dev': 1,
      'biblio-art': 1,
      'biblio-bf': 0,
      'biblio-ai': 0,
      unknown: 1,
    },
    total: 3,
    appliedFilter: null,
  };
}

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

  it('401 without exposing reason when Authorization header is missing', async () => {
    // reason はサーバログ限定、client 応答は `{error: 'unauthorized'}` のみ。
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

  it('401 without exposing reason when Authorization is not Bearer', async () => {
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

  it('401 without exposing reason when Bearer token does not match', async () => {
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
  // consult schema が full spec (`query` / `mode` 必須) に置き換わったため削除済。
  // Phase 2 の consult 応答は下段 `describe('handleConsult (Phase 2 implementation)', ...)`
  // で fixture を注入した 13 case が担保する。equip 側 skeleton stub は Phase 3 まで温存。

  // NOTE (Phase 3): 旧 Phase 1 skeleton 応答テスト (schema_version + request_id の 2 field 受理 →
  // {status:'ok', stub:true}) は Phase 3 で equip full spec 化により削除済。Phase 3 の equip 応答は
  // 下段 `describe('handleEquip (Phase 3 implementation)', ...)` で fixture を注入した 12+ case が
  // 担保する (skill_id / channel 必須、4 status 応答、HITL regression 含む)。

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

  it('400 with detail=body is not valid JSON when body is malformed', async () => {
    // 非 JSON body → 400 分岐は Zod validation 失敗とは異なる response shape
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

  it('401 (not 404) on unknown path when Authorization is missing — auth is checked before routing', async () => {
    // 「未認証クライアントに有効な path の存在を漏らさない」security invariant を固定化。
    // リファクタで auth check と path routing の順序が入れ替わると path enumeration の
    // 隙が生まれる。
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema_version: '1', request_id: 'req-auth-before-route' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'unauthorized' });
  });

  // Phase 5: /healthz は auth check の前で 200 "ok" を返す。LB health check が Bearer を
  // 持たないため 401 で backend unhealthy になるのを防ぐ + method 分岐なし = HEAD probe も allow。
  it('200 "ok" on GET /healthz without Authorization (LB health check path)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('ok');
  });

  it('200 "ok" on /healthz with malformed Authorization (auth check bypassed)', async () => {
    // auth check の前で return する不変条件を固定化。malformed Authorization を投げても
    // 401 に落ちず 200 が返るなら「healthz は auth の前」が守られている証拠。
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { Authorization: 'not-a-bearer-scheme' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('200 "ok" on POST /healthz (method-agnostic, LB may HEAD probe)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
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
    vi.restoreAllMocks();
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
    // raw に listBiblio 概要 + query + mode が echo される。
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

  it('SkillRef shape: id / name / description / manifest_url / equipped (default mock で false)', async () => {
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
    // equipped は Phase 3 で `boolean` (fugue_equipped_biblios membership に基づく)。
    // 本 test suite の default mock は `getFugueEquippedBiblioNames → []` (装備ゼロ) のため
    // ここでは false を観測する。実データ true/false 両観測は
    // `describe('handleConsult equipped flag (Phase 3)')` の membership test でカバー。
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
    // context_hint は受理のみで検索ロジック非反映。
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

  it('does NOT log context_hint values (PII protection) — only key names appear in log', async () => {
    // PII 保護: log 出力に context_hint の値が漏れないことを固定化する。
    // key 名 (`screen_summary` / `secret_note`) はログに残っても構わない (キー名の集合は
    // Fugue Director 側で公開済メタ情報、pii ではない前提)。値は emit しない。
    const logInfoSpy = vi.spyOn(log, 'info');
    const PII_VALUE = 'SUPER-SECRET-VALUE-42-do-not-log';
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-pii',
        query: 'formatter',
        mode: 'ask-ad',
        context_hint: { screen_summary: PII_VALUE, secret_note: PII_VALUE },
      }),
    });
    expect(res.status).toBe(200);
    // 全ての log.info call の payload を stringify して PII 値が含まれないか確認
    const allPayloads = logInfoSpy.mock.calls
      .map(([, payload]) => (payload === undefined ? '' : JSON.stringify(payload)))
      .join('\n');
    expect(allPayloads).not.toContain(PII_VALUE);
    // key 名は log に載っている必要 (`context_hint_keys: ['screen_summary', 'secret_note']`)
    expect(allPayloads).toContain('screen_summary');
    expect(allPayloads).toContain('secret_note');
  });

  it('200 truncates skills_found to top 10 when matches exceed limit + emits warning', async () => {
    // fixture 12 件全てが 'match-me' キーワード一致 → top 10 で truncate → warnings に反映。
    const { listBiblio } = await import('../biblio/list-biblio.js');
    vi.mocked(listBiblio).mockResolvedValueOnce(buildLargeFixture(12));

    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-truncate',
        query: 'match-me',
        mode: 'ask-ad',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      skills_found: unknown[];
      warnings: string[];
    };
    expect(body.status).toBe('ok');
    expect(body.skills_found.length).toBe(10);
    expect(body.warnings).toContain('truncated skills_found to top 10 of 12 matches');
  });

  it('200 omits unknown-category items + emits warning (skills_found stays valid GitHub URLs)', async () => {
    const { listBiblio } = await import('../biblio/list-biblio.js');
    vi.mocked(listBiblio).mockResolvedValueOnce(buildFixtureWithUnknown());

    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-unknown',
        query: 'match-me',
        mode: 'ask-ad',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      skills_found: { name: string; manifest_url: string }[];
      warnings: string[];
    };
    expect(body.status).toBe('ok');
    // 3 件のうち 2 件だけ (unknown が除外)
    expect(body.skills_found.length).toBe(2);
    const names = body.skills_found.map((s) => s.name);
    expect(names).not.toContain('HajimariInc--broken');
    // 除外した item は warnings に反映
    expect(body.warnings).toContain('omitted 1 item(s) with unknown category from skills_found');
    // 残った manifest_url は valid GitHub path
    for (const s of body.skills_found) {
      expect(s.manifest_url).toMatch(/\/tree\/main\/biblio-(dev|art|bf|ai)\//);
      expect(s.manifest_url).not.toContain('/tree/main/unknown/');
    }
  });

  it('200 status:error + reason=env_missing when listBiblio throws env-missing error (partial-failure, 5xx not raised)', async () => {
    // C1: PRD「AD の本義」= listBiblio 失敗は 200 + status:'error' + warnings で運ぶ。
    // 5xx は認可 / 上限超過 / biblio-claw 自体の応答不能に限定する契約。
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      skills_found: unknown[];
      warnings: string[];
      summary: string;
      raw: Record<string, unknown>;
    };
    expect(body.status).toBe('error');
    expect(body.skills_found).toEqual([]);
    expect(body.warnings).toContain('consult failed: env_missing');
    expect(body.summary).toContain('env_missing');
    expect(body.raw).toMatchObject({ reason: 'env_missing', query: 'anything', mode: 'ask-ad' });
  });

  it('200 status:error + reason=github_http when listBiblio throws GhHttpError (instanceof)', async () => {
    const { listBiblio } = await import('../biblio/list-biblio.js');
    const { GhHttpError } = await import('../biblio/shelf-gh.js');
    vi.mocked(listBiblio).mockRejectedValueOnce(
      new GhHttpError('GET contents/marketplace.json', 503, 'Service Unavailable'),
    );
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; warnings: string[]; raw: Record<string, unknown> };
    expect(body.status).toBe('error');
    expect(body.warnings).toContain('consult failed: github_http');
    expect(body.raw).toMatchObject({ reason: 'github_http' });
  });

  it('200 status:error + reason=marketplace_parse when listBiblio throws MarketplaceParseError (order-dependent instanceof)', async () => {
    // MarketplaceParseError extends GhHttpError の継承関係のため、
    // classifyListBiblioError は `instanceof MarketplaceParseError` を先に判定する必要が
    // ある。この test はその順序 (marketplace_parse を最初) を固定化する。
    const { listBiblio } = await import('../biblio/list-biblio.js');
    const { MarketplaceParseError } = await import('../biblio/shelf-gh.js');
    vi.mocked(listBiblio).mockRejectedValueOnce(
      new MarketplaceParseError('GET contents/marketplace.json', 'response missing content'),
    );
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-mp-err',
        query: 'anything',
        mode: 'ask-ad',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; warnings: string[]; raw: Record<string, unknown> };
    expect(body.status).toBe('error');
    expect(body.warnings).toContain('consult failed: marketplace_parse');
    expect(body.raw).toMatchObject({ reason: 'marketplace_parse' });
  });

  it('200 status:error + reason=other when listBiblio throws unclassified error', async () => {
    // 未分類の Error / 非 Error 値は 'other' fallback。分類漏れが silent に github_http 等
    // に化けないよう固定化する。
    const { listBiblio } = await import('../biblio/list-biblio.js');
    vi.mocked(listBiblio).mockRejectedValueOnce(new TypeError('unexpected input shape'));
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-other-err',
        query: 'anything',
        mode: 'ask-ad',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; warnings: string[]; raw: Record<string, unknown> };
    expect(body.status).toBe('error');
    expect(body.warnings).toContain('consult failed: other');
    expect(body.raw).toMatchObject({ reason: 'other' });
  });
});

describe('handleEquip (Phase 3 implementation)', () => {
  let server: FugueHttpServer;
  let port: number;

  beforeEach(async () => {
    server = new FugueHttpServer({ port: 0, host: '127.0.0.1', expectedToken: TOKEN });
    const started = await server.start();
    port = started.port;
    // 各 test で default fixture を注入。棚に skill_id で完全一致する item を用意。
    const { listBiblio } = await import('../biblio/list-biblio.js');
    vi.mocked(listBiblio).mockResolvedValue(FIXTURE_RESULT);
    // DB mock の default を復元 (別 test で override された前提のクリア)
    const { insertFugueEquippedBiblio, getFugueEquippedBiblioNames } = await import('../db/fugue-equipped-biblios.js');
    vi.mocked(insertFugueEquippedBiblio).mockReturnValue(true);
    vi.mocked(getFugueEquippedBiblioNames).mockReturnValue([]);
  });

  afterEach(async () => {
    await server.stop();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  async function postEquip(body: unknown, opts?: { badToken?: boolean }): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/v1/channels/fugue/equip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: opts?.badToken ? 'Bearer wrong-token' : `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(body),
    });
  }

  it('200 status:equipped + skill.equipped=true + processing_time_ms>=0 + operation:equip (正常経路)', async () => {
    const res = await postEquip({
      schema_version: '1',
      request_id: 'req-eq-ok',
      skill_id: 'HajimariInc--figma-reviewer',
      channel: 'fugue',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      operation: string;
      status: string;
      skill: { id: string; name: string; equipped: boolean; manifest_url: string } | null;
      summary: string;
      processing_time_ms: number;
      warnings: unknown[];
      request_id: string;
      schema_version: string;
    };
    expect(body.operation).toBe('equip');
    expect(body.status).toBe('equipped');
    expect(body.request_id).toBe('req-eq-ok');
    expect(body.schema_version).toBe('1');
    expect(body.skill).not.toBeNull();
    expect(body.skill!.id).toBe('HajimariInc--figma-reviewer');
    expect(body.skill!.equipped).toBe(true);
    expect(body.skill!.manifest_url).toMatch(
      /^https:\/\/github\.com\/MockOwner\/mock-shelf\/tree\/main\/biblio-art\/HajimariInc--figma-reviewer$/,
    );
    expect(body.processing_time_ms).toBeGreaterThanOrEqual(0);
    expect(body.warnings).toEqual([]);
    expect(body.summary).toContain('装備しました');
  });

  it('200 status:already_equipped + skill.equipped=true when insertFugueEquippedBiblio returns false', async () => {
    const { insertFugueEquippedBiblio } = await import('../db/fugue-equipped-biblios.js');
    vi.mocked(insertFugueEquippedBiblio).mockReturnValueOnce(false);
    const res = await postEquip({
      schema_version: '1',
      request_id: 'req-eq-dup',
      skill_id: 'HajimariInc--figma-reviewer',
      channel: 'fugue',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; skill: { equipped: boolean } | null; summary: string };
    expect(body.status).toBe('already_equipped');
    expect(body.skill).not.toBeNull();
    expect(body.skill!.equipped).toBe(true);
    expect(body.summary).toContain('既に装備済み');
  });

  it('200 status:not_found + skill=null when skill_id not present in shelf', async () => {
    const res = await postEquip({
      schema_version: '1',
      request_id: 'req-eq-miss',
      skill_id: 'nonexist--nope',
      channel: 'fugue',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; skill: unknown; summary: string; warnings: unknown[] };
    expect(body.status).toBe('not_found');
    expect(body.skill).toBeNull();
    expect(body.summary).toContain('棚に見つかりません');
    expect(body.warnings).toEqual([]);
  });

  it('200 status:not_found when target item has category=unknown (consult 除外と整合)', async () => {
    // fixture に 'unknown' item を注入 → 対応 skill_id を equip すると not_found
    const { listBiblio } = await import('../biblio/list-biblio.js');
    vi.mocked(listBiblio).mockResolvedValueOnce(buildFixtureWithUnknown());
    const res = await postEquip({
      schema_version: '1',
      request_id: 'req-eq-unk',
      skill_id: 'HajimariInc--broken',
      channel: 'fugue',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; skill: unknown };
    expect(body.status).toBe('not_found');
    expect(body.skill).toBeNull();
  });

  // consult 側は L272-304 で 413 / 400 分岐がテスト済だったが、equip 側は同型実装
  // (元は複製、`parseFugueRequest` ヘルパ化後は共通経路) にもかかわらず分岐発火が未検証だった。
  // `parseFugueRequest` 経由でも event 名 (`fugue.equip.body_too_large` /
  // `fugue.equip.body_read_failed`) と応答 body は operation 依存で構築されるため、equip 経路を
  // 独立 test で固定化する = ヘルパの operation 引数書換 regression を検知する。
  it('413 payload_too_large when equip body exceeds MAX_BODY_SIZE_BYTES', async () => {
    // 2 MiB の巨大 skill_id で MAX_BODY_SIZE_BYTES (1 MiB) を超過させる (BIBLIO_NAME_RE 到達前に
    // body read で BodyTooLargeError → 413)。consult 側 `400 with detail=body is not valid JSON`
    // (L288) と対称。
    const bigBody = JSON.stringify({
      schema_version: '1',
      request_id: 'req-eq-toolarge',
      skill_id: 'x'.repeat(2 * 1024 * 1024),
      channel: 'fugue',
    });
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/equip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: bigBody,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('payload_too_large');
  });

  it('400 with detail=body is not valid JSON when equip body is malformed', async () => {
    // 非 JSON body → 400 分岐は Zod validation 失敗とは異なる response shape (`detail` を返し
    // `issues` を返さない)。consult 側 L288-304 と対称。
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/equip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: '{not valid json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail?: string; issues?: unknown };
    expect(body.error).toBe('invalid_input');
    expect(body.detail).toBe('body is not valid JSON');
    expect(body.issues).toBeUndefined();
  });

  it('400 invalid_input when skill_id is missing (Zod issues)', async () => {
    const res = await postEquip({
      schema_version: '1',
      request_id: 'req-eq-missing-skill',
      channel: 'fugue',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues?: unknown[] };
    expect(body.error).toBe('invalid_input');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues!.length).toBeGreaterThan(0);
  });

  it('400 invalid_input when skill_id exceeds 200 chars', async () => {
    const res = await postEquip({
      schema_version: '1',
      request_id: 'req-eq-long',
      skill_id: 'a'.repeat(201),
      channel: 'fugue',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues?: unknown[] };
    expect(body.error).toBe('invalid_input');
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('400 invalid_input when channel is "slack" (literal violation)', async () => {
    const res = await postEquip({
      schema_version: '1',
      request_id: 'req-eq-slack',
      skill_id: 'HajimariInc--figma-reviewer',
      channel: 'slack',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues?: unknown[] };
    expect(body.error).toBe('invalid_input');
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('400 invalid_input + detail when skill_id violates BIBLIO_NAME_RE (path traversal defense)', async () => {
    const res = await postEquip({
      schema_version: '1',
      request_id: 'req-eq-traversal',
      skill_id: '../etc/passwd',
      channel: 'fugue',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail?: string };
    expect(body.error).toBe('invalid_input');
    expect(body.detail).toContain('skill_id');
    expect(body.detail).toContain('owner');
  });

  it('200 status:error + warnings reason=env_missing when listBiblio throws env-missing error (partial failure)', async () => {
    const { listBiblio } = await import('../biblio/list-biblio.js');
    vi.mocked(listBiblio).mockRejectedValueOnce(
      new Error('list: required env missing: SHELF_REPO_OWNER, SHELF_REPO_NAME'),
    );
    const res = await postEquip({
      schema_version: '1',
      request_id: 'req-eq-env',
      skill_id: 'HajimariInc--figma-reviewer',
      channel: 'fugue',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; skill: unknown; warnings: string[]; summary: string };
    expect(body.status).toBe('error');
    expect(body.skill).toBeNull();
    expect(body.warnings).toContain('equip failed: env_missing');
    expect(body.summary).toContain('env_missing');
  });

  it('200 status:error + warnings reason=github_http when listBiblio throws GhHttpError (instanceof)', async () => {
    const { listBiblio } = await import('../biblio/list-biblio.js');
    const { GhHttpError } = await import('../biblio/shelf-gh.js');
    vi.mocked(listBiblio).mockRejectedValueOnce(
      new GhHttpError('GET contents/marketplace.json', 503, 'Service Unavailable'),
    );
    const res = await postEquip({
      schema_version: '1',
      request_id: 'req-eq-gh',
      skill_id: 'HajimariInc--figma-reviewer',
      channel: 'fugue',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; warnings: string[] };
    expect(body.status).toBe('error');
    expect(body.warnings).toContain('equip failed: github_http');
  });

  it('200 status:error + warnings "equip state write failed" when insertFugueEquippedBiblio throws (DB write failure)', async () => {
    const { insertFugueEquippedBiblio } = await import('../db/fugue-equipped-biblios.js');
    vi.mocked(insertFugueEquippedBiblio).mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    const res = await postEquip({
      schema_version: '1',
      request_id: 'req-eq-dbfail',
      skill_id: 'HajimariInc--figma-reviewer',
      channel: 'fugue',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; skill: unknown; warnings: string[] };
    expect(body.status).toBe('error');
    expect(body.skill).toBeNull();
    expect(body.warnings.some((w) => w.startsWith('equip state write failed'))).toBe(true);
    expect(body.warnings.some((w) => w.includes('SQLITE_BUSY'))).toBe(true);
  });

  it('HITL regression: Fugue equip returns sync 200 without invoking Slack requestApproval', async () => {
    // Fugue equip = HITL 簡略化 → Slack primitive.requestApproval が
    // never called。fugue-http.ts が import しないので default で 0 回、リファクタで呼び込んだら fail する。
    const { requestApproval } = await import('../modules/approvals/primitive.js');
    const res = await postEquip({
      schema_version: '1',
      request_id: 'req-eq-hitl',
      skill_id: 'HajimariInc--figma-reviewer',
      channel: 'fugue',
    });
    expect(res.status).toBe(200); // sync 応答 (pause なし)
    expect(vi.mocked(requestApproval)).not.toHaveBeenCalled();
  });

  it('HITL defensive guard: requiresApproval が true を返すと 200 + status:error + skill:null + HITL required warning で閉じる', async () => {
    // 現行 matrix では `requiresApproval('equip','fugue') === false` のため到達しない defensive
    // 経路。将来 matrix が変わったときに Fugue equip が silent に HITL bypass しないよう
    // 明示的に閉じているコード (fugue-http.ts:663) をリグレッションから守るため、mock で true
    // にして応答形状を assert する。
    const { requiresApproval } = await import('../biblio/hitl-policy.js');
    vi.mocked(requiresApproval).mockReturnValueOnce(true);
    // listBiblio / DB は本経路に到達しない (guard で早期 return) が、default mock は temp 有効。
    const res = await postEquip({
      schema_version: '1',
      request_id: 'req-eq-hitl-guard',
      skill_id: 'HajimariInc--figma-reviewer',
      channel: 'fugue',
    });
    expect(res.status).toBe(200); // sync 200 (5xx にはしない = AD の本義)
    const body = (await res.json()) as {
      operation: string;
      status: string;
      skill: unknown;
      summary: string;
      warnings: string[];
      processing_time_ms: number;
    };
    expect(body.operation).toBe('equip');
    expect(body.status).toBe('error');
    expect(body.skill).toBeNull();
    expect(body.warnings).toContain('HITL approval required: please approve via Slack channel');
    expect(body.summary).toContain('承認');
    expect(body.processing_time_ms).toBeGreaterThanOrEqual(0);
    // Slack HITL 経路 (`primitive.requestApproval`) は Fugue defensive branch でも呼ばない
    // (bridge が Fugue channel に wire されていないため、log warn + fail-closed で返す設計)。
    const { requestApproval } = await import('../modules/approvals/primitive.js');
    expect(vi.mocked(requestApproval)).not.toHaveBeenCalled();
  });

  it('401 with valid POST body + bad Bearer even on /equip (auth-before-routing invariant)', async () => {
    const res = await postEquip(
      {
        schema_version: '1',
        request_id: 'req-eq-badauth',
        skill_id: 'HajimariInc--figma-reviewer',
        channel: 'fugue',
      },
      { badToken: true },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'unauthorized' });
  });
});

describe('handleConsult equipped flag (Phase 3)', () => {
  let server: FugueHttpServer;
  let port: number;

  beforeEach(async () => {
    server = new FugueHttpServer({ port: 0, host: '127.0.0.1', expectedToken: TOKEN });
    const started = await server.start();
    port = started.port;
    const { listBiblio } = await import('../biblio/list-biblio.js');
    vi.mocked(listBiblio).mockResolvedValue(FIXTURE_RESULT);
    const { getFugueEquippedBiblioNames } = await import('../db/fugue-equipped-biblios.js');
    vi.mocked(getFugueEquippedBiblioNames).mockReturnValue([]);
  });

  afterEach(async () => {
    await server.stop();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('SkillRef.equipped は fugue_equipped_biblios の membership に基づく (true / false 両方を観測)', async () => {
    const { getFugueEquippedBiblioNames } = await import('../db/fugue-equipped-biblios.js');
    // fixture の 3 件のうち 'HajimariInc--figma-reviewer' だけ装備中と mock
    vi.mocked(getFugueEquippedBiblioNames).mockReturnValueOnce(['HajimariInc--figma-reviewer']);
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-eq-mem',
        // query='e' は fixture 3 件全ての name / description の substring 一致にヒットする
        // (`HajimariInc--figma-reviewer` の 'review' 等)。3 件全観測で装備 1 件 + 未装備 2 件の
        // equipped: true/false 混在を 1 request で検証するため、包括ヒットを狙って 'e' を選ぶ。
        query: 'e',
        mode: 'ask-ad',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills_found: { name: string; equipped: boolean }[] };
    expect(body.skills_found.length).toBeGreaterThan(0);
    const equippedItem = body.skills_found.find((s) => s.name === 'HajimariInc--figma-reviewer');
    expect(equippedItem).toBeDefined();
    expect(equippedItem!.equipped).toBe(true);
    const nonEquipped = body.skills_found.find((s) => s.name !== 'HajimariInc--figma-reviewer');
    expect(nonEquipped).toBeDefined();
    expect(nonEquipped!.equipped).toBe(false);
  });

  it('getFugueEquippedBiblioNames throw → consult は 200 のまま + warnings に equipped state unavailable', async () => {
    const { getFugueEquippedBiblioNames } = await import('../db/fugue-equipped-biblios.js');
    vi.mocked(getFugueEquippedBiblioNames).mockImplementationOnce(() => {
      throw new Error('SQLITE_LOCKED: locked');
    });
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/fugue/consult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        schema_version: '1',
        request_id: 'req-eq-dbfail',
        query: 'formatter',
        mode: 'ask-ad',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      skills_found: { equipped: boolean }[];
      warnings: string[];
    };
    // 検索は成功 (formatter → 1 件)、equipped state だけが unavailable
    expect(body.status).toBe('ok');
    expect(body.skills_found.length).toBeGreaterThan(0);
    // すべての skill が equipped=false に fallback
    for (const s of body.skills_found) {
      expect(s.equipped).toBe(false);
    }
    expect(body.warnings.some((w) => w.startsWith('equipped state unavailable'))).toBe(true);
    expect(body.warnings.some((w) => w.includes('SQLITE_LOCKED'))).toBe(true);
  });
});

describe('FugueHttpServer stop() OS port release (Level 4 手動 E2E の automated 補完)', () => {
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
