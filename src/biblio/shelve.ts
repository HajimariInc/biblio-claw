/**
 * 陳列本体 — quarantine の biblio を shelf に物理移動し、棚リポへ feature branch + draft PR を作成する。
 *
 * 経路 (PRD B §技術アプローチ / §解決策の詳細):
 *   1. 重複検知 — GET /repos/{shelf}/contents/.claude-plugin/marketplace.json
 *      - 200 → base64 decode → JSON parse → plugins[].name で `biblioName` を照合 (key = `<owner>--<name>`)
 *      - 404 → 初回 = 空 plugins[] で初期化 (PoC-6 schema 準拠で marketplace を組む)
 *      - その他 (4xx/5xx) → github_api_error
 *   2. 物理移動 — fs.promises.rename(quarantine, shelf/<category>/<biblioName>)
 *      - 親 dir は mkdir -p、quarantine 不在は quarantine_missing、rename throw は rename_error
 *   3. shelf 内ファイル列挙 + marketplace.json entry 追記 (= GitHub API 送信前の準備)
 *      - MAX_BLOBS_PER_PR 超過 / shelf 内 0 ファイル / バイナリ検出 → github_api_error (fail-closed)
 *   4. GitHub Git Data API + Pulls API — fetch 直叩き (ProxyAgent 経由、OneCLI MITM が Authorization 注入)
 *      (a) GET /git/ref/heads/main + GET /git/commits/{sha} → base commit / tree sha
 *      (b) POST /git/blobs (per file) → 全 shelf ファイル + 更新後 marketplace.json
 *      (c) POST /git/trees { base_tree, tree: [{path, mode:100644, type:blob, sha}] }
 *      (d) POST /git/commits { message, tree, parents, author, committer }
 *      (e) POST /git/refs { ref: refs/heads/shelve/<cat>--<biblio>, sha }
 *      (f) POST /pulls { title, head, base: main, body, draft: true }
 *   5. 失敗分類 (silent failure 禁止) — catch 内で non-2xx を step + status + body 抜粋に再構成、
 *      rename 完了後 (= step 4 内) の失敗時は shelf 残骸の存在を warn で必ず可視化する
 *
 * GOTCHA (plan §Must-Reads):
 *   - GOTCHA-3 は Anthropic response 構造、本ファイルでは GitHub API なので無関係
 *   - GOTCHA-5: branch ref は `refs/heads/...` プレフィックス必須
 *   - GOTCHA-6: tree entry に `sha` を渡したら `content` を一緒に渡してはならない
 *   - GOTCHA-7: commit message の Co-Authored-By trailer は本文 → 空行 → trailer の順
 *
 * PRD §意思決定ログ「棚リポ PR の commit author 表記」:
 *   GH App identity (`SHELF_PR_AUTHOR_NAME` / `_EMAIL`) を第一希望。`POST /git/commits` が 4xx に
 *   倒れた場合のみ `SHELF_PR_AUTHOR_FALLBACK` (`Name <email>` 形式) で 1 回だけ retry する
 *   (= 不都合判明時に DEN さん名義 PAT に手動切替できる経路を残す)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import {
  GITHUB_API,
  GhHttpError,
  createCommit,
  fetchMarketplace,
  pluginsOf,
  readShelveEnv,
  ghFetch,
  type GhFetchCtx,
  type ShelfEnv,
} from './shelf-gh.js';
import type { BiblioCategory, ShelveFailureReason, ShelveResult } from './types.js';

/**
 * rate limit (secondary) 防御 — blob 作成 1 件ごとの sleep。
 *
 * GitHub secondary rate limit: content-generating 系エンドポイント (= `POST /git/blobs` 等)
 * は **80 req/min** が上限 (= 理論最小 750ms/req)。1000ms (= 60 req/min) で上限の 25% 未満
 * に収め、MAX_BLOBS_PER_PR=100 の場合でも約 100 秒で完了する余裕を持つ。
 *
 * 旧 200ms (= 300 req/min) は 80 req/min を 3.75 倍超過する設定で、実 biblio (数十ファイル)
 * で本番 429 を踏むリスクがあったため Phase 3 PR レビューで訂正済 (2026-06-20)。
 *
 * 参考: docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api §「Secondary rate limits」
 */
