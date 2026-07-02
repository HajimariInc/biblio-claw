/**
 * Fugue channel adapter (M4-E) — 独立 HTTP server (Node built-in `http.createServer`)。
 *
 * Phase 1 の scope (skeleton):
 *   - Bearer auth (timing-safe compare) → no_header / bad_scheme / bad_token を 401 で返す
 *     (client 応答は `{error: 'unauthorized'}` のみ、reason はサーバログ限定 = 未認証
 *     クライアントに auth oracle を漏らさない)
 *   - path routing (`/v1/channels/fugue/{consult,equip}`) → skeleton 応答
 *   - 未知 path → 404 / URL parse 失敗 → 400 (log 付き) / JSON parse 失敗 → 400 /
 *     body 上限超過 (1 MiB) → 413 / Zod validation 失敗 → 400 / 内部エラー → 500
 *   - lifecycle: start() / stop() を Promise 化 (`src/cli/socket-server.ts` の `startCliServer`
 *     / `stopCliServer` パターン写経)
 *   - post-listen `'error'` listener を恒久登録 — 起動後の runtime error が
 *     uncaughtException 経路 (host 全体 exit) に落ちるのを防ぎ、Fugue 由来と分かる形でログに残す
 *   - error response body は `FugueErrorResponse` 型で closed union として型付け
 *
 * Phase 2 の scope (consult full spec):
 *   - `handleConsult`: `listBiblio()` 経由の棚検索 + query substring match + top 10 truncate
 *   - `listBiblio()` 失敗は 200 + `status:'error'` + `warnings` で部分失敗として返す
 *     (5xx を出さず、Fugue 側の AD ラウンド継続判断を阻害しない)
 *   - `withBiblioActionSpan('list', ...)` に相乗り (M4-A biblio.list span に channel 横断集計)
 *   - `processing_time_ms` を response + log に載せる
 *
 * Chat SDK webhook (`src/webhook-server.ts`) とは path 形式が違うため独立 server として新設。
 * `webhook-server.ts` からは createServer 外殻 + try/catch → 500 fallback の骨格のみ写経、
 * lazy-start は使わず `setup()` から明示 start() する (Fugue adapter は adapter lifecycle に
 * 従うため lazy-start の遅延起動要件はない)。
 */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { SpanStatusCode } from '@opentelemetry/api';

import { withBiblioActionSpan } from '../biblio/action-helpers.js';
import { listBiblio } from '../biblio/list-biblio.js';
import { GhHttpError, MarketplaceParseError, readListEnv } from '../biblio/shelf-gh.js';
import type { ListBiblioItem, ListBiblioResult } from '../biblio/types.js';
import { log } from '../log.js';

import {
  FugueConsultRequest,
  FugueEquipRequestSkeleton,
  type FugueConsultMode,
  type FugueConsultReply,
  type FugueErrorResponse,
  type FugueSkeletonResponse,
  type FugueUnavailableReason,
  type SkillRef,
} from './fugue-schemas.js';

const CONSULT_PATH = '/v1/channels/fugue/consult';
const EQUIP_PATH = '/v1/channels/fugue/equip';
/**
 * Request body の最大バイト数 (1 MiB)。Phase 2 の consult payload は小さい (query 500 char +
 * context_hint dict) ため余裕。TODO(M4-E Phase 4+): 実運用サイズが判明したら見直す。
 * 上限超過は 413 Payload Too Large + log.warn。
 */
const MAX_BODY_SIZE_BYTES = 1024 * 1024;

export interface FugueHttpServerOptions {
  /** Listen port。`0` = OS が空きポートを自動割当 (test 用の ephemeral port)。 */
  port: number;
  host: string;
  expectedToken: string;
}

export interface FugueHttpStartResult {
  port: number;
}

type BearerVerdict = 'ok' | 'no_header' | 'bad_scheme' | 'bad_token';

class BodyTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Bearer 検証。timing-safe compare で side-channel を漏らさない。
 *
 * GOTCHA: `crypto.timingSafeEqual(a, b)` は `a.length !== b.length` で throw する。
 * 事前に長さを弾いて `bad_token` を返す。長さ違いも成功と同じ処理時間で reject するのが
 * 理想だが、Phase 2 では長さで早期 return を許容 (Fugue 側 token 長は固定 64 hex chars で
 * 運用予定 = 長さ違い攻撃の実効性は無視できる)。
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
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_SIZE_BYTES) {
      // 以降の chunk 読み取りを打ち切って早期 throw (=メモリ蓄積を防ぐ)。
      throw new BodyTooLargeError(`body exceeds ${MAX_BODY_SIZE_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (raw.trim() === '') return undefined;
  return JSON.parse(raw);
}

function writeJson<T>(res: http.ServerResponse, status: number, body: T): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Error response を型付きで返す。`FugueErrorResponse` が field 名 typo を compile-time
 * で防ぐ (成功応答用の `FugueSkeletonResponse` / `FugueConsultReply` と分ける狙い)。
 */
function writeError(res: http.ServerResponse, status: number, body: FugueErrorResponse): void {
  writeJson(res, status, body);
}

/**
 * `query` を `ListBiblioItem` の name + description に case-insensitive substring match
 * する。TODO(M4-E Phase 4+): LLM 経由の意図抽出に切り替え、substring match は fallback に。
 */
function queryMatches(item: ListBiblioItem, query: string): boolean {
  const q = query.toLowerCase();
  return item.name.toLowerCase().includes(q) || item.description.toLowerCase().includes(q);
}

/**
 * `ListBiblioItem[]` を Fugue 契約の `SkillRef[]` に写像し、上位 N 件で truncate する。
 *
 * - `manifest_url`: 棚 GitHub tree URL に組み立て (biblio-claw 側で組み立て、Fugue 側は
 *   URL を UI で表示する用途を想定)。
 * - `equipped`: Phase 2 では常に `false` (Fugue に session 概念なし)。型で literal 強制。
 * - `limit`: Fugue 側 skills_found の推奨上限 (= 10 件)。10 件で cut off。
 */
function toSkillRefs(items: ListBiblioItem[], shelfOwner: string, shelfRepo: string, limit = 10): SkillRef[] {
  return items.slice(0, limit).map((item) => ({
    id: item.name,
    name: item.name,
    description: item.description,
    manifest_url: `https://github.com/${shelfOwner}/${shelfRepo}/tree/main/${item.category}/${item.name}`,
    equipped: false,
  }));
}

/**
 * Fugue LLM 発話素材用の `summary` を生成する (500 字以内、日本語テンプレート)。
 *
 * Phase 2 では LLM は使わず、件数 / カテゴリ内訳 / 上位 3 件名を構造化した日本語文で
 * 返す。500 字超過は `.slice(0, 497) + '...'` で trim する。
 *
 * NOTE: trim 境界の safety について。テンプレート固定部と `topNames` (= item.name、
 * BIBLIO_NAME_RE で ASCII に制約済) は絵文字を含まないが、`query` は Fugue 側からの
 * 自由入力 (文字種制約なし) なので絵文字を含みうる。500 字超過時に truncation 境界が
 * `query` 由来の surrogate pair 中間に来る可能性は理論上残る (mojibake 応答になるが
 * Fugue 側 UI 表示レベルで問題にならない範囲、Phase 2 では許容)。
 * TODO(M4-E Phase 4+): Fugue LLM 生成に置換して trim ロジック自体を撤去。
 */
function summarizeConsult(
  result: ListBiblioResult,
  filtered: ListBiblioItem[],
  query: string,
  mode: FugueConsultMode,
): string {
  if (filtered.length === 0) {
    return `該当なし。棚には現在 ${result.total} 件登録されていますが、query "${query.slice(0, 40)}" に一致する skill は見つかりませんでした (mode: ${mode})。`;
  }
  const countsParts: string[] = [];
  for (const cat of ['biblio-dev', 'biblio-art', 'biblio-bf', 'biblio-ai'] as const) {
    const n = result.counts[cat];
    if (n > 0) countsParts.push(`${cat}:${n}`);
  }
  const topNames = filtered
    .slice(0, 3)
    .map((i) => i.name)
    .join(', ');
  const raw = `${filtered.length} 件見つかりました (棚全体 ${result.total} 件、内訳 [${countsParts.join(' / ')}])。上位: ${topNames}。query: "${query.slice(0, 60)}", mode: ${mode}。`;
  return raw.length > 500 ? raw.slice(0, 497) + '...' : raw;
}

