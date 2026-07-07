/**
 * Fugue channel adapter (M4-E + M4-H) — 独立 HTTP server (Node built-in `http.createServer`)。
 *
 * Phase 1 の scope (skeleton、Phase 2/3 で consult/equip endpoint はそれぞれ full spec 化):
 *   - Bearer auth (timing-safe compare) → no_header / bad_scheme / bad_token を 401 で返す
 *     (client 応答は `{error: 'unauthorized'}` のみ、reason はサーバログ限定 = 未認証
 *     クライアントに auth oracle を漏らさない)
 *   - path routing (`/v1/channels/fugue/{consult,equip,ask}`) の frame (endpoint 実体は各 Phase で追加)
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
 * Phase 3 の scope (equip full spec):
 *   - `handleEquip`: `FugueEquipRequest` (skill_id + channel:'fugue') 受理 → `BIBLIO_NAME_RE`
 *     guard で fail-closed 400 (path traversal 防御、`inspect-tool.ts` 執行と同流儀) →
 *     `requiresApproval('equip','fugue')` guard (現行 matrix では到達しない defensive 経路 =
 *     将来 matrix 変更時の silent HITL bypass 防止) → `withBiblioActionSpan('equip',...)` で
 *     M4-A biblio.equip span に channel-agnostic 集計 → `listBiblio()` 棚存在確認 (`category !==
 *     'unknown' && name === skill_id`) → `insertFugueEquippedBiblio()` の `INSERT OR IGNORE` +
 *     `info.changes` で `equipped` / `already_equipped` を atomic 判別 → 4 status 応答
 *     (`equipped` / `already_equipped` / `not_found` / `error`)
 *   - `handleConsult` 拡張: `toSkillRefs` に `equippedNames: ReadonlySet<string>` 引数追加、
 *     `getFugueEquippedBiblioNames()` DB read failure 時は空 Set fallback + `warnings.push`
 *     (AD の本義: 装飾情報の欠落で検索自体を殺さない)
 *   - 部分失敗経路は consult と対称 = `listBiblio` throw / DB write throw どちらも 200 +
 *     `status:'error'` + `warnings`、5xx は 401/413/500 (uncaught) に限定
 *
 * M4-H Phase 1 の scope (ask skeleton):
 *   - `handleAsk`: `FugueAskRequest` (query + optional intent + optional context_hint) 受理 →
 *     Zod parse (400 validation) → `withFugueEntrySpan('ask', ...)` → 固定 shape reply の 3 段
 *   - Phase 1 skeleton は skeleton_response marker を warnings に含む固定 reply を返す
 *     (backend / rate limit は Phase 3-4 で追加)
 *   - `writeJson` 直前に `FugueAskReply.safeParse` で self-validation を挟み、fail 時は
 *     `status:'error'` + warnings に理由を積んで 200 fallback (AD の本義: 5xx を出さない、
 *     内部整合性欠損を Fugue 側に silent に流さない)
 *   - biblio.<action> 相乗り span は張らない (backend 未接続、TODO(M4-H Phase 3) で
 *     withBiblioActionSpan('ask', ...) 追加検討)
 *
 * M4-H Phase 2 の scope (ask gate 統合):
 *   - `handleAsk` の `withFugueEntrySpan('ask', ...)` コールバック先頭に gate 4 層通過ロジック
 *     を挿入 (`handleConsult` / `handleEquip` の gate 挿入ブロック写経、3 つ目の対称コピー)
 *   - in-secure 判定時は 200 + `status:'denied'` + `warnings:[AD_ASK_DENIED_BY_GATE]` +
 *     `raw.reason:'in_secure'` で応答 (AD の本義契約: 5xx を出さない) + `notifyAdmin()`
 *     fire-and-forget (subject: `'gate.blocked (fugue)'`) + `appendGateAuditLog`
 *     (blocked/allowed/error 全経路発火)
 *   - intent 指定あり + gate 分類 `biblio-adk` (= ask の期待外分類、期待分類は Layer 4 fallback
 *     の `biblio-other`) で `warnings` に `INTENT_GATE_MISMATCH` を append (通常経路継続、
 *     `event:'fugue.ask.intent_gate_mismatch'` info log)
 *   - gate 自体の unexpected throw は fail-open (skeleton reply 継続 + `log.warn` +
 *     audit outcome='error')。gate throw を outer catch (`withFugueEntrySpan`) に抜けさせると
 *     500 化 + `fugue.outcome='error'` 上書きで AD の本義違反となるため、内側 try/catch で
 *     必ず吸収する不変条件を保持
 *   - denied reply も skeleton reply と同じく `FugueAskReply.safeParse` self-validation を経由
 *     (fail 時は errorReply の warnings に `AD_ASK_DENIED_BY_GATE` + `self_validation_failed`
 *     を並置 = denial 意図と bug 両方を Fugue 側に可視化)
 *   - `AD_ASK_DENIED_BY_GATE` / `INTENT_GATE_MISMATCH` は Contract §5.5 準拠の named export
 *     定数 (`fugue-schemas.ts`)。consult/equip の inline literal との書き味混在は許容
 *     (Fugue 側実装が塊で疎通取れた時点で fix 方針)
 *
 * Chat SDK webhook (`src/webhook-server.ts`) とは path 形式が違うため独立 server として新設。
 * `webhook-server.ts` からは createServer 外殻 + try/catch → 500 fallback の骨格のみ写経、
 * lazy-start は使わず `setup()` から明示 start() する (Fugue adapter は adapter lifecycle に
 * 従うため lazy-start の遅延起動要件はない)。
 */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { context, SpanStatusCode, trace } from '@opentelemetry/api';

import { BIBLIO_NAME_RE, withBiblioActionSpan } from '../biblio/action-helpers.js';
import { requiresApproval } from '../biblio/hitl-policy.js';
import { listBiblio } from '../biblio/list-biblio.js';
import { GhHttpError, MarketplaceParseError, readListEnv } from '../biblio/shelf-gh.js';
import type { ListBiblioItem, ListBiblioResult } from '../biblio/types.js';
import { getFugueEquippedBiblioNames, insertFugueEquippedBiblio } from '../db/fugue-equipped-biblios.js';
import { appendGateAuditLog } from '../gate/audit-log.js';
import { evaluateGate, isGateEnabled, withGateSpan } from '../gate/gate.js';
import type { GateResult } from '../gate/types.js';
import { log } from '../log.js';
import { notifyAdmin } from '../modules/approvals/notify-admin.js';
import { extractTraceContextFromHttpHeaders, withFugueEntrySpan, type FugueOperation } from '../observability/index.js';

