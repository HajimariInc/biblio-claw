/**
 * GitHub API 共通レイヤ — `shelve.ts` / `unshelve.ts` / `list-biblio.ts` / `acquire.ts` の
 * 全 GitHub API 経路が使う raw fetch wrapper + env 読み込み + marketplace.json fetch +
 * commit 作成 helper を集約する。
 *
 * 切り出し方針 (Phase 3 Task 1 で初出、その後 Phase 4 で list-biblio、PR #33 hotfix で
 * acquire の `ghFetch` 流用が追加されて 4 caller に拡張):
 *   - `ghFetch` は OneCLI MITM 経由で Authorization を載せ、non-2xx は `GhHttpError` に変換
 *   - `fetchMarketplace` は marketplace.json を取得 (404 → null、それ以外は throw)
 *   - `pluginsOf` は plugins[] 配列を型保護して取り出す (= shelve の重複検知 + unshelve の entry 除去で共有)
 *   - `createCommit` は `POST /git/commits` の最小ラッパ (fallback author retry は呼び出し側で分岐)
 *   - `readListEnv` は棚 owner/repo のみ (= list-biblio 等 read-only 経路、author env 不要)
 *   - `readShelveEnv` は棚リポ + author 情報の env を 1 箇所で読む (= shelve / unshelve など write 経路、未設定は throw)
 *
 * shelve.ts 固有 (= biblio dir 走査 / mergeMarketplace / commit message / PR body) は移さない。
 */
import { fetch } from 'undici';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';

/**
 * GitHub API base (= OneCLI host pattern と一致)。
 *
 * proxy 配線は `initHostProxy` が global undici dispatcher (= `setGlobalDispatcher`) に設定する
 * ProxyAgent で行う。`setupVertexProxy` も同 dispatcher を経由するため、CLI ハーネスでは
 * `initHostProxy()` + `setupVertexProxy()` の両方を起動時に呼んで GitHub fetch と Vertex
 * 呼び出しの両方を OneCLI MITM 経由にする (= `scripts/biblio-shelve.ts` 等と同パターン)。
 */
export const GITHUB_API = 'https://api.github.com';

/** 各 fetch のハードタイムアウト (ms)。無期限ブロックを防ぐ。 */
export const GH_FETCH_TIMEOUT_MS = 30_000;

/**
 * common fetch wrapper — OneCLI MITM 経由で Authorization を載せ、non-2xx は GhHttpError に変換。
 *
 * `RequestInit` は global (DOM 型) と undici-types の型が衝突するため、`undici` の `fetch`
 * から `Parameters<typeof fetch>[1]` で型を引っ張ることで undici-7 の RequestInit と一致させる。
 */
export type UndiciRequestInit = NonNullable<Parameters<typeof fetch>[1]>;

/**
 * 4xx/5xx の HTTP エラーを呼び出し側で識別するための例外型。
 * step 名 + status + body 抜粋を持ち、`github_api_error` の detail に再構成する。
 */
export class GhHttpError extends Error {
  constructor(
    public step: string,
    public status: number,
    public body: string,
  ) {
    super(`gh ${step}: ${status} — ${body.slice(0, 300)}`);
    this.name = 'GhHttpError';
  }
}

/**
 * marketplace.json の parse 失敗 (= HTTP 200 だが content 欠落 / decode 後 invalid JSON)
 * を `GhHttpError(200, ...)` の文脈不整合から分離するための例外型。
 *
 * 互換維持のため `extends GhHttpError` (= status=200 固定)。既存の caller が `instanceof
 * GhHttpError` で catch している経路 (`shelve.ts` / `unshelve.ts` / `list-biblio.ts`) は
 * 引き続き同経路で動く。新規 caller では `instanceof MarketplaceParseError` で別分岐
 * できる (= 「HTTP 200 なのに GitHub API エラー?」と読者を混乱させない設計、PR #37
 * review-agents silent-failure-hunter SH4 提案)。
 */
export class MarketplaceParseError extends GhHttpError {
  constructor(step: string, body: string) {
    super(step, 200, body);
    this.name = 'MarketplaceParseError';
  }
}

/**
 * ghFetch を呼ぶ全 caller が 1 patron 依頼を跨いで追跡するための文脈。
 */
export interface GhFetchCtx {
  requestId?: string;
  sessionId?: string;
}

