/**
 * GitHub API 共通レイヤ — shelve.ts と unshelve.ts (= Phase 3 で追加) が両方使う raw fetch wrapper +
 * env 読み込み + marketplace.json fetch + commit 作成 helper を集約する。
 *
 * 切り出し方針 (Phase 3 Task 1):
 *   - `ghFetch` は OneCLI MITM 経由で Authorization を載せ、non-2xx は `GhHttpError` に変換
 *   - `fetchMarketplace` は marketplace.json を取得 (404 → null、それ以外は throw)
 *   - `pluginsOf` は plugins[] 配列を型保護して取り出す (= shelve の重複検知 + unshelve の entry 除去で共有)
 *   - `createCommit` は `POST /git/commits` の最小ラッパ (fallback author retry は呼び出し側で分岐)
 *   - `readShelveEnv` は棚リポ + author 情報の env を 1 箇所で読む (未設定は throw)
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
 * ghFetch の拡張オプション (= UndiciRequestInit と別軸の挙動制御)。
 *
 * `noAuth`: Authorization ヘッダを省略する。OneCLI secret の `pathPattern`
 * (`/repos/HajimariInc/*`) に match しない外部 repo (= biblio 仕入れ先の `anthropics/skills` 等)
 * を fetch するときに必須。pathPattern miss 時に `Bearer placeholder` を素通しすると GitHub が
 * invalid token として 401 を返すため (= public API は無認証で 200)、外部 repo 経路では本フラグ
 * を立てて Authorization 自体を省略する。内部 repo (= `HajimariInc/biblio-shelf`) 操作では未指定
 * (= 既存挙動 = MITM で token 置換) のままで OK。
 */
export interface GhFetchOptions {
  noAuth?: boolean;
}

export async function ghFetch(
  step: string,
  url: string,
  init: UndiciRequestInit = {},
  opts: GhFetchOptions = {},
): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    // OneCLI MITM が wire で本物の installation token に置換 (acquire.ts:gh CLI と同じ経路)。
    // 外部 repo (pathPattern miss) では `opts.noAuth: true` で Authorization 自体を省略する
    // (placeholder 素通しを防ぐ = 無認証で public API に 200 で抜ける)。
    ...(opts.noAuth ? {} : { Authorization: 'Bearer placeholder' }),
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(GH_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch (bodyErr) {
      log.warn('gh: failed to read error body', { step, status: res.status, bodyErr });
    }
    throw new GhHttpError(step, res.status, body);
  }
  return res.json();
}

export interface ShelfEnv {
  shelfOwner: string;
  shelfRepo: string;
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

/** shelf 経路に必要な env (棚リポ + author 情報) を読み、未設定はその場で throw (起動時に問題を即可視化)。 */
export function readShelveEnv(): ShelfEnv {
  const env = readEnvFile([
    'SHELF_REPO_OWNER',
    'SHELF_REPO_NAME',
    'SHELF_PR_AUTHOR_NAME',
    'SHELF_PR_AUTHOR_EMAIL',
    'SHELF_PR_AUTHOR_FALLBACK',
  ]);
  const missing: string[] = [];
  for (const k of ['SHELF_REPO_OWNER', 'SHELF_REPO_NAME', 'SHELF_PR_AUTHOR_NAME', 'SHELF_PR_AUTHOR_EMAIL'] as const) {
    if (!env[k]) missing.push(k);
  }
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
  env: ShelfEnv,
): Promise<{ raw: Record<string, unknown> | null; sha: string | null }> {
  const url = `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/contents/.claude-plugin/marketplace.json`;
  try {
    const data = (await ghFetch('GET contents/marketplace.json', url)) as {
      content?: string;
      encoding?: string;
      sha?: string;
    };
    if (typeof data.content !== 'string' || data.encoding !== 'base64') {
      throw new GhHttpError('GET contents/marketplace.json', 200, 'response missing content/encoding');
    }
    // GitHub の base64 は MIME 風に改行が入る可能性があるため Buffer.from で安全に decode する。
    const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(decoded) as Record<string, unknown>;
    } catch (err) {
      throw new GhHttpError(
        'GET contents/marketplace.json',
        200,
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
export async function createCommit(args: CommitArgs): Promise<{ sha: string }> {
  const { env, message, treeSha, parentSha, author } = args;
  const url = `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/git/commits`;
  const data = (await ghFetch('POST git/commits', url, {
    method: 'POST',
    body: JSON.stringify({
      message,
      tree: treeSha,
      parents: [parentSha],
      author,
      committer: author,
    }),
  })) as { sha?: string };
  if (typeof data.sha !== 'string') {
    throw new GhHttpError('POST git/commits', 200, 'response missing sha');
  }
  return { sha: data.sha };
}