import {
  AD_ASK_DENIED_BY_GATE,
  FugueAskReply,
  FugueAskRequest,
  FugueConsultRequest,
  FugueEquipRequest,
  INTENT_GATE_MISMATCH,
  type FugueAskReplyT,
  type FugueAskRequestT,
  type FugueConsultMode,
  type FugueConsultReply,
  type FugueConsultRequestT,
  type FugueEquipReply,
  type FugueEquipRequestT,
  type FugueErrorResponse,
  type FugueUnavailableReason,
  type SkillRef,
} from './fugue-schemas.js';

const CONSULT_PATH = '/v1/channels/fugue/consult';
const EQUIP_PATH = '/v1/channels/fugue/equip';
const ASK_PATH = '/v1/channels/fugue/ask';
/**
 * LB health check / K8s readiness / liveness 用の unauthenticated endpoint (Phase 5)。
 *
 * 設計判断:
 * - auth check の前で 200 "ok" を返す = LB は Bearer を持たないため 401 で backend
 *   unhealthy になるのを防ぐ (`handleRequest` 冒頭 URL parse 直後で return する不変条件、
 *   `fugue-http.test.ts` の 3 case で固定化)。
 * - method 分岐なし = LB からの HEAD probe も allow。
 * - attack surface: 応答内容は `"ok"` のみ、path 存在漏洩は health check として業界標準運用。
 * - PR #126 review 対応 (C1+C2+C3): 本 endpoint は GCE LB backend health check 経由 (35.191.0.0/16
 *   + 130.211.0.0/22 から到達) でのみ叩かれる。K8s の readiness/livenessProbe は
 *   `k8s/10-orchestrator-statefulset.yaml` で exec `test -f /tmp/host-ready` に統一済 =
 *   本 endpoint に到達しない (Fugue silent skip 経路の crash loop 転化を防ぐため)。
 */
const HEALTHZ_PATH = '/healthz';
/**
 * Request body の最大バイト数 (1 MiB)。Phase 2 の consult payload は小さい (query 500 char +
 * context_hint dict) ため余裕。TODO(M4-E Phase 5+): 実運用サイズが判明したら見直す。
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
 * Fugue endpoint (consult / equip / ask) の request body を読み、Zod で検証し、data を返す共通ヘルパ。
 *
 * 目的 (PR #135 review 提案 10、code-simplifier): consult と equip の冒頭 44 行が operation 名
 * (event log field) と schema 以外は完全に同一実装だった。手書き複製のため片方だけ直す
 * regression の温床 (413/400 分岐が equip 側でテスト対象外だった Important 6 と根同じ)。ヘルパ化で
 *   - 乖離リスクを構造的に消す (consult / equip / ask の分岐は 1 箇所に集約)
 *   - equip 側の 413/400 テストは `parseFugueRequest` に対して 1 度書けば全 endpoint をカバー
 *   - event 名は `fugue.${operation}.body_too_large` 等の string interpolation で維持 = ランタイム
 *     で emit される log event value は refactor 前と完全同一 (`fugue-http.otel-log.test.ts` に無影響)
 *
 * 応答 body / status も refactor 前と同一 (`fugue-http.test.ts` の consult 側 413/400 assertion は
 * 無変更で PASS)。static grep test (5xx 出現数 / 200-outcome ペアリング) は 413/400 分岐にしか関係
 * しないため無傷。
 *
 * @param operation Fugue operation 種別 (`FugueOperation` に依存 = 型リンクで drift を防ぐ)。
 *                  event 名 (`fugue.<operation>.<phase>`) の string interpolation にのみ使用、
 *                  ロジック分岐は生成されない。
 * @returns 検証成功時は `data` (Zod schema の output 型)、失敗時は `null` + 呼び出し側は
 *          そのまま return する契約 (response 書き込みは本ヘルパ側で完了済)。
 */
async function parseFugueRequest<T>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  schema: {
    safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown[] } };
  },
  operation: FugueOperation,
): Promise<T | null> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    // BodyTooLargeError は 413 で明示分岐、それ以外は 400 に集約 (JSON.parse 失敗 / socket read
    // error の両方)。err.code / SyntaxError で reason を区別してログに残す。
    if (err instanceof BodyTooLargeError) {
      log.warn(`Fugue ${operation} body too large`, {
        event: `fugue.${operation}.body_too_large`,
        channel: 'fugue',
        outcome: 'reject',
        limit: MAX_BODY_SIZE_BYTES,
      });
      writeError(res, 413, { error: 'payload_too_large' });
      return null;
    }
    const reason = err instanceof SyntaxError ? 'invalid_json' : 'read_error';
    const errCode = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    log.warn(`Fugue ${operation} body read failed`, {
      event: `fugue.${operation}.body_read_failed`,
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
    return null;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    log.warn(`Fugue ${operation} schema validation failed`, {
      event: `fugue.${operation}.schema_invalid`,
      channel: 'fugue',
      outcome: 'reject',
      issues: parsed.error.issues,
    });
    writeError(res, 400, { error: 'invalid_input', issues: parsed.error.issues });
    return null;
  }
  return parsed.data;
}

/**
 * `query` を `ListBiblioItem` の name + description に case-insensitive substring match
 * する。TODO(M4-E Phase 5+): LLM 経由の意図抽出に切り替え、substring match は fallback に。
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
 * - `equipped`: Phase 3 で `fugue_equipped_biblios` (channel-scoped store) の membership に
 *   基づき決定。`equippedNames` に item.name が含まれるかどうかで判定 (Set の O(1) lookup)。
 *   equip 側からも `equip 対象の 1 件` を単独 SkillRef 化するために再利用される
 *   (`toSkillRefs([item], owner, repo, new Set([item.name]))[0]` の形)。
 * - `limit`: Fugue 側 skills_found の推奨上限 (= 10 件)。10 件で cut off。
 */