export async function ghFetch(
  step: string,
  url: string,
  init: UndiciRequestInit = {},
  ctx?: GhFetchCtx,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    // OneCLI MITM が wire で本物の installation token に置換 (shelve / unshelve /
    // list-biblio / acquire 全 ghFetch 経路で共通)。OneCLI v1.30.0 の injection
    // 経路依存仕様は issue #36 で検証中。
    Authorization: 'Bearer placeholder',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const t0 = performance.now();
  const res = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(GH_FETCH_TIMEOUT_MS),
  });
  const latency_ms = Math.round(performance.now() - t0);

  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch (bodyErr) {
      // body 読み取り失敗時はマーカー文字列を入れる (= GhHttpError.body が caller の
      // detail 整形 (= `err.body.slice(0, 200)`) で空文字になりデバッグ不能になる罠を回避)。
      body = '(body read failed)';
      log.warn('gh: failed to read error body', { step, status: res.status, bodyErr });
    }
    const logData = {
      event: 'github.fetch',
      outcome: 'failure',
      step,
      status: res.status,
      latency_ms,
      error_body_preview: body.slice(0, 200),
      request_id: ctx?.requestId,
      session_id: ctx?.sessionId,
    };
    // 404 は呼び出し側で expected fallback として扱う経路 (fetchMarketplace 等) がある。
    // それ以外の non-2xx は warn で残す。
    if (res.status === 404) {
      log.debug('github.fetch failed', logData);
    } else {
      log.warn('github.fetch failed', logData);
    }
    throw new GhHttpError(step, res.status, body);
  }
  log.debug('github.fetch ok', {
    event: 'github.fetch',
    outcome: 'success',
    step,
    status: res.status,
    latency_ms,
    request_id: ctx?.requestId,
    session_id: ctx?.sessionId,
  });
  return res.json();
}

/**
 * read-only 経路 (list-biblio など) で必要な最小 env のみを保持する型。
 * `ShelfEnv` の subset (= 棚 owner/repo のみ)、author 情報は持たない。
 * shelve/unshelve 系の write 経路は引き続き `ShelfEnv` を要求する。
 */
export interface ListEnv {
  shelfOwner: string;
  shelfRepo: string;
}

export interface ShelfEnv extends ListEnv {
  authorName: string;
  authorEmail: string;
  /** PR commit author の fallback (`Name <email>` 形式、未設定なら null)。 */
  fallbackAuthor: { name: string; email: string } | null;
}

/** `Name <email>` 形式の文字列を `{ name, email }` に分解する。形式不正なら null。 */
function parseAuthorString(s: string): { name: string; email: string } | null {
  const m = s.trim().match(/^(.+?)\s*<([^>]+)>\s*$/);
  if (!m) return null;
  return { name: m[1].trim(), email: m[2].trim() };
}

/**
 * env キー定数 — 必須キー配列の逐語コピーを集約 (= `readListEnv` / `readShelveEnv` で 2 回登場)。
 * 将来キー追加時の修正箇所を 1 箇所に絞る (= PR #37 code-simplifier S3 提案)。
 *
 * `SHELVE_ENV_KEYS_REQUIRED` は `LIST_ENV_KEYS` + author 2 件で、`SHELF_PR_AUTHOR_FALLBACK`
 * は optional のため別配列。`readEnvFile` に渡す全キー集合は `[...SHELVE_ENV_KEYS_REQUIRED,
 * ...SHELVE_ENV_KEYS_OPTIONAL]`。
 */
const LIST_ENV_KEYS = ['SHELF_REPO_OWNER', 'SHELF_REPO_NAME'] as const;
const SHELVE_ENV_KEYS_REQUIRED = [...LIST_ENV_KEYS, 'SHELF_PR_AUTHOR_NAME', 'SHELF_PR_AUTHOR_EMAIL'] as const;
const SHELVE_ENV_KEYS_OPTIONAL = ['SHELF_PR_AUTHOR_FALLBACK'] as const;

/**
 * read-only 経路 (list-biblio など) に必要な棚 owner/repo のみを読む。
 * `readShelveEnv` の必須 env サブセット (= `SHELF_PR_AUTHOR_*` を要求しない) で、
 * `@bot 蔵書` のような書き込みを伴わない経路を author env 不在でも通すためにある。
 */