const GH_BLOB_SLEEP_MS = 1_000;

/** shelf 内の再帰列挙の上限 (acquire/inspect/categorize と同値、暴走防止)。 */
const SHELF_SCAN_MAX_DEPTH = 6;

/** 1 PR で送る blob の上限 (= 棚 1 件の biblio として現実的な範囲)。M3 で再判断。 */
const MAX_BLOBS_PER_PR = 100;

/** GitHub branch 名の suffix 形式 (`shelve/<cat>--<biblioName>`)。GOTCHA-5 で `refs/heads/` プレフィックスを後で付ける。 */
function branchNameFor(category: BiblioCategory, biblioName: string): string {
  return `shelve/${category}--${biblioName}`;
}

/** `ok: false` の組み立てヘルパ (型エラー回避 + 重複削減)。 */
function fail(biblioName: string, reason: ShelveFailureReason, detail: string): ShelveResult {
  return { ok: false, biblioName, reason, detail };
}

/** 初回 commit 用の最小 marketplace.json (PoC-6 schema 踏襲)。 */
function newMarketplace(env: ShelfEnv): Record<string, unknown> {
  return {
    name: 'biblio-shelf',
    owner: { name: env.shelfOwner, email: env.authorEmail },
    description: 'biblio-shelf: AI Agent 向けの biblio (skill plugin) を展示・配布する本棚 marketplace',
    plugins: [],
  };
}

/** plugin entry の name = biblioName (`<owner>--<name>`) が既存 plugins[] に含まれるかチェック。 */
function isAlreadyShelved(marketplace: Record<string, unknown>, biblioName: string): boolean {
  return pluginsOf(marketplace).some((entry) => entry.name === biblioName);
}

/** plugin.json から description / version を読む (失敗時は既定値)。 */
function readPluginMeta(shelfPath: string): { description: string; version: string } {
  const p = path.join(shelfPath, '.claude-plugin', 'plugin.json');
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch {
    return { description: '', version: '0.0.0' };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { description: '', version: '0.0.0' };
  }
  return {
    description: typeof parsed.description === 'string' ? parsed.description : '',
    version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
  };
}

/**
 * shelf dir 配下の全ファイルを `<rel>` 相対パスで列挙する (`.git` 除外、深さ制限)。
 *
 * 戻り値の `ioErrorCount` は読み取り失敗 (EACCES / EMFILE 等) を集計する。サブ dir 1 つだけが
 * EACCES でも `files` は他のサブ dir 由来で **非ゼロのまま縮退する** = 「ファイルセット
 * 欠落でも長さが 0 にならない」silent skip を防ぐため、呼び出し側で `ioErrorCount > 0` の
 * 時点で fail-closed に倒す前提。
 */
function listShelfFiles(
  shelfPath: string,
  depth = 0,
  prefix = '',
): { files: Array<{ rel: string; abs: string }>; ioErrorCount: number } {
  if (depth > SHELF_SCAN_MAX_DEPTH) return { files: [], ioErrorCount: 0 };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(shelfPath, { withFileTypes: true });
  } catch (err) {
    log.warn('shelve: directory unreadable during list', { shelfPath, depth, err });
    return { files: [], ioErrorCount: 1 };
  }
  const files: Array<{ rel: string; abs: string }> = [];
  let ioErrorCount = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const nextAbs = path.join(shelfPath, entry.name);
      const nextRel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const sub = listShelfFiles(nextAbs, depth + 1, nextRel);
      files.push(...sub.files);
      ioErrorCount += sub.ioErrorCount;
    } else if (entry.isFile()) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      files.push({ rel, abs: path.join(shelfPath, entry.name) });
    }
  }
  return { files, ioErrorCount };
}

/** commit message を組む (GOTCHA-7: 本文 → 空行 → Co-Authored-By)。 */
function buildCommitMessage(biblioName: string, category: BiblioCategory, reason: string): string {
  return (
    `feat(${category}): shelve ${biblioName}\n\n` +
    `カテゴリ判定: ${category}\n` +
    `理由: ${reason}\n\n` +
    `Co-Authored-By: Claude (Sonnet 4.6 on Vertex) <noreply@anthropic.com>\n`
  );
}