function toSkillRefs(
  items: ListBiblioItem[],
  shelfOwner: string,
  shelfRepo: string,
  equippedNames: ReadonlySet<string>,
  limit = 10,
): SkillRef[] {
  return items.slice(0, limit).map((item) => ({
    id: item.name,
    name: item.name,
    description: item.description,
    manifest_url: `https://github.com/${shelfOwner}/${shelfRepo}/tree/main/${item.category}/${item.name}`,
    equipped: equippedNames.has(item.name),
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
 * TODO(M4-E Phase 5+): Fugue LLM 生成に置換して trim ロジック自体を撤去。
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

    // Note: `this.server = server` は listen 成功後に代入する。listen 失敗時は catch で
    // `this.server` を null 状態に保つ = 再度 `start()` が呼ばれた際に (1)「既に起動済」と
    // 誤判定して偽の成功を返す silent failure 撲滅 + (2) 実際に再試行される (start() の
    // 冪等契約が listen 失敗後の再呼出でも実質的に成立する、silent-failure-hunter 指摘、
    // PR #135 review Important 2)。
    try {
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
    } catch (err) {
      // listen 失敗 (EADDRINUSE / EACCES 等) → server は listen 前の状態のまま。this.server を
      // 「未起動」に戻すことで、次の start() 呼出が「if (this.server)」で早期 return せず、
      // 実際に listen を再試行できる状態を保つ (silent-failure-hunter 指摘)。
      this.server = null;
      throw err;
    }

    // listen 成功が確定した時点で server を保持 = isListening()/stop()/handleRequest() が
    // 生きた server にのみ触る不変条件を保つ。
    this.server = server;
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

    // /healthz は auth check + log.info より前に返す (詳細は `HEALTHZ_PATH` の JSDoc)。
    // try/catch で包む理由 (PR #126 review I3): `writeHead`/`end` 失敗時に
    // `unhandledRejection` 経由の汎用ログ (`channel:'fugue'` タグなし) に落ちるのを防ぐ。
    // 応答済 (`headersSent`) なら silent に閉じる (実害なし、他 catch 経路と対称)。
    if (pathname === HEALTHZ_PATH) {
      try {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      } catch (err) {
        log.warn('Fugue healthz response failed', {
          event: 'fugue.healthz.write_failed',
          channel: 'fugue',
          outcome: 'failure',
          err: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          try {
            res.end();
          } catch {
            // 二重 end 失敗は無視 (socket 既に破棄済み等)
          }
        }
      }
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

      // Fugue → biblio-claw の trace 継承。extract の base は `context.active()` (デフォルト
      // 引数、Phase 4 review C1) なので、traceparent header 不在時は auto server span
      // (Phase 5 で ESM フック整備後に発火予定) を含む active context をそのまま保持し、
      // 有時は remote span 由来の trace_id で active を切り替える。auth 判定 (401) は本
      // ブロックの外に置き、未認証クライアントに path 存在を漏らさない不変条件を保つ。
      const extractedCtx = extractTraceContextFromHttpHeaders(req.headers);
      // Phase 4 review M3 (silent-failure #4): malformed traceparent は W3C spec §3.2 準拠で
      // silently root context に fallback するが、「header 不在 (正常)」と「header 存在するが壊れ
      // (Fugue 側 bug)」を区別できないと Fugue 側の trace 送信 regression が無警告で潜伏する。
      // header 存在時に extract 結果に valid span が乗らないケースを warn で明示可視化する。
      if (req.headers.traceparent !== undefined) {
        const extractedSpan = trace.getSpan(extractedCtx);
        const traceId = extractedSpan?.spanContext().traceId;
        if (!traceId || traceId === '00000000000000000000000000000000') {
          log.warn('Fugue traceparent header malformed, falling back to new trace', {
            event: 'fugue.traceparent.malformed',
            channel: 'fugue',
            outcome: 'warn',
            raw_traceparent: String(req.headers.traceparent).slice(0, 128),
            path: pathname,
          });
        }
      }
      const runInContext = <T>(fn: () => Promise<T>): Promise<T> => context.with(extractedCtx, fn);

      if (pathname === CONSULT_PATH) {
        await runInContext(() => this.handleConsult(req, res));
        return;
      }
      if (pathname === EQUIP_PATH) {
        await runInContext(() => this.handleEquip(req, res));
        return;
      }
      if (pathname === ASK_PATH) {
        await runInContext(() => this.handleAsk(req, res));
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

    // body 読取り + Zod 検証 + 413/400 応答は `parseFugueRequest` に集約 (提案 10、equip 側と共通)。
    const parsed = await parseFugueRequest<FugueConsultRequestT>(req, res, FugueConsultRequest, 'consult');
    if (!parsed) return;
    const { request_id, query, mode, context_hint } = parsed;

    log.info('Fugue consult invoked', {
      event: 'fugue.consult.invoked',
      channel: 'fugue',
      request_id,
      mode,
      query_length: query.length,
      // PII 保護: context_hint の中身は emit しない、key 名のみログに残す。
      context_hint_keys: Object.keys(context_hint ?? {}),
    });

    // 2 段 span 構造 (Phase 4、review C1 対応で明示):
    //   fugue.consult (Phase 4 で新設、kind=INTERNAL、channel='fugue')
    //     └─ biblio.list (既存、kind=INTERNAL、M4-A `biblio.<action>` 集計に channel-agnostic に相乗り)
    // auto HTTP POST server span 層 (kind=SERVER、HttpInstrumentation 経由) は本 repo の ESM
    // + `--import` 起動構成では現状発火せず (require-in-the-middle 依存 + `module.register()`
    // 未整備)、Phase 5 で ESM フック追加 or 2 段構造を正式仕様として運用の判断予定。
    // 詳細: `docs/operations-runbook.md` §M4-E Phase 4 §関連する scope 境界。
    // sessionId は Fugue に session 概念なし = 空文字 (action-helpers.ts の signature が空文字を許容)。
    await withFugueEntrySpan('consult', request_id, async (fugueSpan) => {
      fugueSpan.setAttribute('fugue.mode', mode);

      // M4-F Phase 2 gate 挿入 (consult): query を 4 層評価。in-secure なら 200 + status:'error'
      // + warnings + raw.reason: 'in_secure' で応答 (AD の本義 契約: 5xx は認可 / 上限超過 /
      // biblio-claw 自体の応答不能に限定)。gate 未有効時は skip = 従来経路継続。
      if (isGateEnabled()) {
        let gateResult: GateResult | null = null;
        try {
          gateResult = await withGateSpan(query, async (gateSpan) => {
            const result = await evaluateGate(query);
            gateSpan.setAttribute('gate.classification', result.classification);
            gateSpan.setAttribute('gate.layer_hit', result.layerHit);
            gateSpan.setAttribute('gate.reason', result.reason);
            gateSpan.setAttribute('gate.latency_ms', result.latencyMs);
            if (result.model) gateSpan.setAttribute('gate.model', result.model);
            if (result.degraded) gateSpan.setAttribute('gate.degraded', true); // I6
            gateSpan.setAttribute('gate.outcome', result.classification === 'in-secure' ? 'blocked' : 'allowed');
            return result;
          });
        } catch (err) {
          // gate 自体の unexpected throw は fail-open (現状経路継続、gateResult=null のまま fall
          // through)。router.ts の gate 挿入と同流儀 (plain `GateResult | null` optional で
          // `as unknown as` cast を避ける、S3 review 対応)。
          const errMsg = err instanceof Error ? err.message : String(err);
          log.warn('Fugue consult gate unexpected throw, falling back to open', {
            event: 'fugue.consult.gate_unexpected_throw',
            channel: 'fugue',
            request_id,
            err: errMsg,
          });
          // I5 対応: gate error も audit trail に載せる (BQ 集計から silent undercount 防止)
          appendGateAuditLog({
            outcome: 'error',
            reason: errMsg,
            utterance: query,
            channel: 'fugue',
            channelType: 'fugue',
            userId: null,
          });
        }
        if (gateResult) {
          appendGateAuditLog({
            outcome: gateResult.classification === 'in-secure' ? 'blocked' : 'allowed',
            layer: gateResult.layerHit,
            classification: gateResult.classification,
            reason: gateResult.reason,
            utterance: query,
            channel: 'fugue',
            channelType: 'fugue',
            userId: null, // Fugue には patron userId 概念なし (Bearer auth のみ)
            degraded: gateResult.degraded,
          });
          if (gateResult.classification === 'in-secure') {
            fugueSpan.setAttribute('fugue.outcome', 'in_secure');
            // admin DM 通知 (Fugue には patron の Slack userId が無いため agentGroupId=null で
            // global admin 選定、channelType='slack' 固定 = 現状 Fugue に admin 通知経路がないため
            // Slack DM 経由でのみ届く)。
            void notifyAdmin({
              channelType: 'slack',
              agentGroupId: null,
              subject: 'gate.blocked (fugue)',
              body: `Fugue 経由の injection 疑い発話 (consult)。\nlayer: ${gateResult.layerHit}\nreason: ${gateResult.reason}\nrequest_id: ${request_id}`,
            }).catch((err) =>
              log.warn('Fugue consult gate notifyAdmin unexpected throw', {
                event: 'fugue.consult.gate_notify_admin_throw',
                request_id,
                err: err instanceof Error ? err.message : String(err),
              }),
            );
            const processing_time_ms = Math.round(performance.now() - startedAt);
            log.warn('Fugue consult rejected by input gate', {
              event: 'fugue.consult.in_secure',
              channel: 'fugue',
              outcome: 'in_secure',
              request_id,
              mode,
              gate_layer: gateResult.layerHit,
              gate_reason: gateResult.reason,
              processing_time_ms,
            });
            const reply: FugueConsultReply = {
              schema_version: '1',
              request_id,
              operation: 'consult',
              status: 'error',
              summary: '入力に不審な内容が含まれる可能性があるため、この発話は処理できませんでした。',
              skills_found: [],
              raw: { reason: 'in_secure', query, mode },
              processing_time_ms,
              warnings: ['input rejected by input gate'],
            };
            writeJson(res, 200, reply);
            return;
          }
        }
      }

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
          // fugue span も outcome=error で明示 (biblio.outcome と対称に配置、grep で drift 検知可能)。
          // status は 200 で応答するため fugue span 側は UNSET のまま (エラー扱いは outcome 属性で表現)。
          fugueSpan.setAttribute('fugue.outcome', 'error');

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

        // 装備状態 (Phase 3) — fugue_equipped_biblios の membership で `SkillRef.equipped` を実データ化。
        // DB read 失敗は consult を殺さない (AD の本義: 装飾情報の欠落で検索自体を失敗にしない)。
        // 空 Set に fallback + warnings に理由を積み上げて Fugue 側で検知可能に。
        let equippedNames: ReadonlySet<string>;
        let equippedStateWarning: string | null = null;
        try {
          equippedNames = new Set(getFugueEquippedBiblioNames());
        } catch (err) {
          equippedNames = new Set();
          equippedStateWarning = `equipped state unavailable: ${err instanceof Error ? err.message : String(err)}`;
          log.warn('Fugue consult equipped state read failed, continuing with empty set', {
            event: 'fugue.consult.equipped_state_unavailable',
            channel: 'fugue',
            outcome: 'warn',
            request_id,
            err: err instanceof Error ? err.message : String(err),
          });
          // Phase 4 review M1 (silent-failure #2): 装備状態欠落は「劣化成功」= response body /
          // log には warn として可視化されるが、Cloud Trace の outcome ベース集計では通常の
          // 成功と区別できず silent degraded になる。span 属性 `fugue.degraded=true` で
          // categorical signal を刻み、UI / BQ 側で「劣化した成功」を separately 集計可能にする。
          fugueSpan.setAttribute('fugue.degraded', true);
        }

        const skills_found = toSkillRefs(filtered, env.shelfOwner, env.shelfRepo, equippedNames);
        const summary = summarizeConsult(result, filtered, query, mode);

        const processing_time_ms = Math.round(performance.now() - startedAt);

        // warnings に truncation / unknown 除外を反映する。summary の件数表示と
        // skills_found.length の食い違いを client 側 (Fugue) が検知できるようにする。
        const warnings: string[] = [];
        if (equippedStateWarning) {
          warnings.push(equippedStateWarning);
        }
        if (unknownCount > 0) {
          warnings.push(`omitted ${unknownCount} item(s) with unknown category from skills_found`);
        }
        const matchedCount = filtered.length;
        if (matchedCount > skills_found.length) {
          warnings.push(`truncated skills_found to top ${skills_found.length} of ${matchedCount} matches`);
        }

        const status: 'ok' | 'not_found' = filtered.length > 0 ? 'ok' : 'not_found';

        span.setAttribute('biblio.outcome', status === 'ok' ? 'success' : 'not_found');
        // fugue span の outcome は Fugue 契約 §5.2 の `status` 3 値 (`ok` / `not_found` / `error`) と
        // 揃える。biblio.outcome の 3 値 (`success` / `not_found` / `failure`) とは別軸。
        fugueSpan.setAttribute('fugue.outcome', status);

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
    });
  }

  private async handleEquip(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Phase 3: equip full spec 実装 (handleConsult の構造を機械踏襲、判断 D-J)。
    // Fugue 契約 §5.3 の FugueEquipRequest/Reply を満たす。
    const startedAt = performance.now();

    // body 読取り + Zod 検証 + 413/400 応答は `parseFugueRequest` に集約 (提案 10、consult 側と共通)。
    const parsed = await parseFugueRequest<FugueEquipRequestT>(req, res, FugueEquipRequest, 'equip');
    if (!parsed) return;
    const { request_id, skill_id } = parsed;

    // BIBLIO_NAME_RE guard (判断 F): safeParse 通過後に fail-closed で 400 REJECT。
    // 棚 item は shelve 経路で BIBLIO_NAME_RE 適合が保証されているため正当な id は必ず通る。
    // path traversal / DB 汚染への防御線 (inspect-tool.ts の execute 冒頭 guard と同流儀)。
    if (!BIBLIO_NAME_RE.test(skill_id)) {
      log.warn('Fugue equip skill_id rejected by BIBLIO_NAME_RE', {
        event: 'fugue.equip.schema_invalid',
        channel: 'fugue',
        outcome: 'reject',
        reason: 'biblio_name_re',
        request_id,
        skill_id,
      });
      writeError(res, 400, {
        error: 'invalid_input',
        detail: 'skill_id must match "<owner>--<repo>" or "<owner>--<repo>--<skill>"',
      });
      return;
    }

    log.info('Fugue equip invoked', {
      event: 'fugue.equip.invoked',
      channel: 'fugue',
      request_id,
      skill_id,
    });

    // 2 段 span 構造 (Phase 4、review C1 対応で明示、consult 側と対称):
    //   fugue.equip → biblio.equip
    // auto HTTP POST server span 層は Phase 5 で ESM フック追加後に発火 or 2 段構造を
    // 正式仕様として運用の判断予定 (詳細: `docs/operations-runbook.md` §M4-E Phase 4)。
    // sessionId は Fugue に session 概念なし = 空文字 (approval 経路と同慣習)。
    // **HITL 政策 guard 経路 (defensive path、Phase 4 review M2 = silent-failure #3 対応)**:
    // withFugueEntrySpan の **内側** に配置し、`fugue.outcome='hitl_required'` を span に刻む。
    // 現行 matrix では `requiresApproval('equip', 'fugue') === false` (Fugue 契約 §6.2 の HITL
    // 簡略化) のため到達しない dead path だが、将来 matrix が変わったときに Fugue equip が
    // (a) silent に HITL bypass する応答経路の穴、および (b) Cloud Trace 上で完全不可視になる
    // telemetry の穴、の両方を明示的に閉じる。
    await withFugueEntrySpan('equip', request_id, async (fugueSpan) => {
      // M4-F Phase 2 gate 挿入 (equip): skill_id を 4 層評価。BIBLIO_NAME_RE guard は既に
      // 通過している (skill_id は正当な形式) が、gate は semantic 判定 (Layer 4) で
      // exfiltration URL 等 (path traversal を超えた) 追加防御を担う。in-secure 応答経路は
      // consult と対称に 200 + status:'error' + warnings で運ぶ (AD の本義)。
      if (isGateEnabled()) {
        let gateResult: GateResult | null = null;
        try {
          gateResult = await withGateSpan(skill_id, async (gateSpan) => {
            const result = await evaluateGate(skill_id);
            gateSpan.setAttribute('gate.classification', result.classification);
            gateSpan.setAttribute('gate.layer_hit', result.layerHit);
            gateSpan.setAttribute('gate.reason', result.reason);
            gateSpan.setAttribute('gate.latency_ms', result.latencyMs);
            if (result.model) gateSpan.setAttribute('gate.model', result.model);
            if (result.degraded) gateSpan.setAttribute('gate.degraded', true); // I6
            gateSpan.setAttribute('gate.outcome', result.classification === 'in-secure' ? 'blocked' : 'allowed');
            return result;
          });
        } catch (err) {
          // consult 側と対称の fail-open (`GateResult | null` で `as unknown as` cast 回避、
          // S3 review 対応)。
          const errMsg = err instanceof Error ? err.message : String(err);
          log.warn('Fugue equip gate unexpected throw, falling back to open', {
            event: 'fugue.equip.gate_unexpected_throw',
            channel: 'fugue',
            request_id,
            err: errMsg,
          });
          // I5 対応: gate error も audit trail に載せる
          appendGateAuditLog({
            outcome: 'error',
            reason: errMsg,
            utterance: skill_id,
            channel: 'fugue',
            channelType: 'fugue',
            userId: null,
          });
        }
        if (gateResult) {
          appendGateAuditLog({
            outcome: gateResult.classification === 'in-secure' ? 'blocked' : 'allowed',
            layer: gateResult.layerHit,
            classification: gateResult.classification,
            reason: gateResult.reason,
            utterance: skill_id,
            channel: 'fugue',
            channelType: 'fugue',
            userId: null,
            degraded: gateResult.degraded,
          });
          if (gateResult.classification === 'in-secure') {
            fugueSpan.setAttribute('fugue.outcome', 'in_secure');
            void notifyAdmin({
              channelType: 'slack',
              agentGroupId: null,
              subject: 'gate.blocked (fugue)',
              body: `Fugue 経由の injection 疑い skill_id (equip)。\nlayer: ${gateResult.layerHit}\nreason: ${gateResult.reason}\nrequest_id: ${request_id}\nskill_id: ${skill_id}`,
            }).catch((err) =>
              log.warn('Fugue equip gate notifyAdmin unexpected throw', {
                event: 'fugue.equip.gate_notify_admin_throw',
                request_id,
                err: err instanceof Error ? err.message : String(err),
              }),
            );
            const processing_time_ms = Math.round(performance.now() - startedAt);
            log.warn('Fugue equip rejected by input gate', {
              event: 'fugue.equip.in_secure',
              channel: 'fugue',
              outcome: 'in_secure',
              request_id,
              skill_id,
              gate_layer: gateResult.layerHit,
              gate_reason: gateResult.reason,
              processing_time_ms,
            });
            const reply: FugueEquipReply = {
              schema_version: '1',
              request_id,
              operation: 'equip',
              status: 'error',
              summary: '入力に不審な内容が含まれる可能性があるため、この装備リクエストは処理できませんでした。',
              skill: null,
              processing_time_ms,
              warnings: ['input rejected by input gate'],
            };
            writeJson(res, 200, reply);
            return;
          }
        }
      }

      if (requiresApproval('equip', 'fugue')) {
        fugueSpan.setAttribute('fugue.outcome', 'hitl_required');
        const processing_time_ms = Math.round(performance.now() - startedAt);
        log.warn('Fugue equip requires approval but HITL bridge is not wired for fugue channel', {
          event: 'fugue.equip.hitl_required',
          channel: 'fugue',
          outcome: 'reject',
          request_id,
          skill_id,
          processing_time_ms,
        });
        const reply: FugueEquipReply = {
          schema_version: '1',
          request_id,
          operation: 'equip',
          status: 'error',
          summary: '装備には人間による承認が必要です。Slack channel から承認を受けてください。',
          skill: null,
          processing_time_ms,
          warnings: ['HITL approval required: please approve via Slack channel'],
        };
        writeJson(res, 200, reply);
        return;
      }
      await withBiblioActionSpan('equip', request_id, '', async (span) => {
        let result: ListBiblioResult;
        try {
          result = await listBiblio({}, { ctx: { requestId: request_id, sessionId: '' } });
        } catch (err) {
          // 部分失敗経路 (判断 H): 200 + status:'error' + warnings で運ぶ (AD の本義)。
          const reason = classifyListBiblioError(err);
          const errorRecord = err instanceof Error ? err : new Error(String(err));
          span.recordException(errorRecord);
          span.setStatus({ code: SpanStatusCode.ERROR, message: `list_biblio_${reason}` });
          span.setAttribute('biblio.outcome', 'failure');
          fugueSpan.setAttribute('fugue.outcome', 'error');

          const processing_time_ms = Math.round(performance.now() - startedAt);
          log.error('Fugue equip listBiblio failed, returning partial-failure reply', {
            event: 'fugue.equip.partial_failure',
            channel: 'fugue',
            outcome: 'failure',
            request_id,
            skill_id,
            reason,
            processing_time_ms,
            err: errorRecord.message,
          });
          const reply: FugueEquipReply = {
            schema_version: '1',
            request_id,
            operation: 'equip',
            status: 'error',
            summary: `装備準備で問題が発生しました (reason: ${reason})。しばらくしてから再度お試しください。`,
            skill: null,
            processing_time_ms,
            warnings: [`equip failed: ${reason}`],
          };
          writeJson(res, 200, reply);
          return;
        }

        // 棚存在確認 — consult と同じ unknown 除外 + 完全一致。
        const item = result.items.find((i) => i.category !== 'unknown' && i.name === skill_id);
        if (!item) {
          span.setAttribute('biblio.outcome', 'not_found');
          fugueSpan.setAttribute('fugue.outcome', 'not_found');
          const processing_time_ms = Math.round(performance.now() - startedAt);
          log.info('Fugue equip target not found in shelf', {
            event: 'fugue.equip.not_found',
            channel: 'fugue',
            outcome: 'not_found',
            request_id,
            skill_id,
            processing_time_ms,
          });
          const reply: FugueEquipReply = {
            schema_version: '1',
            request_id,
            operation: 'equip',
            status: 'not_found',
            summary: `『${skill_id}』は棚に見つかりませんでした。consult で棚を検索してから装備してください。`,
            skill: null,
            processing_time_ms,
            warnings: [],
          };
          writeJson(res, 200, reply);
          return;
        }

        // INSERT OR IGNORE (判断 C): atomic な already_equipped 判定。
        let inserted: boolean;
        try {
          inserted = insertFugueEquippedBiblio(skill_id, request_id);
        } catch (err) {
          // DB write 失敗 (判断 H): consult と同じく 200 + status:'error' + warnings で運ぶ。
          const errorRecord = err instanceof Error ? err : new Error(String(err));
          span.recordException(errorRecord);
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'equip_state_write_failed' });
          span.setAttribute('biblio.outcome', 'failure');
          fugueSpan.setAttribute('fugue.outcome', 'error');

          const processing_time_ms = Math.round(performance.now() - startedAt);
          log.error('Fugue equip DB write failed, returning partial-failure reply', {
            event: 'fugue.equip.partial_failure',
            channel: 'fugue',
            outcome: 'failure',
            request_id,
            skill_id,
            reason: 'db_write_failed',
            processing_time_ms,
            err: errorRecord.message,
          });
          const reply: FugueEquipReply = {
            schema_version: '1',
            request_id,
            operation: 'equip',
            status: 'error',
            summary: `装備状態の記録に失敗しました。しばらくしてから再度お試しください。`,
            skill: null,
            processing_time_ms,
            warnings: [`equip state write failed: ${errorRecord.message}`],
          };
          writeJson(res, 200, reply);
          return;
        }

        // 成功経路 (equipped or already_equipped): SkillRef 組み立て + reply 返送。
        // toSkillRefs を再利用して単一 SkillRef を作る (重複実装を避ける、判断 E の consult / equip 対称性)。
        // `[0]` の型は `noUncheckedIndexedAccess` 未設定のため `SkillRef` に narrow されるが、
        // これは「toSkillRefs が `[item].slice(0, limit).map(...)` で必ず 1 件返す」という
        // 呼び出し関数の実装依存の暗黙仮定。将来 toSkillRefs にフィルタ機構が入って空返却しうる形に
        // なると `undefined` が `FugueEquipReply.skill: SkillRef` (non-null 必須) に代入される
        // silent 破綻を招く。fail-fast + 明示 assertion で contract を型と実装両面で守る
        // (type-design-analyzer 指摘、PR #135 review 提案 8)。
        const env = readListEnv();
        const skills = toSkillRefs([item], env.shelfOwner, env.shelfRepo, new Set([skill_id]));
        const skill = skills[0];
        if (!skill) {
          // ここに到達するのは toSkillRefs が壊れた場合 (例: フィルタで空返却)。実装契約違反として
          // throw = 上位の withBiblioActionSpan / withFugueEntrySpan の catch が捕捉して 200 error
          // 応答経路 (AD の本義) に倒すため silent failure は生まない。
          throw new Error(
            `toSkillRefs unexpectedly returned empty array for equip skill_id=${skill_id} (contract violation)`,
          );
        }
        const status: 'equipped' | 'already_equipped' = inserted ? 'equipped' : 'already_equipped';

        span.setAttribute('biblio.outcome', 'success');
        // fugue span は Fugue 契約 §5.3 の 4 status (`equipped` / `already_equipped` /
        // `not_found` / `error`) と揃える (biblio.outcome の 3 値と別軸)。
        fugueSpan.setAttribute('fugue.outcome', status);
        const processing_time_ms = Math.round(performance.now() - startedAt);
        const summary = inserted ? `『${item.name}』を装備しました。` : `『${item.name}』は既に装備済みです。`;
        const reply: FugueEquipReply = {
          schema_version: '1',
          request_id,
          operation: 'equip',
          status,
          summary,
          skill,
          processing_time_ms,
          warnings: [],
        };

        log.info(inserted ? 'Fugue equip completed' : 'Fugue equip already-equipped', {
          event: inserted ? 'fugue.equip.completed' : 'fugue.equip.already_equipped',
          channel: 'fugue',
          outcome: 'success',
          request_id,
          skill_id,
          status,
          processing_time_ms,
        });

        writeJson(res, 200, reply);
      });
    });
  }

  /**
   * M4-H Phase 1 (skeleton) + Phase 2 (gate 統合): ask endpoint。
   *
   * Contract §5.5 shape で 200 応答を返す。gate 4 層通過 (Phase 2) + backend 未接続 (Phase 3 で
   * 追加予定) + rate limit なし (Phase 4 で追加予定)。処理段は 5 段: Zod parse →
   * `withFugueEntrySpan` → **gate 4 層評価** → 固定 skeleton reply 組み立て → self-validation →
   * 200 応答。
   *
   * 目的: Fugue 側 `BiblioClawAdvisorService.ask()` の HTTP round-trip + shape validation +
   * ValidationError 経路のテストを、biblio 側 backend 実装 (Phase 3) 完了を待たずに先行させる
   * (Phase 1) + injection 疑い発話の遮断 + intent hint と gate 分類の不一致検出 (Phase 2)。
   *
   * `status` の 4 status 意味論は `FugueAskReply` の JSDoc を参照 (schema 側を正本として重複を回避)。
   * 現状の応答分岐:
   *   - gate `in-secure` → 200 + `status:'denied'` + `warnings:[AD_ASK_DENIED_BY_GATE]` (Phase 2)
   *   - gate 通常経路 (or GATE_ENABLED=false or gate throw fail-open) → 200 + `status:'not_available'`
   *     + `warnings:['skeleton_response', ...gateWarnings]` (Phase 1 skeleton の継続)
   *   - self-validation fail → 200 + `status:'error'` + `warnings` に理由 (両分岐で fallback)
   *
   * `warnings: ['skeleton_response']` は本 PRD で新設した Phase 1 限定の marker (非 Contract 語彙、
   * unknown warning code は Fugue 側で log-only 扱い)。`AD_ASK_DENIED_BY_GATE` / `INTENT_GATE_MISMATCH`
   * (Phase 2 で追加) は Contract §5.5 語彙、Fugue 側の分岐判定に使われる (`fugue-schemas.ts` の
   * named export 定数を参照)。
   * TODO(M4-H Phase 3): backend 結線完了時に (a) 通常経路の `status` を `'ok'` に切替、(b) `warnings`
   * から `'skeleton_response'` を除去、(c) `summary` / `findings` / `sources` を実データで埋める。
   *
   * **self-validation (A3-2)**: 応答直前に `FugueAskReply.safeParse(reply)` を挟み、内部整合性
   * 欠損 (Phase 3 以降で summary 動的生成時に .max(600) 超過等) を fail-closed で捕捉する。
   * denied reply / skeleton reply の両分岐で self-validation を経由する (Phase 2 で対称化、
   * consult/equip の in-secure 分岐は safeParse を経由しないため ask は一段防御が厚い)。
   * fail 時は AD の本義契約に従い 200 + `status:'error'` + `warnings` で運ぶ (5xx 出さない)。
   */
  private async handleAsk(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const startedAt = performance.now();

    const parsed = await parseFugueRequest<FugueAskRequestT>(req, res, FugueAskRequest, 'ask');
    if (!parsed) return;
    const { request_id, query, intent, context_hint } = parsed;

    log.info('Fugue ask invoked', {
      event: 'fugue.ask.invoked',
      channel: 'fugue',
      request_id,
      intent: intent ?? null,
      query_length: query.length,
      // PII 保護: context_hint の中身は emit しない、key 名のみログに残す (consult 側と同流儀)。
      context_hint_keys: Object.keys(context_hint ?? {}),
    });

    // 2 段 span 構造 (Phase 4 で正式化、consult / equip と対称):
    //   fugue.ask (この helper、kind=INTERNAL)
    // Phase 1 skeleton では biblio.<action> 相乗り span は張らない (backend 未接続)。
    // TODO(M4-H Phase 3): backend 結線時に withBiblioActionSpan('ask', ...) の追加検討
    // (`BiblioActionName` union に 'ask' 追加要、M4-A biblio.<action> 集計への相乗り妥当性を判定)。
    // auto SERVER span 層は ESM フック未整備で現状発火せず (Phase 5 判断で 2 段構造を正式仕様として
    // 運用、詳細: `docs/operations-runbook.md` §M4-E Phase 4 §ESM フック判断)。
    await withFugueEntrySpan('ask', request_id, async (fugueSpan) => {
      // intent 属性は string で刻む (`.optional().nullable()` の 2 パスを 'null' に集約 =
      // Cloud Trace の属性検索で `fugue.intent='null'` 一択で見つけられる)。
      fugueSpan.setAttribute('fugue.intent', intent ?? 'null');

      // M4-H Phase 2 gate 挿入 (ask): query を 4 層評価。in-secure なら 200 + status:'denied'
      // + warnings:[AD_ASK_DENIED_BY_GATE] + raw.reason:'in_secure' で応答 (AD の本義 契約: 5xx は
      // 認可 / 上限超過 / biblio-claw 自体の応答不能に限定)。gate 未有効時は skip = skeleton 経路
      // 継続。intent 指定あり + gate 分類 = 'biblio-adk' なら INTENT_GATE_MISMATCH を warnings に
      // append (通常経路継続、Contract §5.5 運用規約)。写経元: `handleConsult` / `handleEquip` の
      // 同名 gate 挿入ブロック (`if (isGateEnabled()) { ... }` の 90 行構造)。ask 固有差分は plan
      // §Patterns to Mirror「in-secure denial 分岐」参照 (line 番号は Phase 2 の import 追加で
      // シフトするためシンボル参照に統一)。
      const gateWarnings: string[] = [];
      if (isGateEnabled()) {
        let gateResult: GateResult | null = null;
        try {
          gateResult = await withGateSpan(query, async (gateSpan) => {
            const result = await evaluateGate(query);
            gateSpan.setAttribute('gate.classification', result.classification);
            gateSpan.setAttribute('gate.layer_hit', result.layerHit);
            gateSpan.setAttribute('gate.reason', result.reason);
            gateSpan.setAttribute('gate.latency_ms', result.latencyMs);
            if (result.model) gateSpan.setAttribute('gate.model', result.model);
            if (result.degraded) gateSpan.setAttribute('gate.degraded', true);
            gateSpan.setAttribute('gate.outcome', result.classification === 'in-secure' ? 'blocked' : 'allowed');
            return result;
          });
        } catch (err) {
          // gate 自体の unexpected throw は fail-open (現状経路継続、gateResult=null のまま fall
          // through)。consult/equip と同流儀。gate throw を outer catch で処理させると
          // fugue.outcome='error' 上書き + 500 応答となり AD の本義違反 (plan Task 4 GOTCHA #1)。
          const errMsg = err instanceof Error ? err.message : String(err);
          log.warn('Fugue ask gate unexpected throw, falling back to open', {
            event: 'fugue.ask.gate_unexpected_throw',
            channel: 'fugue',
            request_id,
            err: errMsg,
          });
          // audit trail に載せる (BQ 集計から silent undercount 防止)
          appendGateAuditLog({
            outcome: 'error',
            reason: errMsg,
            utterance: query,
            channel: 'fugue',
            channelType: 'fugue',
            userId: null,
          });
        }
        if (gateResult) {
          appendGateAuditLog({
            outcome: gateResult.classification === 'in-secure' ? 'blocked' : 'allowed',
            layer: gateResult.layerHit,
            classification: gateResult.classification,
            reason: gateResult.reason,
            utterance: query,
            channel: 'fugue',
            channelType: 'fugue',
            userId: null,
            degraded: gateResult.degraded,
          });
          if (gateResult.classification === 'in-secure') {
            // in-secure 分岐: 200 + status:'denied' + warnings:[AD_ASK_DENIED_BY_GATE]。
            // consult の in-secure 分岐 (`handleConsult` 内 `if (gateResult.classification ===
            // 'in-secure')`) を写経、ask 固有差分は
            //   - status:'denied' (consult は 'error'、Contract §5.5 準拠で FugueAskReply の
            //     discriminated union の literal 制約)
            //   - warnings:[AD_ASK_DENIED_BY_GATE] (consult は inline literal)
            //   - log 追加 field: intent:intent??null (consult は mode)
            //   - self-validation 経由 (Phase 1 skeleton パターン踏襲)
            fugueSpan.setAttribute('fugue.outcome', 'in_secure');
            void notifyAdmin({
              channelType: 'slack',
              agentGroupId: null,
              subject: 'gate.blocked (fugue)',
              body: `Fugue 経由の injection 疑い発話 (ask)。\nlayer: ${gateResult.layerHit}\nreason: ${gateResult.reason}\nrequest_id: ${request_id}`,
            }).catch((err) =>
              log.warn('Fugue ask gate notifyAdmin unexpected throw', {
                event: 'fugue.ask.gate_notify_admin_throw',
                request_id,
                err: err instanceof Error ? err.message : String(err),
              }),
            );
            const processing_time_ms = Math.round(performance.now() - startedAt);
            log.warn('Fugue ask rejected by input gate', {
              event: 'fugue.ask.in_secure',
              channel: 'fugue',
              outcome: 'in_secure',
              request_id,
              intent: intent ?? null,
              gate_layer: gateResult.layerHit,
              gate_reason: gateResult.reason,
              processing_time_ms,
            });
            const deniedReply: FugueAskReplyT = {
              schema_version: '1',
              request_id,
              operation: 'ask',
              status: 'denied',
              summary: '入力に不審な内容が含まれる可能性があるため、この発話は処理できませんでした。',
              findings: [],
              sources: [],
              raw: { reason: 'in_secure', query, intent: intent ?? null },
              processing_time_ms,
              warnings: [AD_ASK_DENIED_BY_GATE],
            };
            // self-validation (Phase 1 skeleton パターン踏襲、silent contract violation を Fugue
            // 側に流さない)。fail 時は既存 errorReply 経路と同じ log.error emit + errorReply.warnings
            // に AD_ASK_DENIED_BY_GATE と self_validation_failed の両方を含める (denial 意図と bug
            // 両方が観測可能、plan Task 4 GOTCHA #4)。
            const validated = FugueAskReply.safeParse(deniedReply);
            if (!validated.success) {
              fugueSpan.setAttribute('fugue.outcome', 'error');
              log.error('Fugue ask denied reply self-validation failed', {
                event: 'fugue.ask.self_validation_failed',
                channel: 'fugue',
                outcome: 'failure',
                request_id,
                issues: validated.error.issues,
                processing_time_ms,
              });
              const errorReply: FugueAskReplyT = {
                schema_version: '1',
                request_id,
                operation: 'ask',
                status: 'error',
                summary: 'internal reply self-validation failed (biblio-claw bug, please report to biblio-claw team).',
                findings: [],
                sources: [],
                raw: {},
                processing_time_ms,
                warnings: [AD_ASK_DENIED_BY_GATE, 'self_validation_failed'],
              };
              writeJson(res, 200, errorReply);
              return;
            }
            writeJson(res, 200, validated.data);
            return;
          }
          // intent mismatch 判定 (Phase 2 新規設計、consult/equip に前例なし)。
          // ask endpoint は Layer 4 の biblio-other fallback を期待する経路 = biblio-other は
          // "期待分類"、biblio-adk は "期待外分類"。intent の 3 literal 値 (search-web /
          // drive-lookup / general) はいずれも「汎用 AI Agent 経路」を意味し、biblio-adk (ADK
          // 装備 skill 経路) とは意味論的に食い違う = intent literal 値によらず biblio-adk なら
          // mismatch。intent 未指定 (null/undefined) は「gate 完全委任」で常に一致扱い、warnings
          // なし。詳細は plan §判断 A 参照。
          if (intent && gateResult.classification === 'biblio-adk') {
            gateWarnings.push(INTENT_GATE_MISMATCH);
            log.info('Fugue ask intent-gate classification mismatch', {
              event: 'fugue.ask.intent_gate_mismatch',
              channel: 'fugue',
              request_id,
              intent,
              gate_classification: gateResult.classification,
              gate_layer: gateResult.layerHit,
              gate_reason: gateResult.reason,
            });
          }
        }
      }

      const processing_time_ms = Math.round(performance.now() - startedAt);
      const skeletonReply: FugueAskReplyT = {
        schema_version: '1',
        request_id,
        operation: 'ask',
        status: 'not_available',
        summary: 'Phase 1 skeleton response (backend not yet wired, see M4-H PRD Phase 3 for full implementation).',
        findings: [],
        sources: [],
        raw: {},
        processing_time_ms,
        warnings: ['skeleton_response', ...gateWarnings],
      };

      // self-validation (A3-2): 内部整合性 (discriminated union の status × payload 相関、field
      // 上限、型) を出荷前に検証。Phase 1 では固定 reply なので通常 success するが、Phase 3 で
      // summary 動的生成時に有用な安全網 (silent contract violation を Fugue 側に流さない)。
      const validated = FugueAskReply.safeParse(skeletonReply);
      if (!validated.success) {
        // 内部矛盾検知 = biblio-claw 側の bug。AD の本義契約: 5xx を出さず 200 + status:'error' +
        // warnings で運ぶ (Fugue 側 AD ラウンドの継続判断を阻害しない)。
        fugueSpan.setAttribute('fugue.outcome', 'error');
        log.error('Fugue ask internal reply self-validation failed', {
          event: 'fugue.ask.self_validation_failed',
          channel: 'fugue',
          outcome: 'failure',
          request_id,
          issues: validated.error.issues,
          processing_time_ms,
        });
        const errorReply: FugueAskReplyT = {
          schema_version: '1',
          request_id,
          operation: 'ask',
          status: 'error',
          summary: 'internal reply self-validation failed (biblio-claw bug, please report to biblio-claw team).',
          findings: [],
          sources: [],
          raw: {},
          processing_time_ms,
          warnings: ['skeleton_response', 'self_validation_failed'],
        };
        writeJson(res, 200, errorReply);
        return;
      }

      // Phase 1 skeleton は必ず not_available で応答 (validated.data.status === 'not_available')。
      // TODO(M4-H Phase 3): backend 結線後は status に応じて 'ok' / 'error' 等に分岐。
      fugueSpan.setAttribute('fugue.outcome', 'not_available');

      log.info('Fugue ask completed (skeleton)', {
        event: 'fugue.ask.completed',
        channel: 'fugue',
        outcome: 'not_available',
        request_id,
        intent: intent ?? null,
        // Phase 2 で追加: gateWarnings を含む最終 warnings を log に emit (BQ 集計から INTENT_GATE_MISMATCH
        // 発火頻度が拾える)。validated.data.warnings は skeletonReply.warnings と同値 (safeParse 成功時)。
        warnings: skeletonReply.warnings,
        processing_time_ms,
      });

      writeJson(res, 200, validated.data);
    });
  }
}
