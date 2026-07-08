/**
 * 解除 (unshelve) 本体 — 棚 (shelf) repo から `<category>/<biblioName>/` 配下と
 * `.claude-plugin/marketplace.json` の plugins[] entry を **`sha:null + base_tree`** で
 * 削除する draft PR を作る。`shelve()` と対称、throw しない (= 失敗は `UnshelveResult.ok=false` で返す)。
 *
 * 経路 (Phase 3 Task 2、PRD §3.4.4 「禁書 = clone 残置 / 焼却 = clone 物理削除」を実現):
 *
 * **HTTP API 呼び出しは計 11 本** (= 早期 return 判定 1 本 + ステップ 2 で ref/commit を 2 本束ねる
 * 構成で論理 10 ステップ表記)。
 *
 *   1.  marketplace.json (contents API) → 404 / plugins[] に entry なし → `not_shelved` 早期 return
 *   2a. GET /git/ref/heads/main → baseCommitSha
 *   2b. GET /git/commits/{baseCommitSha} → baseTreeSha
 *   3.  GET /git/trees/{baseTreeSha} (root) → `<category>` entry の sha を取得
 *   4.  GET /git/trees/{categoryTreeSha} → `<biblioName>` entry の sha を取得 (= biblio dir tree)
 *   5.  GET /git/trees/{biblioDirTreeSha}?recursive=1 → 配下全 blob path を列挙
 *   6.  POST /git/blobs (= entry 除去版 marketplace.json) → newMarketplaceBlobSha
 *   7.  POST /git/trees { base_tree: baseTreeSha, tree: [..sha:null × N, marketplace blob] } → newTreeSha
 *   8.  POST /git/commits → newCommitSha (PAT fallback 対応)
 *   9.  POST /git/refs { ref: refs/heads/<prefix>/<cat>--<name>-<ts>, sha }
 *  10.  POST /pulls { draft: true } → prUrl + prNumber
 *
 * GOTCHA (web-researcher 調査結果、plan Must-Reads):
 *   - `base_tree` を **絶対に省かない** (= GitHub Community Discussion #24420、省くと全消し semantics)
 *   - `sha: null` は **`blob` 型として実在する** path のみ並べる。tree (dir) 型 entry は base_tree
 *     から自動的に消える (= 配下 blob を全削除すれば dir も消える) ため除外不要、余分に渡すと 422。
 *     存在しない path を sha:null で渡すと 400。
 *   - GET trees の `truncated: true` 応答は biblio dir 単位なら実務上不発、念のため warn のみで継続
 *   - branch ref は `refs/heads/` プレフィックス必須 (= shelve.ts GOTCHA-5 と同じ)
 *
 * PRD §意思決定ログ「棚リポ PR の commit author 表記」:
 *   shelve.ts と同じ流儀 — GH App identity 第一希望、4xx 倒れたら `SHELF_PR_AUTHOR_FALLBACK` で 1 回 retry。
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { log } from '../log.js';
import {
  GITHUB_API,
  GhHttpError,
  createCommit,
  fetchMarketplace,
  ghFetch,
  pluginsOf,
  readShelveEnv,
  type GhFetchCtx,
  type ShelfEnv,
} from './shelf-gh.js';
import type { BiblioCategory, UnshelveFailureReason, UnshelveResult } from './types.js';

/**
 * rate limit (secondary) 防御 — 連続 GET 5 本 (ref/commit/root/category/dir) の間に 3 箇所スリープを挟む。
 * 1 PR 1 blob しか作らないので shelve (GH_BLOB_SLEEP_MS=1000ms × N blob) より緩い。
 */
const GH_GET_SLEEP_MS = 100;

export interface UnshelveRequest {
  biblioName: string;
  category: BiblioCategory;
  /** commit message + PR title の op label (例: '禁書' / '焼却')。enkin/shokyaku ラッパが指定。 */
  opLabel: string;
  /** branch 名 prefix (例: 'enkin' / 'shokyaku' / 'unshelve')。enkin/shokyaku ラッパが指定。 */
  branchPrefix: string;
}

/** `ok: false` の組み立てヘルパ。 */
function fail(biblioName: string, reason: UnshelveFailureReason, detail: string): UnshelveResult {
  return { ok: false, biblioName, reason, detail };
}

