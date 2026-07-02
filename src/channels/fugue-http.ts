/**
 * Fugue channel adapter (M4-E) — 独立 HTTP server (Node built-in `http.createServer`)。
 *
 * Phase 1 の scope:
 *   - Bearer auth (timing-safe compare) → no_header / bad_scheme / bad_token を 401 で返す
 *   - path routing (`/v1/channels/fugue/consult` / `/v1/channels/fugue/equip`) → skeleton 200 応答
 *   - 未知 path → 404 / Zod validation 失敗 → 400 / 内部エラー → 500
 *   - lifecycle: start() / stop() を Promise 化 (`src/cli/socket-server.ts:20-53` パターン写経)
 *
 * Chat SDK webhook (`src/webhook-server.ts`) とは path 形式が違うため独立 server として新設。
 * `webhook-server.ts` からは createServer 外殻 + try/catch → 500 fallback の骨格のみ写経、
 * lazy-start は使わず `setup()` から明示 start() する (Fugue adapter は adapter lifecycle に
 * 従うため lazy-start の遅延起動要件はない)。
 */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { log } from '../log.js';

import { FugueConsultRequestSkeleton, FugueEquipRequestSkeleton, type FugueSkeletonResponse } from './fugue-schemas.js';

const CONSULT_PATH = '/v1/channels/fugue/consult';
const EQUIP_PATH = '/v1/channels/fugue/equip';

export interface FugueHttpServerOptions {
  port: number;
  host: string;
  expectedToken: string;
}

export interface FugueHttpStartResult {
  port: number;
}

type BearerVerdict = 'ok' | 'no_header' | 'bad_scheme' | 'bad_token';

/**
 * Bearer 検証。timing-safe compare で side-channel を漏らさない。
 *
 * GOTCHA: `crypto.timingSafeEqual(a, b)` は `a.length !== b.length` で throw する。
 * 事前に長さを弾いて `bad_token` を返す。長さ違いも成功と同じ処理時間で reject するのが
 * 理想だが、Phase 1 では長さで早期 return を許容 (Fugue 側 token 長は固定 64 hex chars で
 * 運用予定 = 長さ違い攻撃の実効性は無視できる、plan Task 3 GOTCHA 参照)。
 */
