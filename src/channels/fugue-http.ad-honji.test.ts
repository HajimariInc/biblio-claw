/**
 * Fugue HTTP server "AD の本義" 契約 assertion (M4-E Phase 4)。
 *
 * PRD `m4-e-fugue-integration.prd.md` §「AD の本義」で定義された 2 契約を機械化する:
 *
 *   契約 1: 5xx 応答は「biblio-claw 自体の応答不能」に限定する
 *     = 蔵書検索が個別に失敗しても 200 + `status:'error'` + `warnings` で運ぶ (Fugue 側の
 *       AD ラウンド継続判断を阻害しない)。5xx を返すのは handleRequest の catch-all (uncaught)
 *       のみで、正常な部分失敗経路では 5xx を出さない。
 *   契約 2: 200 応答には常に `processing_time_ms` が含まれる (Fugue 側の SLA 監視の要)
 *
 * fugue-http.test.ts の mock pattern (listBiblio / shelf-gh / fugue-equipped-biblios) を写経し、
 * 実 HTTP fetch で 14 case を検証する。既存 fugue-http.test.ts と assertion 対象は重複するが、
 * 「AD の本義契約の変更 = 部分失敗経路の 5xx 化 / processing_time_ms drop」を silent regression
 * として検知するための independent test file (PRD 契約と直接紐づく assertion に集約)。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListBiblioResult } from '../biblio/types.js';

import { FugueHttpServer } from './fugue-http.js';

const TOKEN = 'adh-test-token-abcdef0123456789abcdef0123456789abcdef01';

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

describe('FugueHttpServer AD-honji assertion (Phase 4)', () => {
  let server: FugueHttpServer;
  let baseUrl: string;

  beforeEach(async () => {
    const { listBiblio } = await import('../biblio/list-biblio.js');
    vi.mocked(listBiblio).mockResolvedValue(FIXTURE_RESULT);
    server = new FugueHttpServer({ port: 0, host: '127.0.0.1', expectedToken: TOKEN });
    const started = await server.start();
    baseUrl = `http://127.0.0.1:${started.port}`;
  });

  afterEach(async () => {
    await server.stop();
    vi.mocked((await import('../biblio/list-biblio.js')).listBiblio).mockReset();
    const equipped = await import('../db/fugue-equipped-biblios.js');
    vi.mocked(equipped.insertFugueEquippedBiblio).mockReturnValue(true);
    vi.mocked(equipped.getFugueEquippedBiblioNames).mockReturnValue([]);
  });

  describe('契約 1: 5xx path enumeration (should be catch-all only)', () => {
    it('static grep: writeError(res, 5xx, ...) is only called in handleRequest catch-all', () => {
      // 実 HTTP fetch では handleRequest の catch-all を発火させるのが困難なため (`res.headersSent`
      // check + `writeError(res, 500, ...)` は uncaught 想定のみ発火)、静的 grep assertion で
      // 「5xx 応答経路が catch-all 1 箇所に集約されていること」を担保する。
      const here = dirname(fileURLToPath(import.meta.url));
      const source = readFileSync(resolve(here, 'fugue-http.ts'), 'utf-8');
      const matches = source.match(/writeError\(res,\s*5\d{2}/g) ?? [];
      expect(
        matches.length,
        `writeError(res, 5xx, ...) が ${matches.length} 箇所ある。catch-all 1 箇所以外は AD 本義違反`,
      ).toBe(1);
    });

    // Phase 4 review S1 (type-design-analyzer): 全 200 応答分岐で fugueSpan.setAttribute('fugue.outcome', ...)
    // が刻まれていることを静的 grep で強制。withFugueEntrySpan の型では強制せず (over-engineering、
    // BiblioActionName / fugue.outcome の domain logic を呼び出し側が決める既存流儀を維持) の代わりに、
    // 対称性の機械保証で silent gap を塞ぐ。将来 200 応答分岐が追加された際、fugue.outcome の
    // setAttribute を忘れると本 test が fail する = Cloud Trace の outcome ベースダッシュボードから
    // silent に消える regression の構造的防止。
    // 例外: writeJson(res, 200, ...) は withBiblioActionSpan の中で呼ばれる想定だが、fugueSpan は
    // withFugueEntrySpan のクロージャで見えるので、全 200 分岐で刻める。
    it('static grep: writeJson(res, 200, ...) の分岐数と fugueSpan.setAttribute(fugue.outcome) の呼出数が一致', () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const source = readFileSync(resolve(here, 'fugue-http.ts'), 'utf-8');
      // writeJson の 2 番目引数が literal 200 の箇所のみ抽出 (writeError の内部呼び出しは status
      // 変数経由なので `writeJson(res, status,` 形式 = 本 regex では拾わない)。
      const writeJson200Matches = source.match(/writeJson\(res,\s*200,/g) ?? [];
      const setFugueOutcomeMatches = source.match(/fugueSpan\.setAttribute\('fugue\.outcome',/g) ?? [];
      expect(
        setFugueOutcomeMatches.length,
        `writeJson(res, 200, ...) = ${writeJson200Matches.length} 箇所、` +
          `fugueSpan.setAttribute('fugue.outcome', ...) = ${setFugueOutcomeMatches.length} 箇所。` +
          `全 200 応答分岐で outcome 属性を刻むべき (Cloud Trace outcome ベース集計からの silent drop 防止)。`,
      ).toBe(writeJson200Matches.length);
      // 参考値の retention: Phase 4 完了時点は 7 (consult 2 + equip 5 = HITL + partial_A + not_found +
      // partial_B + success)。追加/削除時は本 assertion が fail するので、意図された対称性の範囲で
      // 数を updateする。
      expect(writeJson200Matches.length).toBeGreaterThanOrEqual(6);
    });

    it('listBiblio throw is served as 200 + status:error (not 5xx)', async () => {
      const { listBiblio } = await import('../biblio/list-biblio.js');
      vi.mocked(listBiblio).mockRejectedValueOnce(new Error('simulated network failure'));

      const res = await fetch(`${baseUrl}/v1/channels/fugue/consult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          schema_version: '1',
          request_id: 'req-adh-1',
          query: 'x',
          mode: 'ask-ad',
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        warnings: string[];
        processing_time_ms: number;
      };
      expect(body.status).toBe('error');
      expect(body.warnings.length).toBeGreaterThan(0);
      expect(body.processing_time_ms).toBeGreaterThanOrEqual(0);
    });

    it('401 for invalid Bearer (auth error, not path-existence 500)', async () => {
      const res = await fetch(`${baseUrl}/v1/channels/fugue/consult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
        body: '{}',
      });
      expect(res.status).toBe(401);
    });

    it('413 for body over 1 MiB (payload_too_large, not 5xx)', async () => {
      const largeBody = 'x'.repeat(2 * 1024 * 1024);
      const res = await fetch(`${baseUrl}/v1/channels/fugue/consult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: largeBody,
      });
      expect(res.status).toBe(413);
    });

    it('400 for Zod schema validation failure (実装は 400、PRD 記述の 422 とは差分あり)', async () => {
      // PRD 起草時点では 422 想定 (RFC 4918)、実装は 400 を採用。intentional divergence
      // で PRD 起草を実装に追随させる方針 (test は実装 = 400 を assert)。
      const res = await fetch(`${baseUrl}/v1/channels/fugue/consult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ invalid: 'shape' }),
      });
      expect(res.status).toBe(400);
    });

    it('404 for unknown path (not 5xx)', async () => {
      const res = await fetch(`${baseUrl}/v1/channels/fugue/unknown-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: '{}',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('契約 1b: 200 partial failure paths (all covered, none escalate to 5xx)', () => {
    it('consult listBiblio throw → 200 + status:error + warnings', async () => {
      const { listBiblio } = await import('../biblio/list-biblio.js');
      vi.mocked(listBiblio).mockRejectedValueOnce(new Error('boom'));
      const res = await fetch(`${baseUrl}/v1/channels/fugue/consult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          schema_version: '1',
          request_id: 'req-adh-cbf',
          query: 'x',
          mode: 'ask-ad',
        }),
      });
      const body = (await res.json()) as { status: string; warnings: string[] };
      expect(res.status).toBe(200);
      expect(body.status).toBe('error');
      expect(body.warnings.some((w) => w.startsWith('consult failed'))).toBe(true);
    });

    it('consult 0 skills → 200 + status:not_found (query 不一致)', async () => {
      const res = await fetch(`${baseUrl}/v1/channels/fugue/consult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          schema_version: '1',
          request_id: 'req-adh-empty',
          query: 'no-such-keyword-in-fixture',
          mode: 'ask-ad',
        }),
      });
      const body = (await res.json()) as { status: string; processing_time_ms: number };
      expect(res.status).toBe(200);
      expect(body.status).toBe('not_found');
      expect(body.processing_time_ms).toBeGreaterThanOrEqual(0);
    });

    it('equip listBiblio throw → 200 + status:error + warnings', async () => {
      const { listBiblio } = await import('../biblio/list-biblio.js');
      vi.mocked(listBiblio).mockRejectedValueOnce(new Error('gh outage'));
      const res = await fetch(`${baseUrl}/v1/channels/fugue/equip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          schema_version: '1',
          request_id: 'req-adh-ebf',
          skill_id: 'HajimariInc--figma-reviewer',
          channel: 'fugue',
        }),
      });
      const body = (await res.json()) as { status: string; warnings: string[] };
      expect(res.status).toBe(200);
      expect(body.status).toBe('error');
      expect(body.warnings.some((w) => w.startsWith('equip failed'))).toBe(true);
    });

    it('equip DB write throw → 200 + status:error + warnings', async () => {
      const equipped = await import('../db/fugue-equipped-biblios.js');
      vi.mocked(equipped.insertFugueEquippedBiblio).mockImplementationOnce(() => {
        throw new Error('SQLITE_BUSY: database is locked');
      });
      const res = await fetch(`${baseUrl}/v1/channels/fugue/equip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          schema_version: '1',
          request_id: 'req-adh-dbf',
          skill_id: 'HajimariInc--figma-reviewer',
          channel: 'fugue',
        }),
      });
      const body = (await res.json()) as { status: string; warnings: string[] };
      expect(res.status).toBe(200);
      expect(body.status).toBe('error');
      expect(body.warnings.some((w) => w.startsWith('equip state write failed'))).toBe(true);
    });

    it('equip skill_id 不在 → 200 + status:not_found (not 5xx)', async () => {
      const res = await fetch(`${baseUrl}/v1/channels/fugue/equip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          schema_version: '1',
          request_id: 'req-adh-nf',
          skill_id: 'HajimariInc--does-not-exist',
          channel: 'fugue',
        }),
      });
      const body = (await res.json()) as { status: string };
      expect(res.status).toBe(200);
      expect(body.status).toBe('not_found');
    });
  });

  describe('契約 2: processing_time_ms は 200 応答で常に付与される', () => {
    it('consult 成功 response body に processing_time_ms が入る', async () => {
      const res = await fetch(`${baseUrl}/v1/channels/fugue/consult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          schema_version: '1',
          request_id: 'req-adh-t1',
          query: 'Figma',
          mode: 'ask-ad',
        }),
      });
      const body = (await res.json()) as { processing_time_ms: number };
      expect(typeof body.processing_time_ms).toBe('number');
      expect(body.processing_time_ms).toBeGreaterThanOrEqual(0);
    });

    it('consult partial failure response body にも processing_time_ms が入る', async () => {
      const { listBiblio } = await import('../biblio/list-biblio.js');
      vi.mocked(listBiblio).mockRejectedValueOnce(new Error('boom'));
      const res = await fetch(`${baseUrl}/v1/channels/fugue/consult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          schema_version: '1',
          request_id: 'req-adh-t2',
          query: 'x',
          mode: 'ask-ad',
        }),
      });
      const body = (await res.json()) as { processing_time_ms: number };
      expect(typeof body.processing_time_ms).toBe('number');
      expect(body.processing_time_ms).toBeGreaterThanOrEqual(0);
    });

    it('equip 成功 response body にも processing_time_ms が入る', async () => {
      const res = await fetch(`${baseUrl}/v1/channels/fugue/equip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          schema_version: '1',
          request_id: 'req-adh-t3',
          skill_id: 'HajimariInc--figma-reviewer',
          channel: 'fugue',
        }),
      });
      const body = (await res.json()) as { processing_time_ms: number };
      expect(typeof body.processing_time_ms).toBe('number');
      expect(body.processing_time_ms).toBeGreaterThanOrEqual(0);
    });
  });
});