/** PR body を組む (人間が眺めて何の biblio か即わかる程度の情報量)。 */
function buildPrBody(biblioName: string, category: BiblioCategory, reason: string): string {
  const [owner, repo] = biblioName.split('--');
  return (
    `## 陳列対象\n` +
    `- biblio: \`${biblioName}\`\n` +
    `- category: \`${category}\`\n` +
    `- 仕入れ元: https://github.com/${owner}/${repo}\n\n` +
    `## カテゴライズ判定理由\n` +
    `${reason}\n\n` +
    `## merge 前に確認\n` +
    `- [ ] biblio が棚 namespace 4 値の意味合いに沿っているか\n` +
    `- [ ] \`marketplace.json\` の entry が valid (= \`name\` / \`source\` / \`version\`)\n` +
    `- [ ] biblio ファイル群 (SKILL.md / plugin.json) が棚 root から正しい相対パスに配置されている\n\n` +
    `> このリクエストは biblio-claw 司書が patron (DEN) 承認のもと自動生成しました。\n` +
    `> Co-Authored-By: Claude (Sonnet 4.6 on Vertex) <noreply@anthropic.com>\n`
  );
}

/** 既存 marketplace に新しい entry を追加した dict を返す (元 dict は変更しない)。 */
function mergeMarketplace(
  marketplace: Record<string, unknown>,
  entry: { name: string; source: string; description: string; version: string },
): Record<string, unknown> {
  const next = { ...marketplace, plugins: [...pluginsOf(marketplace), entry] };
  return next;
}

/**
 * 陳列本体 (throw しない、失敗は ShelveResult.ok=false で返す)。
 *
 * @param req biblioName (`<owner>--<name>`) / category / reason (categorize の結果を渡す)
 * @param opts quarantineRoot / shelfRoot をテスト/verify 用に上書き可能 (既定は `${DATA_DIR}/{quarantine,shelf}`)
 */