/**
 * `listBiblio()` 経由の throw を `FugueUnavailableReason` に分類する。
 *
 * `MarketplaceParseError extends GhHttpError` の継承関係のため、
 * `instanceof MarketplaceParseError` を **先** に判定する必要がある (順序依存)。
 *
 * `env_missing` は `readListEnv()` が独自 Error 型を持たず素の `Error(...)` を投げるため
 * message 文字列で判定する (`shelf-gh.ts:readListEnv` の throw 文言に依存)。
 * TODO(shelf-gh): `EnvMissingError` 専用クラスを追加して string match を排除する。
 */
function classifyListBiblioError(err: unknown): FugueUnavailableReason {
  if (err instanceof MarketplaceParseError) return 'marketplace_parse';
  if (err instanceof GhHttpError) return 'github_http';
  if (err instanceof Error && err.message.includes('required env missing')) return 'env_missing';
  return 'other';
}

export class FugueHttpServer {
  private server: http.Server | null = null;

  constructor(private readonly opts: FugueHttpServerOptions) {}

  async start(): Promise<FugueHttpStartResult> {
    if (this.server) {
      // start() 冪等: 既に起動済ならそのまま bind 済 port を返す。Fugue 独自の運用判断
      // (SIGHUP-restart 等で二重呼出しになる可能性を許容、throw で fail-fast しない)。
      // Slack adapter setup (`chat-sdk-bridge.ts`) は逆に無条件で `new Chat/state` を
      // 再代入し listener を再登録する = 非冪等。混同しないこと。
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
        // Post-listen 恒久 error listener: 起動後に emit される runtime error (EMFILE /
        // accept 失敗 等) が uncaughtException 経路に落ちて host 全体を巻き込むのを防ぐ。
        // 既存パターン (`socket-server.ts` / `webhook-server.ts`) より一段厳しく扱う理由:
        // Fugue は外部到達可能な attack surface で blast radius が広い。
        server.on('error', (err) => {
          log.error('Fugue HTTP server runtime error', {
            event: 'fugue.server.error',
            channel: 'fugue',
            outcome: 'failure',
            err,
          });
        });
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
    } catch (err) {
      // catch でも log を残す (他 5 catch と一貫性)。rawUrl / err.message を診断情報として
      // 記録、6 ヶ月後のトリアージで「invalid_url 頻発」の兆候を追える。
      log.warn('Fugue URL parse failed', {
        event: 'fugue.url_parse_failed',
        channel: 'fugue',
        outcome: 'reject',
        rawUrl,
        err: err instanceof Error ? err.message : String(err),
      });
      writeError(res, 400, { error: 'invalid_url' });
      return;
    }

    log.info('Fugue inbound HTTP received', {
      event: 'fugue.inbound.received',
      channel: 'fugue',
      method,
      path: pathname,
    });

    try {
      // Auth check は path routing より先に走る (未認証クライアントに有効な path の存在を
      // 漏らさない不変条件、fugue-http.test.ts で固定化)。
      const verdict = verifyBearer(req.headers.authorization, this.opts.expectedToken);
      if (verdict !== 'ok') {
        // reason はサーバログ限定、client 応答は `{error: 'unauthorized'}` のみ。
        // reason (`no_header` / `bad_scheme` / `bad_token`) を client に返すと弱い auth
        // oracle になる (token 長 / scheme の存在等をリークする)。診断はログで行う。
        log.warn('Fugue Bearer auth rejected', {
          event: 'fugue.auth.rejected',
          channel: 'fugue',
          outcome: 'reject',
          reason: verdict,
          path: pathname,
        });
        writeError(res, 401, { error: 'unauthorized' });
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
      writeError(res, 404, { error: 'not_found', path: pathname });
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
        writeError(res, 500, { error: 'internal' });
      } else {
        res.end();
      }
    }
  }