function verifyBearer(header: string | undefined, expected: string): BearerVerdict {
  if (!header) return 'no_header';
  const idx = header.indexOf(' ');
  if (idx === -1) return 'bad_scheme';
  const scheme = header.slice(0, idx);
  const token = header.slice(idx + 1);
  if (scheme !== 'Bearer' || !token) return 'bad_scheme';
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return 'bad_token';
  return timingSafeEqual(a, b) ? 'ok' : 'bad_token';
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (raw.trim() === '') return undefined;
  return JSON.parse(raw);
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export class FugueHttpServer {
  private server: http.Server | null = null;

  constructor(private readonly opts: FugueHttpServerOptions) {}

  async start(): Promise<FugueHttpStartResult> {
    if (this.server) {
      // start() 冪等: 既に起動済ならそのまま bind 済 port を返す (Slack adapter setup と
      // 対称、二重 start で throw しないほうが SIGHUP-restart 等の運用で扱いやすい)。
      const addr = this.server.address();
      const boundPort = typeof addr === 'object' && addr !== null ? addr.port : this.opts.port;
      return { port: boundPort };
    }

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const addr = server.address();
    const boundPort = typeof addr === 'object' && addr !== null ? addr.port : this.opts.port;
    return { port: boundPort };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  isListening(): boolean {
    return this.server?.listening === true;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    let pathname: string;
    try {
      const url = new URL(rawUrl, `http://${req.headers.host ?? 'localhost'}`);
      pathname = url.pathname;
    } catch {
      writeJson(res, 400, { error: 'invalid_url' });
      return;
    }

    log.info('Fugue inbound HTTP received', {
      event: 'fugue.inbound.received',
      channel: 'fugue',
      method,
      path: pathname,
    });

    try {
      // Auth: すべての Fugue endpoint で Bearer 必須。
      const verdict = verifyBearer(req.headers.authorization, this.opts.expectedToken);
      if (verdict !== 'ok') {
        log.warn('Fugue Bearer auth rejected', {
          event: 'fugue.auth.rejected',
          channel: 'fugue',
          outcome: 'reject',
          reason: verdict,
          path: pathname,
        });
        writeJson(res, 401, { error: 'unauthorized', reason: verdict });
        return;
      }

      if (pathname === CONSULT_PATH) {
        await this.handleConsult(req, res);
        return;
      }
      if (pathname === EQUIP_PATH) {
        await this.handleEquip(req, res);
        return;
      }

      log.warn('Fugue unknown path', {
        event: 'fugue.route.not_found',
        channel: 'fugue',
        outcome: 'not_found',
        path: pathname,
      });
      writeJson(res, 404, { error: 'not_found', path: pathname });
    } catch (err) {
      log.error('Fugue handler error', {
        event: 'fugue.handler.error',
        channel: 'fugue',
        outcome: 'failure',
        path: pathname,
        err,
      });
      // 応答済でなければ 500 を返す。応答済 (writeHead 済) なら silent に握ることになるが、
      // その場合は既に client 側に応答は届いているので silent-failure の実害はない。
      if (!res.headersSent) {
        writeJson(res, 500, { error: 'internal' });
      } else {
        res.end();
      }
    }
  }

  private async handleConsult(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      log.warn('Fugue consult body parse failed', {
        event: 'fugue.consult.body_parse_failed',
        channel: 'fugue',
        outcome: 'reject',
        err: err instanceof Error ? err.message : String(err),
      });
      writeJson(res, 400, { error: 'invalid_input', detail: 'body is not valid JSON' });
      return;
    }
    const parsed = FugueConsultRequestSkeleton.safeParse(body);
    if (!parsed.success) {
      log.warn('Fugue consult schema validation failed', {
        event: 'fugue.consult.schema_invalid',
        channel: 'fugue',
        outcome: 'reject',
        issues: parsed.error.issues,
      });
      writeJson(res, 400, { error: 'invalid_input', issues: parsed.error.issues });
      return;
    }
    const response: FugueSkeletonResponse = {
      schema_version: '1',
      request_id: parsed.data.request_id,
      operation: 'consult',
      status: 'ok',
      stub: true,
    };
    log.info('Fugue consult skeleton stub returned', {
      event: 'fugue.consult.skeleton_stub',
      channel: 'fugue',
      outcome: 'success',
      request_id: parsed.data.request_id,
    });
    writeJson(res, 200, response);
  }

  private async handleEquip(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      log.warn('Fugue equip body parse failed', {
        event: 'fugue.equip.body_parse_failed',
        channel: 'fugue',
        outcome: 'reject',
        err: err instanceof Error ? err.message : String(err),
      });
      writeJson(res, 400, { error: 'invalid_input', detail: 'body is not valid JSON' });
      return;
    }
    const parsed = FugueEquipRequestSkeleton.safeParse(body);
    if (!parsed.success) {
      log.warn('Fugue equip schema validation failed', {
        event: 'fugue.equip.schema_invalid',
        channel: 'fugue',
        outcome: 'reject',
        issues: parsed.error.issues,
      });
      writeJson(res, 400, { error: 'invalid_input', issues: parsed.error.issues });
      return;
    }
    const response: FugueSkeletonResponse = {
      schema_version: '1',
      request_id: parsed.data.request_id,
      operation: 'equip',
      status: 'ok',
      stub: true,
    };
    log.info('Fugue equip skeleton stub returned', {
      event: 'fugue.equip.skeleton_stub',
      channel: 'fugue',
      outcome: 'success',
      request_id: parsed.data.request_id,
    });
    writeJson(res, 200, response);
  }
}