/** タイムスタンプ suffix (= branch 名の uniqueness 確保、verify を繰り返しても 422 reference already exists に倒れない)。 */
function timestampSuffix(): string {
  // ISO 8601 → '2026-06-21T20-30-45Z' (Git ref に使えない文字を `-` に置換)。
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** branch 名 (`<prefix>/<category>--<biblioName>-<ts>`)。GOTCHA: `refs/heads/` プレフィックスは呼び出し側で付ける。 */
function branchNameFor(prefix: string, category: BiblioCategory, biblioName: string): string {
  return `${prefix}/${category}--${biblioName}-${timestampSuffix()}`;
}

/** entry 除去版 marketplace.json を作る (元 dict は変更しない)。 */
function removeFromMarketplace(marketplace: Record<string, unknown>, biblioName: string): Record<string, unknown> {
  const next = { ...marketplace, plugins: pluginsOf(marketplace).filter((entry) => entry.name !== biblioName) };
  return next;
}

/** commit message (本文 → 空行 → Co-Authored-By trailer)。 */
function buildCommitMessage(opLabel: string, category: BiblioCategory, biblioName: string): string {
  return (
    `chore(${category}): ${opLabel} ${biblioName}\n\n` +
    `カテゴリ: ${category}\n` +
    `operation: ${opLabel}\n\n` +
    `Co-Authored-By: Claude (Sonnet 4.6 on Vertex) <noreply@anthropic.com>\n`
  );
}

/** PR body (人間が眺めて何の biblio か即わかる程度の情報量)。 */
function buildPrBody(opLabel: string, category: BiblioCategory, biblioName: string): string {
  return (
    `## 解除対象\n` +
    `- biblio: \`${biblioName}\`\n` +
    `- category: \`${category}\`\n` +
    `- operation: **${opLabel}**\n\n` +
    `## merge 前に確認\n` +
    `- [ ] ${biblioName} を本当に棚から外していいか (= 残置 vs 物理削除は biblio-claw 側で完了済、本 PR は marketplace.json + 配下ファイルの削除のみ)\n` +
    `- [ ] \`marketplace.json\` の plugins[] から \`${biblioName}\` entry が消えている\n` +
    `- [ ] \`${category}/${biblioName}/\` 配下のファイルが全て削除されている\n\n` +
    `> このリクエストは biblio-claw 司書が admin 承認のもと自動生成しました。\n` +
    `> Co-Authored-By: Claude (Sonnet 4.6 on Vertex) <noreply@anthropic.com>\n`
  );
}

/**
 * `GET /git/trees/{sha}` を recursive flag 付きで叩く。
 *
 * `truncated: true` (= GitHub の上限 100k entries / 7MB 超過) は biblio dir 1 件単位では実務上発生しないが、
 * 起きたら warn ログに残す (= 削除漏れの可視化、silent failure 防止)。
 */
async function fetchTree(
  env: ShelfEnv,
  sha: string,
  recursive: boolean,
  ctx?: GhFetchCtx,
): Promise<{ tree: Array<{ path: string; mode: string; type: string; sha: string }>; truncated: boolean }> {
  const url = `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`;
  const step = `GET git/trees/${sha.slice(0, 7)}${recursive ? ' (recursive)' : ''}`;
  const data = (await ghFetch(step, url, {}, { ctx })) as {
    tree?: Array<{ path?: string; mode?: string; type?: string; sha?: string }>;
    truncated?: boolean;
  };
  if (!Array.isArray(data.tree)) {
    throw new GhHttpError(step, 200, 'response missing tree[]');
  }
  const tree = data.tree.filter((e): e is { path: string; mode: string; type: string; sha: string } => {
    return (
      typeof e.path === 'string' &&
      typeof e.mode === 'string' &&
      typeof e.type === 'string' &&
      typeof e.sha === 'string'
    );
  });
  return { tree, truncated: data.truncated === true };
}

/**
 * 解除本体 (throw しない、失敗は UnshelveResult.ok=false で返す)。
 *
 * @param req biblioName / category / opLabel / branchPrefix
 */
export async function unshelve(req: UnshelveRequest, opts: { ctx?: GhFetchCtx } = {}): Promise<UnshelveResult> {
  const { biblioName, category, opLabel, branchPrefix } = req;
  const ctx = opts.ctx;

  let env: ShelfEnv;
  try {
    env = readShelveEnv();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('unshelve: env not ready', {
      event: 'biblio.unshelve',
      outcome: 'config_error',
      biblioName,
      detail,
      request_id: ctx?.requestId,
      session_id: ctx?.sessionId,
    });
    return fail(biblioName, 'config_error', detail);
  }

  // 1. marketplace.json 取得 + entry 存在チェック
  let marketplace: Record<string, unknown>;
  try {
    const fetched = await fetchMarketplace(env, ctx);
    if (!fetched.raw) {
      log.info('unshelve: marketplace.json 不在 (= not_shelved 早期 return)', { biblioName });
      return fail(biblioName, 'not_shelved', `marketplace.json が棚に存在しません (= 既に解除済 / 元から不在)`);
    }
    if (!pluginsOf(fetched.raw).some((entry) => entry.name === biblioName)) {
      log.info('unshelve: plugins[] に entry なし (= not_shelved 早期 return)', { biblioName });
      return fail(
        biblioName,
        'not_shelved',
        `marketplace.json の plugins[] に entry が見つかりません: ${biblioName} (= 既に解除済 / 元から不在)`,
      );
    }
    marketplace = fetched.raw;
  } catch (err) {
    if (err instanceof GhHttpError) {
      log.warn('unshelve: fetch marketplace failed', { biblioName, step: err.step, status: err.status });
      return fail(
        biblioName,
        'github_api_error',
        `step=${err.step}, status=${err.status}, body=${err.body.slice(0, 200)}`,
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('unshelve: fetch marketplace threw', { biblioName, detail });
    return fail(biblioName, 'github_api_error', `step=GET contents/marketplace.json, detail=${detail}`);
  }

  // 2-10. Git Data API + Pulls API
  try {
    // 2. baseCommitSha + baseTreeSha
    const refData = (await ghFetch(
      'GET git/ref/heads/main',
      `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/git/ref/heads/main`,
      {},
      { ctx },
    )) as { object?: { sha?: string } };
    const baseCommitSha = refData.object?.sha;
    if (!baseCommitSha) throw new GhHttpError('GET git/ref/heads/main', 200, 'response missing object.sha');

    const commitData = (await ghFetch(
      'GET git/commits/{base}',
      `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/git/commits/${baseCommitSha}`,
      {},
      { ctx },
    )) as { tree?: { sha?: string } };
    const baseTreeSha = commitData.tree?.sha;
    if (!baseTreeSha) throw new GhHttpError('GET git/commits/{base}', 200, 'response missing tree.sha');

    await sleep(GH_GET_SLEEP_MS);

    // 3. root tree → category entry の sha
    const rootTree = await fetchTree(env, baseTreeSha, false, ctx);
    const categoryEntry = rootTree.tree.find((e) => e.path === category && e.type === 'tree');
    if (!categoryEntry) {
      log.info('unshelve: root tree に category entry なし (= not_shelved 早期 return)', { biblioName, category });
      return fail(
        biblioName,
        'not_shelved',
        `shelf 直下に "${category}" dir が存在しません (= 既に解除済 / 元から不在)`,
      );
    }

    await sleep(GH_GET_SLEEP_MS);

    // 4. category tree → biblioName entry の sha
    const categoryTree = await fetchTree(env, categoryEntry.sha, false, ctx);
    const biblioDirEntry = categoryTree.tree.find((e) => e.path === biblioName && e.type === 'tree');
    if (!biblioDirEntry) {
      log.info('unshelve: category tree に biblio dir なし (= not_shelved 早期 return)', { biblioName, category });
      return fail(
        biblioName,
        'not_shelved',
        `${category}/${biblioName}/ dir が shelf に存在しません (= 既に解除済 / 元から不在)`,
      );
    }

    await sleep(GH_GET_SLEEP_MS);

    // 5. biblio dir tree (recursive) → 配下全 blob path
    const biblioDirTree = await fetchTree(env, biblioDirEntry.sha, true, ctx);
    if (biblioDirTree.truncated) {
      log.warn('unshelve: biblio dir tree truncated (削除漏れの可能性)', {
        biblioName,
        category,
        entries: biblioDirTree.tree.length,
      });
    }
    const blobPaths = biblioDirTree.tree
      .filter((e) => e.type === 'blob')
      .map((e) => `${category}/${biblioName}/${e.path}`);
    if (blobPaths.length === 0) {
      // 念のため早期 return (= 存在しない path で sha:null を送ると 400)。
      log.warn('unshelve: biblio dir に blob が 1 件もない (= 削除対象なし)', { biblioName, category });
      return fail(biblioName, 'not_shelved', `${category}/${biblioName}/ 配下に blob がありません`);
    }

    // 6. entry 除去版 marketplace.json を blob で投入
    const newMarketplace = removeFromMarketplace(marketplace, biblioName);
    const marketplaceContent = `${JSON.stringify(newMarketplace, null, 2)}\n`;
    const mpBlobData = (await ghFetch(
      'POST git/blobs (marketplace)',
      `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/git/blobs`,
      {
        method: 'POST',
        body: JSON.stringify({ content: marketplaceContent, encoding: 'utf-8' }),
      },
      { ctx },
    )) as { sha?: string };
    if (typeof mpBlobData.sha !== 'string') {
      throw new GhHttpError('POST git/blobs (marketplace)', 200, 'response missing sha');
    }

    // 7. 削除 tree 組み立て (GOTCHA: base_tree 必須、sha:null は存在 path のみ)
    const treeEntries: Array<{ path: string; mode: string; type: 'blob'; sha: string | null }> = [
      ...blobPaths.map((p) => ({ path: p, mode: '100644', type: 'blob' as const, sha: null })),
      { path: '.claude-plugin/marketplace.json', mode: '100644', type: 'blob', sha: mpBlobData.sha },
    ];
    const treeRes = (await ghFetch(
      'POST git/trees',
      `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/git/trees`,
      {
        method: 'POST',
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
      },
      { ctx },
    )) as { sha?: string };
    if (typeof treeRes.sha !== 'string') throw new GhHttpError('POST git/trees', 200, 'response missing sha');

    // 8. commit 作成 (GH App identity → 4xx 時のみ PAT fallback 1 回)
    const message = buildCommitMessage(opLabel, category, biblioName);
    let commitSha: string;
    try {
      const r = await createCommit(
        {
          env,
          message,
          treeSha: treeRes.sha,
          parentSha: baseCommitSha,
          author: { name: env.authorName, email: env.authorEmail },
        },
        ctx,
      );
      commitSha = r.sha;
    } catch (err) {
      if (err instanceof GhHttpError && err.status >= 400 && err.status < 500 && env.fallbackAuthor) {
        log.warn('unshelve: commit failed with GH App identity, retrying with fallback author', {
          biblioName,
          status: err.status,
          bodyPreview: err.body.slice(0, 200),
        });
        const r = await createCommit(
          {
            env,
            message,
            treeSha: treeRes.sha,
            parentSha: baseCommitSha,
            author: env.fallbackAuthor,
          },
          ctx,
        );
        commitSha = r.sha;
      } else {
        throw err;
      }
    }

    // 9. branch 作成 (GOTCHA: refs/heads/ プレフィックス必須)
    const branchName = branchNameFor(branchPrefix, category, biblioName);
    await ghFetch(
      'POST git/refs',
      `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/git/refs`,
      {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: commitSha }),
      },
      { ctx },
    );

    // 10. draft PR 作成
    const prData = (await ghFetch(
      'POST pulls',
      `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/pulls`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: `${opLabel}(${category}): ${biblioName}`,
          head: branchName,
          base: 'main',
          body: buildPrBody(opLabel, category, biblioName),
          draft: true,
        }),
      },
      { ctx },
    )) as { html_url?: string; number?: number };
    if (typeof prData.html_url !== 'string' || typeof prData.number !== 'number') {
      throw new GhHttpError('POST pulls', 200, 'response missing html_url/number');
    }

    log.info('unshelve: ok', {
      biblioName,
      category,
      opLabel,
      branchName,
      prNumber: prData.number,
      prUrl: prData.html_url,
    });
    return {
      ok: true,
      biblioName,
      category,
      prUrl: prData.html_url,
      prNumber: prData.number,
      branchName,
    };
  } catch (err) {
    if (err instanceof GhHttpError) {
      log.warn('unshelve: github api step failed', { biblioName, step: err.step, status: err.status });
      return fail(
        biblioName,
        'github_api_error',
        `step=${err.step}, status=${err.status}, body=${err.body.slice(0, 200)}`,
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('unshelve: github api step threw (non-http)', { biblioName, detail });
    return fail(biblioName, 'github_api_error', `non-http error: ${detail}`);
  }
}