  private async handleConsult(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Fugue 側契約で必須の `processing_time_ms` を response + log に載せる。計測開始は
    // handler 入り口 = body read 込みの全 duration。
    const startedAt = performance.now();

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      // readJsonBody は JSON.parse 失敗と socket read error の両方を throw する。event 名を
      // `body_read_failed` に中立化して err.code / SyntaxError 判定でトリアージ可能に。
      // BodyTooLargeError は 413 で明示的に分岐。
      if (err instanceof BodyTooLargeError) {
        log.warn('Fugue consult body too large', {
          event: 'fugue.consult.body_too_large',
          channel: 'fugue',
          outcome: 'reject',
          limit: MAX_BODY_SIZE_BYTES,
        });
        writeError(res, 413, { error: 'payload_too_large' });
        return;
      }
      const reason = err instanceof SyntaxError ? 'invalid_json' : 'read_error';
      const errCode = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      log.warn('Fugue consult body read failed', {
        event: 'fugue.consult.body_read_failed',
        channel: 'fugue',
        outcome: 'reject',
        reason,
        err: err instanceof Error ? err.message : String(err),
        err_code: errCode,
      });
      writeError(res, 400, {
        error: 'invalid_input',
        detail: reason === 'invalid_json' ? 'body is not valid JSON' : 'body read failed',
      });
      return;
    }
    const parsed = FugueConsultRequest.safeParse(body);
    if (!parsed.success) {
      log.warn('Fugue consult schema validation failed', {
        event: 'fugue.consult.schema_invalid',
        channel: 'fugue',
        outcome: 'reject',
        issues: parsed.error.issues,
      });
      writeError(res, 400, { error: 'invalid_input', issues: parsed.error.issues });
      return;
    }

    const { request_id, query, mode, context_hint } = parsed.data;

    log.info('Fugue consult invoked', {
      event: 'fugue.consult.invoked',
      channel: 'fugue',
      request_id,
      mode,
      query_length: query.length,
      // PII 保護: context_hint の中身は emit しない、key 名のみログに残す。
      context_hint_keys: Object.keys(context_hint ?? {}),
    });