export async function shelve(
  req: { biblioName: string; category: BiblioCategory; reason: string },
  opts: { quarantineRoot?: string; shelfRoot?: string; ctx?: GhFetchCtx } = {},
): Promise<ShelveResult> {
  const ctx = opts.ctx;
  const { biblioName, category, reason } = req;
  const quarantineRoot = opts.quarantineRoot ?? path.join(DATA_DIR, 'quarantine');
  const shelfRoot = opts.shelfRoot ?? path.join(DATA_DIR, 'shelf');
  const quarantinePath = path.join(quarantineRoot, biblioName);
  const shelfPath = path.join(shelfRoot, category, biblioName);

  let env: ShelfEnv;
  try {
    env = readShelveEnv();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('shelve: env not ready', { biblioName, detail });
    return fail(biblioName, 'github_api_error', detail);
  }

  // 1. 重複検知 (marketplace.json 事前読み)
  let marketplace: Record<string, unknown>;
  try {
    const fetched = await fetchMarketplace(env, ctx);
    if (fetched.raw && isAlreadyShelved(fetched.raw, biblioName)) {
      log.info('shelve: already shelved (early return)', { biblioName, category });
      return fail(biblioName, 'already_shelved', `marketplace.json に同 name の entry が既存: ${biblioName}`);
    }
    marketplace = fetched.raw ?? newMarketplace(env);
  } catch (err) {
    if (err instanceof GhHttpError) {
      log.warn('shelve: fetch marketplace failed', { biblioName, step: err.step, status: err.status });
      return fail(
        biblioName,
        'github_api_error',
        `step=${err.step}, status=${err.status}, body=${err.body.slice(0, 200)}`,
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('shelve: fetch marketplace threw', { biblioName, detail });
    return fail(biblioName, 'github_api_error', `step=GET contents/marketplace.json, detail=${detail}`);
  }

  // 2. 物理移動 (quarantine → shelf)
  if (!fs.existsSync(quarantinePath)) {
    log.warn('shelve: quarantine missing', { biblioName, quarantinePath });
    return fail(biblioName, 'quarantine_missing', `quarantine 配下に biblio が存在しません: ${quarantinePath}`);
  }
  try {
    fs.mkdirSync(path.dirname(shelfPath), { recursive: true });
    // shelfPath が既に存在する場合 (= 過去の中断で残骸あり) は事前に除去 (silent failure 防止)。
    if (fs.existsSync(shelfPath)) {
      fs.rmSync(shelfPath, { recursive: true, force: true });
    }
    await fs.promises.rename(quarantinePath, shelfPath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('shelve: rename failed', { biblioName, quarantinePath, shelfPath, detail });
    return fail(biblioName, 'rename_error', `quarantine → shelf 移動に失敗: ${detail}`);
  }

  // 3. shelf 内ファイル列挙 + marketplace entry 追記
  const { files, ioErrorCount } = listShelfFiles(shelfPath);
  if (ioErrorCount > 0) {
    // サブ dir 1 つでも読めない = ファイルセットが silent に欠落した状態で棚 PR を作る危険。
    // listShelfFiles 内で warn 済だが、ここで fail-closed に倒して draft PR が無音で作られる
    // 経路を遮断する (PR #8 レビュー silent-failure-hunter Important #2 対応)。
    log.warn('shelve: shelf dir scan had I/O errors — fail-closed', { biblioName, shelfPath, ioErrorCount });
    return fail(
      biblioName,
      'github_api_error',
      `shelf dir 走査中に ${ioErrorCount} 件の読み取りエラー (権限 / FD 枯渇) が発生したため陳列を中止しました。shelfPath=${shelfPath}`,
    );
  }
  if (files.length === 0) {
    log.warn('shelve: shelf dir has no files after rename — fail-closed', { biblioName, shelfPath });
    return fail(biblioName, 'github_api_error', `shelf dir 内にファイルが一切ありません: ${shelfPath}`);
  }
  if (files.length > MAX_BLOBS_PER_PR) {
    log.warn('shelve: too many files in shelf dir — exceeds MAX_BLOBS_PER_PR limit', {
      biblioName,
      count: files.length,
      limit: MAX_BLOBS_PER_PR,
    });
    return fail(
      biblioName,
      'github_api_error',
      `1 PR で送れるファイル数 (${MAX_BLOBS_PER_PR}) を超えています (${files.length} 件)`,
    );
  }
  const meta = readPluginMeta(shelfPath);
  const updatedMarketplace = mergeMarketplace(marketplace, {
    name: biblioName,
    source: `./${category}/${biblioName}`,
    description: meta.description,
    version: meta.version,
  });

  // 4. GitHub Git Data API + Pulls API
  try {
    // 4a. base SHA + tree SHA 取得
    const refData = (await ghFetch(
      'GET git/ref/heads/main',
      `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/git/ref/heads/main`,
      {},
      ctx,
    )) as { object?: { sha?: string } };
    const baseCommitSha = refData.object?.sha;
    if (!baseCommitSha) throw new GhHttpError('GET git/ref/heads/main', 200, 'response missing object.sha');

    const commitData = (await ghFetch(
      'GET git/commits/{base}',
      `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/git/commits/${baseCommitSha}`,
      {},
      ctx,
    )) as { tree?: { sha?: string } };
    const baseTreeSha = commitData.tree?.sha;
    if (!baseTreeSha) throw new GhHttpError('GET git/commits/{base}', 200, 'response missing tree.sha');

    // 4b. blob 作成 (per file)
    const treeEntries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = [];
    for (const f of files) {
      // バイナリ非対応 (= UTF-8 のみ)。バイナリは Out of Scope (M3 で再判断)。
      // NULL byte 検出で binary を fail-closed に倒す (= 旧実装は文字化けで silent に
      // 棚 PR を作る経路があった、PR #8 レビュー silent-failure-hunter Important 2)。
      // Buffer で読んで NULL byte 含むなら GhHttpError で中断 → catch で github_api_error に。
      const rawBuffer = fs.readFileSync(f.abs);
      if (rawBuffer.includes(0)) {
        throw new GhHttpError(
          'POST git/blobs (binary detected)',
          0,
          `binary file detected (NULL byte): ${f.rel}. ` + `M3 で binary 対応予定、現状は手動除外してください。`,
        );
      }
      const content = rawBuffer.toString('utf-8');
      const blobData = (await ghFetch(
        'POST git/blobs',
        `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/git/blobs`,
        {
          method: 'POST',
          body: JSON.stringify({ content, encoding: 'utf-8' }),
        },
        ctx,
      )) as { sha?: string };
      if (typeof blobData.sha !== 'string') {
        throw new GhHttpError('POST git/blobs', 200, `response missing sha for ${f.rel}`);
      }
      treeEntries.push({
        path: `${category}/${biblioName}/${f.rel}`,
        mode: '100644',
        type: 'blob',
        sha: blobData.sha,
      });
      // secondary rate limit (content-generating 系 80 req/min) を超えないための間隔。
      // GH_BLOB_SLEEP_MS = 1000ms = 60 req/min で上限の 25% 未満に収める (詳細は定数定義参照)。
      await sleep(GH_BLOB_SLEEP_MS);
    }
    // marketplace.json も blob として送る (= 重複検知後の更新版を 1 つだけ)。
    const marketplaceContent = `${JSON.stringify(updatedMarketplace, null, 2)}\n`;
    const mpBlobData = (await ghFetch(
      'POST git/blobs (marketplace)',
      `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/git/blobs`,
      {
        method: 'POST',
        body: JSON.stringify({ content: marketplaceContent, encoding: 'utf-8' }),
      },
      ctx,
    )) as { sha?: string };
    if (typeof mpBlobData.sha !== 'string') {
      throw new GhHttpError('POST git/blobs (marketplace)', 200, 'response missing sha');
    }
    treeEntries.push({
      path: '.claude-plugin/marketplace.json',
      mode: '100644',
      type: 'blob',
      sha: mpBlobData.sha,
    });

    // 4c. tree 作成 (GOTCHA-6: sha と content は排他 = sha のみ渡す)
    const treeRes = (await ghFetch(
      'POST git/trees',
      `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/git/trees`,
      {
        method: 'POST',
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
      },
      ctx,
    )) as { sha?: string };
    if (typeof treeRes.sha !== 'string') throw new GhHttpError('POST git/trees', 200, 'response missing sha');

    // 4d. commit 作成 (GH App identity → 4xx 時のみ PAT fallback 1 回)
    const message = buildCommitMessage(biblioName, category, reason);
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
        log.warn('shelve: commit failed with GH App identity, retrying with fallback author', {
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

    // 4e. branch 作成 (GOTCHA-5: refs/heads/ プレフィックス必須)
    const branchName = branchNameFor(category, biblioName);
    await ghFetch(
      'POST git/refs',
      `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/git/refs`,
      {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: commitSha }),
      },
      ctx,
    );

    // 4f. draft PR 作成
    const prData = (await ghFetch(
      'POST pulls',
      `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/pulls`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: `shelve(${category}): ${biblioName}`,
          head: branchName,
          base: 'main',
          body: buildPrBody(biblioName, category, reason),
          draft: true,
        }),
      },
      ctx,
    )) as { html_url?: string; number?: number };
    if (typeof prData.html_url !== 'string' || typeof prData.number !== 'number') {
      throw new GhHttpError('POST pulls', 200, 'response missing html_url/number');
    }

    log.info('shelve: ok', {
      biblioName,
      category,
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
    // rename (step 2) 完了後の失敗は shelf に残骸が残る (= 次回 acquire 時の
    // quarantine_missing 経由で patron が混乱する経路を防ぐため、必ず警告ログを残す)。
    // PR #8 レビュー silent-failure-hunter Important 1 の指摘対応。
    if (fs.existsSync(shelfPath)) {
      log.warn('shelve: shelf 残骸残置 (= 次回 acquire 前に手動除外を)', {
        biblioName,
        shelfPath,
        hint: `rm -rf "${shelfPath}" で削除可、または棚リポへの draft PR を patron が手動 close`,
      });
    }
    if (err instanceof GhHttpError) {
      log.warn('shelve: github api step failed', { biblioName, step: err.step, status: err.status });
      return fail(
        biblioName,
        'github_api_error',
        `step=${err.step}, status=${err.status}, body=${err.body.slice(0, 200)}`,
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('shelve: github api step threw (non-http)', { biblioName, detail });
    return fail(biblioName, 'github_api_error', `non-http error: ${detail}`);
  }
}