export function readListEnv(): ListEnv {
  const env = readEnvFile([...LIST_ENV_KEYS]);
  const missing = LIST_ENV_KEYS.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`list: required env missing: ${missing.join(', ')}`);
  }
  return {
    shelfOwner: env.SHELF_REPO_OWNER!,
    shelfRepo: env.SHELF_REPO_NAME!,
  };
}

/** shelf 経路に必要な env (棚リポ + author 情報) を読み、未設定はその場で throw (起動時に問題を即可視化)。 */
export function readShelveEnv(): ShelfEnv {
  const env = readEnvFile([...SHELVE_ENV_KEYS_REQUIRED, ...SHELVE_ENV_KEYS_OPTIONAL]);
  const missing = SHELVE_ENV_KEYS_REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`shelve: required env missing: ${missing.join(', ')}`);
  }
  const fallbackRaw = env.SHELF_PR_AUTHOR_FALLBACK?.trim();
  const fallbackAuthor = fallbackRaw ? parseAuthorString(fallbackRaw) : null;
  if (fallbackRaw && !fallbackAuthor) {
    log.warn('shelve: SHELF_PR_AUTHOR_FALLBACK is set but not in `Name <email>` format — ignoring', {
      raw: fallbackRaw,
    });
  }
  return {
    shelfOwner: env.SHELF_REPO_OWNER!,
    shelfRepo: env.SHELF_REPO_NAME!,
    authorName: env.SHELF_PR_AUTHOR_NAME!,
    authorEmail: env.SHELF_PR_AUTHOR_EMAIL!,
    fallbackAuthor,
  };
}

/** 既存 marketplace.json を取得する。404 なら null。それ以外の non-2xx は throw。 */
export async function fetchMarketplace(
  env: ListEnv,
  ctx?: GhFetchCtx,
): Promise<{ raw: Record<string, unknown> | null; sha: string | null }> {
  const url = `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/contents/.claude-plugin/marketplace.json`;
  try {
    const data = (await ghFetch('GET contents/marketplace.json', url, {}, ctx)) as {
      content?: string;
      encoding?: string;
      sha?: string;
    };
    if (typeof data.content !== 'string' || data.encoding !== 'base64') {
      // HTTP 200 だが content 欠落 = parse 失敗。GhHttpError(200) より MarketplaceParseError
      // のほうが「HTTP 200 なのに API エラー?」と読者を混乱させない (= SH4)。
      throw new MarketplaceParseError('GET contents/marketplace.json', 'response missing content/encoding');
    }
    // GitHub の base64 は MIME 風に改行が入る可能性があるため Buffer.from で安全に decode する。
    const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(decoded) as Record<string, unknown>;
    } catch (err) {
      throw new MarketplaceParseError(
        'GET contents/marketplace.json',
        `existing marketplace.json is invalid JSON: ${err instanceof Error ? err.message : err}`,
      );
    }
    return { raw: parsed, sha: data.sha ?? null };
  } catch (err) {
    if (err instanceof GhHttpError && err.status === 404) {
      return { raw: null, sha: null };
    }
    throw err;
  }
}

/** marketplace.json の plugins[] 配列を取り出す (型保護)。non-array は空配列扱い。 */
export function pluginsOf(marketplace: Record<string, unknown>): Array<Record<string, unknown>> {
  const v = marketplace.plugins;
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

export interface CommitArgs {
  env: ShelfEnv;
  message: string;
  treeSha: string;
  parentSha: string;
  /** 第一希望 (= GH App identity) で失敗したら fallbackAuthor で 1 回だけ retry。 */
  author: { name: string; email: string };
}

/** `POST /git/commits` を 1 author で叩く (PAT fallback は呼び出し側で分岐)。 */
export async function createCommit(args: CommitArgs, ctx?: GhFetchCtx): Promise<{ sha: string }> {
  const { env, message, treeSha, parentSha, author } = args;
  const url = `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/git/commits`;
  const data = (await ghFetch(
    'POST git/commits',
    url,
    {
      method: 'POST',
      body: JSON.stringify({
        message,
        tree: treeSha,
        parents: [parentSha],
        author,
        committer: author,
      }),
    },
    ctx,
  )) as { sha?: string };
  if (typeof data.sha !== 'string') {
    throw new GhHttpError('POST git/commits', 200, 'response missing sha');
  }
  return { sha: data.sha };
}