    // `withBiblioActionSpan('list', ...)` に相乗り → M4-A の biblio.list span 集計に
    // channel 横断で載る。sessionId は Fugue に session 概念なし = 空文字
    // (action-helpers.ts の signature が空文字を許容)。
    // TODO(M4-E Phase 4+): Fugue 独自 span (`biblio.fugue.consult`) をこの外側に enclose する。
    await withBiblioActionSpan('list', request_id, '', async (span) => {
      // try 範囲は listBiblio() 呼出だけに絞る。後続 (readListEnv / toSkillRefs /
      // summarizeConsult / writeJson) は catch 外に置くことで、Phase 2 新規ロジックのバグを
      // GitHub 障害と同じ partial_failure に紛れさせない (成功経路の throw は
      // withBiblioActionSpan が re-throw → handleRequest の 500 catch で捕捉される)。
      let result: ListBiblioResult;
      try {
        result = await listBiblio({}, { ctx: { requestId: request_id, sessionId: '' } });
      } catch (err) {
        // 部分失敗経路 = biblio-claw は生きているが今回の蔵書検索だけ失敗した。
        // Fugue 側の AD ラウンド継続判断を阻害しないよう 200 + `status:'error'` +
        // `warnings` で運ぶ (PRD「AD の本義」節、5xx は認可 / 上限超過 / biblio-claw 自体の
        // 応答不能に限定)。
        //
        // span は ERROR status + biblio.outcome='failure' で Cloud Trace に記録する
        // (list-biblio-action.ts と同形、M4-A biblio.list 集計に失敗を反映)。
        const reason = classifyListBiblioError(err);
        const errorRecord = err instanceof Error ? err : new Error(String(err));
        span.recordException(errorRecord);
        span.setStatus({ code: SpanStatusCode.ERROR, message: `list_biblio_${reason}` });
        span.setAttribute('biblio.outcome', 'failure');

        const processing_time_ms = Math.round(performance.now() - startedAt);
        log.error('Fugue consult listBiblio failed, returning partial-failure reply', {
          event: 'fugue.consult.partial_failure',
          channel: 'fugue',
          outcome: 'failure',
          request_id,
          mode,
          reason,
          processing_time_ms,
          err: errorRecord.message,
        });

        const reply: FugueConsultReply = {
          schema_version: '1',
          request_id,
          operation: 'consult',
          status: 'error',
          summary: `蔵書検索で問題が発生しました (reason: ${reason})。しばらくしてから再度お試しください。`,
          skills_found: [],
          raw: { reason, query, mode },
          processing_time_ms,
          warnings: [`consult failed: ${reason}`],
        };
        writeJson(res, 200, reply);
        return;
      }

      // 成功経路 — 以下は try 外 = throw したら withBiblioActionSpan が re-throw、
      // handleRequest の 500 catch で捕捉される (Phase 2 新規ロジックのバグを露呈させる)。
      //
      // 'unknown' item は source パース失敗の item = manifest_url が実在しない GitHub
      // パス (`.../tree/main/unknown/*`) になるため skills_found に含めない。除外件数は
      // warnings に反映する。
      const unknownCount = result.items.filter((i) => i.category === 'unknown').length;
      const filtered = result.items.filter((i) => i.category !== 'unknown').filter((i) => queryMatches(i, query));

      // shelfOwner / shelfRepo を SkillRef.manifest_url に注入するため readListEnv() を
      // 呼ぶ。listBiblio() は既に readListEnv を通っているので env の存在は保証されている
      // が、readListEnv 内部は `fs.readFileSync` で `.env` を再度同期 read する
      // (env.ts:22-29 参照、caching なし)。小さいファイル前提で cost 無視可、hot path 化
      // したら listBiblio 戻り値に env を含める refactor を検討。
      const env = readListEnv();
      const skills_found = toSkillRefs(filtered, env.shelfOwner, env.shelfRepo);
      const summary = summarizeConsult(result, filtered, query, mode);

      const processing_time_ms = Math.round(performance.now() - startedAt);

      // warnings に truncation / unknown 除外を反映する。summary の件数表示と
      // skills_found.length の食い違いを client 側 (Fugue) が検知できるようにする。
      const warnings: string[] = [];
      if (unknownCount > 0) {
        warnings.push(`omitted ${unknownCount} item(s) with unknown category from skills_found`);
      }
      const matchedCount = filtered.length;
      if (matchedCount > skills_found.length) {
        warnings.push(`truncated skills_found to top ${skills_found.length} of ${matchedCount} matches`);
      }

      const status: 'ok' | 'not_found' = filtered.length > 0 ? 'ok' : 'not_found';

      span.setAttribute('biblio.outcome', status === 'ok' ? 'success' : 'not_found');

      const reply: FugueConsultReply = {
        schema_version: '1',
        request_id,
        operation: 'consult',
        status,
        summary,
        skills_found,
        raw: {
          listBiblio: {
            total: result.total,
            counts: result.counts,
            appliedFilter: result.appliedFilter,
          },
          query,
          mode,
        },
        processing_time_ms,
        warnings,
      };

      log.info('Fugue consult completed', {
        event: status === 'ok' ? 'fugue.consult.completed' : 'fugue.consult.not_found',
        channel: 'fugue',
        outcome: status === 'ok' ? 'success' : 'not_found',
        request_id,
        mode,
        status,
        processing_time_ms,
        skills_found_count: skills_found.length,
        total_shelf_items: result.total,
        warnings_count: warnings.length,
      });

      writeJson(res, 200, reply);
    });
  }

  private async handleEquip(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      // handleConsult と同一ロジック。
      if (err instanceof BodyTooLargeError) {
        log.warn('Fugue equip body too large', {
          event: 'fugue.equip.body_too_large',
          channel: 'fugue',
          outcome: 'reject',
          limit: MAX_BODY_SIZE_BYTES,
        });
        writeError(res, 413, { error: 'payload_too_large' });
        return;
      }
      const reason = err instanceof SyntaxError ? 'invalid_json' : 'read_error';
      const errCode = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      log.warn('Fugue equip body read failed', {
        event: 'fugue.equip.body_read_failed',
        channel: 'fugue',
        outcome: 'reject',
        reason,
        err: err instanceof Error ? err.message : String(err),
        err_code: errCode,
      });
      writeError(res, 400, {
        error: 'invalid_input',
        detail: reason === 'invalid_json' ? 'body is not valid JSON' : 'body read failed',
      });
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
      writeError(res, 400, { error: 'invalid_input', issues: parsed.error.issues });
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
