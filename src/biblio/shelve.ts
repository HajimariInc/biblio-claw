/**
 * 陳列本体 — quarantine の biblio を shelf に物理移動し、棚リポへ feature branch + draft PR を作成する。
 *
 * Phase 4 multi-category-shelve 以降の構造:
 *   - `shelveMulti(reqs[], opts)` が中核実装。N 件の (biblioName, category, reason) を 1 PR
 *     にまとめる。reqs.length === 1 のときは branch 名 / commit message / PR body / PR title を
 *     既存単一 shelve と完全互換に保つ (= verify-m2 + 既存テスト regression なし)。
 *   - `shelve(req, opts)` は `shelveMulti([req], opts)` の薄ラッパ (旧 API 互換)。
 *
 * 経路 (PRD B §技術アプローチ / §解決策の詳細):
 *   1. 重複検知 — GET /repos/{shelf}/contents/.claude-plugin/marketplace.json
 *      - 200 → base64 decode → JSON parse → plugins[].name で `biblioName` を照合 (key = `<owner>--<name>`)
 *      - 404 → 初回 = 空 plugins[] で初期化 (PoC-6 schema 準拠で marketplace を組む)
 *      - その他 (4xx/5xx) → github_api_error
 *   2. 物理移動 — fs.promises.rename(quarantine, shelf/<category>/<biblioName>) を per-req で
 *      - 親 dir は mkdir -p、quarantine 不在は quarantine_missing、rename throw は rename_error
 *      - multi では先頭 req から順に移動、途中失敗時は移動済 path を warn ログに列挙 (= 残骸可視化)
 *   3. shelf 内ファイル列挙 + marketplace.json entry 追記 (= GitHub API 送信前の準備)
 *      - MAX_BLOBS_PER_PR 超過 (= 合算判定) / shelf 内 0 ファイル / バイナリ検出 → github_api_error (fail-closed)
 *   4. GitHub Git Data API + Pulls API — fetch 直叩き (ProxyAgent 経由、OneCLI MITM が Authorization 注入)
 *      (a) GET /git/ref/heads/main + GET /git/commits/{sha} → base commit / tree sha
 *      (b) POST /git/blobs (per-req per-file) → 全 shelf ファイル + 更新後 marketplace.json
 *      (c) POST /git/trees { base_tree, tree: [{path, mode:100644, type:blob, sha}] }
 *      (d) POST /git/commits { message, tree, parents, author, committer }
 *      (e) POST /git/refs { ref: refs/heads/<branchName>, sha }
 *      (f) POST /pulls { title, head, base: main, body, draft: true }
 *   5. 失敗分類 (silent failure 禁止) — catch 内で non-2xx を step + status + body 抜粋に再構成、
 *      rename 完了後 (= step 4 内) の失敗時は shelf 残骸の存在を warn で必ず可視化する
 *
 * 原子性 (Phase 4 設計判断):
 *   - shelveMulti は **N 件すべて陳列 or 0 件陳列** の二択 (= 部分成功なし)。
 *   - 1 件でも重複検知に引っかかれば全体 fail (= 既に shelf 移動済の req があれば warn ログで残骸可視化)。
 *   - PR は 1 commit / 1 branch / 1 PR で複数 category dir 跨ぎ。
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
  type ShelfEnv,
} from './shelf-gh.js';
import type {
  BiblioCategory,
  MultiShelveFailureReason,
  MultiShelveItem,
  MultiShelveResult,
  ShelveFailureReason,
  ShelveResult,
} from './types.js';

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

/**
 * multi shelve 経路の branch 名 (`shelve/multi-<ownerRepo>-<unixSec>`)。
 *
 * unixSec で衝突を実用上ゼロに (= 同一秒内に複数 multi shelve を出さない前提)。
 * ownerRepo は `reqs[0].biblioName` の先頭 2 要素 (= `extractOwnerRepo`)。
 */
function branchNameForMulti(reqs: MultiShelveItem[]): string {
  const ownerRepo = extractOwnerRepo(reqs[0].biblioName);
  const unixSec = Math.floor(Date.now() / 1000);
  return `shelve/multi-${ownerRepo}-${unixSec}`;
}

/** `<owner>--<repo>` (or `<owner>--<repo>--<skill>`) から先頭 2 要素を取り出す。 */
function extractOwnerRepo(biblioName: string): string {
  return biblioName.split('--').slice(0, 2).join('--');
}

/** `ok: false` (single shelve) の組み立てヘルパ。 */
function fail(biblioName: string, reason: ShelveFailureReason, detail: string): ShelveResult {
  return { ok: false, biblioName, reason, detail };
}

/** `ok: false` (multi shelve) の組み立てヘルパ。試行された items 一覧を debug 用に同梱。 */
function failMulti(reason: MultiShelveFailureReason, detail: string, reqs: MultiShelveItem[]): MultiShelveResult {
  return {
    ok: false,
    reason,
    detail,
    items: reqs.map((r) => ({ biblioName: r.biblioName, category: r.category })),
  };
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

/** commit message を組む (single 経路、GOTCHA-7: 本文 → 空行 → Co-Authored-By)。 */
function buildCommitMessage(biblioName: string, category: BiblioCategory, reason: string): string {
  return (
    `feat(${category}): shelve ${biblioName}\n\n` +
    `カテゴリ判定: ${category}\n` +
    `理由: ${reason}\n\n` +
    `Co-Authored-By: Claude (Sonnet 4.6 on Vertex) <noreply@anthropic.com>\n`
  );
}

/**
 * commit message を組む (multi 経路)。category 別に section 分けで列挙する。
 *
 * 例 (3 件 / 2 category):
 *   feat(multi): shelve 3 biblios from owner--repo
 *
 *   [biblio-dev]
 *     - owner--repo--skill-a: TS refactor 補助
 *     - owner--repo--skill-b: コードレビュー支援
 *   [biblio-art]
 *     - owner--repo--skill-c: 図版生成プロンプト
 *
 *   Co-Authored-By: ...
 */
function buildCommitMessageMulti(reqs: MultiShelveItem[]): string {
  const ownerRepo = extractOwnerRepo(reqs[0].biblioName);
  const grouped = groupByCategory(reqs);
  const sections: string[] = [];
  for (const [category, items] of grouped) {
    sections.push(`[${category}]`);
    for (const item of items) {
      sections.push(`  - ${item.biblioName}: ${item.reason}`);
    }
  }
  return (
    `feat(multi): shelve ${reqs.length} biblios from ${ownerRepo}\n\n` +
    `${sections.join('\n')}\n\n` +
    `Co-Authored-By: Claude (Sonnet 4.6 on Vertex) <noreply@anthropic.com>\n`
  );
}

/** PR body を組む (single 経路、人間が眺めて何の biblio か即わかる程度の情報量)。 */
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

/**
 * PR body を組む (multi 経路)。category 別に内訳を列挙、3 要素 biblioName は skill 名を併記。
 */
function buildPrBodyMulti(reqs: MultiShelveItem[]): string {
  const ownerRepo = extractOwnerRepo(reqs[0].biblioName);
  const [owner, repo] = ownerRepo.split('--');
  const grouped = groupByCategory(reqs);
  const sections: string[] = [];
  for (const [category, items] of grouped) {
    sections.push(`### \`${category}\` (${items.length} 件)`);
    for (const item of items) {
      const parts = item.biblioName.split('--');
      const skill = parts.length >= 3 ? parts.slice(2).join('--') : null;
      const label = skill ? `\`${item.biblioName}\` (skill: \`${skill}\`)` : `\`${item.biblioName}\``;
      sections.push(`- ${label} — ${item.reason}`);
    }
    sections.push('');
  }
  return (
    `## 陳列対象 (${reqs.length} 件)\n` +
    `- 仕入れ元: https://github.com/${owner}/${repo}\n\n` +
    `## カテゴリ別内訳\n` +
    `${sections.join('\n')}` +
    `## merge 前に確認\n` +
    `- [ ] 各 biblio が棚 namespace 4 値の意味合いに沿っているか\n` +
    `- [ ] \`marketplace.json\` の各 entry が valid (= \`name\` / \`source\` / \`version\`)\n` +
    `- [ ] biblio ファイル群 (SKILL.md / plugin.json) が棚 root から正しい相対パスに配置されている\n\n` +
    `> このリクエストは biblio-claw 司書が patron (DEN) 承認のもと自動生成しました。\n` +
    `> Co-Authored-By: Claude (Sonnet 4.6 on Vertex) <noreply@anthropic.com>\n`
  );
}

/** category 別に items をグループ化 (insertion order 維持 = Map)。 */
function groupByCategory(reqs: MultiShelveItem[]): Map<BiblioCategory, MultiShelveItem[]> {
  const grouped = new Map<BiblioCategory, MultiShelveItem[]>();
  for (const req of reqs) {
    const list = grouped.get(req.category) ?? [];
    list.push(req);
    grouped.set(req.category, list);
  }
  return grouped;
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
 * 複数 (biblioName, category) を 1 PR にまとめて陳列する本体 (throw しない)。
 *
 * Phase 4 multi-category-shelve の中核。N 件すべて陳列 or 0 件陳列の二択 (= 部分成功なし)。
 * reqs.length === 1 のとき branch 名 / commit message / PR body / PR title を既存単一 shelve と
 * 完全互換に保つ (= verify-m2 + 既存テスト regression なし、`shelve()` 薄ラッパ経由でも安全)。
 *
 * @param reqs N 件の (biblioName, category, reason)。空配列は `empty_items` で fail。
 * @param opts quarantineRoot / shelfRoot をテスト/verify 用に上書き可能 (既定は `${DATA_DIR}/{quarantine,shelf}`)
 */
export async function shelveMulti(
  reqs: MultiShelveItem[],
  opts: { quarantineRoot?: string; shelfRoot?: string } = {},
): Promise<MultiShelveResult> {
  // 0. 入力 validation
  if (reqs.length === 0) {
    log.warn('shelveMulti: empty items');
    return {
      ok: false,
      reason: 'empty_items',
      detail: '陳列項目が空です (items 配列が必要)。',
    };
  }
  // biblioName 重複は per-req 物理移動が衝突するため pre-flight で fail。
  const seen = new Set<string>();
  for (const req of reqs) {
    if (seen.has(req.biblioName)) {
      log.warn('shelveMulti: duplicate biblioName', { biblioName: req.biblioName, count: reqs.length });
      return failMulti(
        'duplicate_biblio_name',
        `重複する biblioName: ${req.biblioName} (per-req 物理移動が衝突するため陳列を中止)`,
        reqs,
      );
    }
    seen.add(req.biblioName);
  }

  const quarantineRoot = opts.quarantineRoot ?? path.join(DATA_DIR, 'quarantine');
  const shelfRoot = opts.shelfRoot ?? path.join(DATA_DIR, 'shelf');

  // 1. env
  let env: ShelfEnv;
  try {
    env = readShelveEnv();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('shelveMulti: env not ready', { count: reqs.length, detail });
    return failMulti('github_api_error', detail, reqs);
  }

  // 2. 重複検知 (marketplace.json 事前読み、per-req で 1 件でも引っかかれば全体 fail)
  let marketplace: Record<string, unknown>;
  try {
    const fetched = await fetchMarketplace(env);
    if (fetched.raw) {
      for (const req of reqs) {
        if (isAlreadyShelved(fetched.raw, req.biblioName)) {
          log.info('shelveMulti: already shelved (atomic fail)', {
            biblioName: req.biblioName,
            category: req.category,
            count: reqs.length,
          });
          return failMulti(
            'already_shelved',
            `marketplace.json に既存 entry: ${req.biblioName} (全体陳列を中止、部分成功なし)`,
            reqs,
          );
        }
      }
    }
    marketplace = fetched.raw ?? newMarketplace(env);
  } catch (err) {
    if (err instanceof GhHttpError) {
      log.warn('shelveMulti: fetch marketplace failed', {
        step: err.step,
        status: err.status,
        count: reqs.length,
      });
      return failMulti(
        'github_api_error',
        `step=${err.step}, status=${err.status}, body=${err.body.slice(0, 200)}`,
        reqs,
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('shelveMulti: fetch marketplace threw', { count: reqs.length, detail });
    return failMulti('github_api_error', `step=GET contents/marketplace.json, detail=${detail}`, reqs);
  }

  // 3. 物理移動 (per-req loop、quarantine → shelf/<cat>/<biblio>)
  // 途中失敗時は既に移動済の path を warn ログに列挙する (= shelf 残骸可視化、PR #8 流儀の per-req 拡張)。
  const movedShelfPaths: string[] = [];
  for (const req of reqs) {
    const quarantinePath = path.join(quarantineRoot, req.biblioName);
    const shelfPath = path.join(shelfRoot, req.category, req.biblioName);
    if (!fs.existsSync(quarantinePath)) {
      log.warn('shelveMulti: quarantine missing (atomic fail)', {
        biblioName: req.biblioName,
        quarantinePath,
        alreadyMoved: movedShelfPaths,
      });
      const trail =
        movedShelfPaths.length > 0
          ? `\n既に shelf に移動済の残骸: ${movedShelfPaths.join(', ')} (= rm -rf で削除可)`
          : '';
      return failMulti(
        'quarantine_missing',
        `quarantine 配下に biblio が存在しません: ${quarantinePath}${trail}`,
        reqs,
      );
    }
    try {
      fs.mkdirSync(path.dirname(shelfPath), { recursive: true });
      // shelfPath が既に存在する場合 (= 過去の中断で残骸あり) は事前に除去 (silent failure 防止)。
      if (fs.existsSync(shelfPath)) {
        fs.rmSync(shelfPath, { recursive: true, force: true });
      }
      await fs.promises.rename(quarantinePath, shelfPath);
      movedShelfPaths.push(shelfPath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.warn('shelveMulti: rename failed (atomic fail)', {
        biblioName: req.biblioName,
        quarantinePath,
        shelfPath,
        detail,
        alreadyMoved: movedShelfPaths,
      });
      const trail =
        movedShelfPaths.length > 0
          ? `\n既に shelf に移動済の残骸: ${movedShelfPaths.join(', ')} (= rm -rf で削除可)`
          : '';
      return failMulti('rename_error', `quarantine → shelf 移動に失敗 (${req.biblioName}): ${detail}${trail}`, reqs);
    }
  }

  // 4. shelf 内ファイル列挙 + 合算判定 + marketplace entries 構築
  type ReqFiles = { req: MultiShelveItem; shelfPath: string; files: Array<{ rel: string; abs: string }> };
  const perReqFiles: ReqFiles[] = [];
  let totalFiles = 0;
  for (const req of reqs) {
    const shelfPath = path.join(shelfRoot, req.category, req.biblioName);
    const { files, ioErrorCount } = listShelfFiles(shelfPath);
    if (ioErrorCount > 0) {
      log.warn('shelveMulti: shelf dir scan I/O errors — fail-closed', {
        biblioName: req.biblioName,
        shelfPath,
        ioErrorCount,
      });
      return failMulti(
        'github_api_error',
        `shelf dir 走査中に ${ioErrorCount} 件の読み取りエラー (権限 / FD 枯渇) が発生したため陳列を中止しました。shelfPath=${shelfPath}`,
        reqs,
      );
    }
    if (files.length === 0) {
      log.warn('shelveMulti: shelf dir has no files after rename — fail-closed', {
        biblioName: req.biblioName,
        shelfPath,
      });
      return failMulti('github_api_error', `shelf dir 内にファイルが一切ありません: ${shelfPath}`, reqs);
    }
    perReqFiles.push({ req, shelfPath, files });
    totalFiles += files.length;
  }
  if (totalFiles > MAX_BLOBS_PER_PR) {
    log.warn('shelveMulti: too many files (combined) exceeds MAX_BLOBS_PER_PR limit', {
      total: totalFiles,
      limit: MAX_BLOBS_PER_PR,
      perReq: perReqFiles.map((p) => ({ biblio: p.req.biblioName, count: p.files.length })),
    });
    return failMulti(
      'github_api_error',
      `1 PR で送れるファイル数 (${MAX_BLOBS_PER_PR}) を超えています (合算 ${totalFiles} 件、${reqs.length} biblios)`,
      reqs,
    );
  }
  let updatedMarketplace = marketplace;
  for (const { req, shelfPath } of perReqFiles) {
    const meta = readPluginMeta(shelfPath);
    updatedMarketplace = mergeMarketplace(updatedMarketplace, {
      name: req.biblioName,
      source: `./${req.category}/${req.biblioName}`,
      description: meta.description,
      version: meta.version,
    });
  }

  // 5. GitHub Git Data API + Pulls API
  try {
    // 5a. base SHA + tree SHA 取得
    const refData = (await ghFetch(
      'GET git/ref/heads/main',
      `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/git/ref/heads/main`,
    )) as { object?: { sha?: string } };
    const baseCommitSha = refData.object?.sha;
    if (!baseCommitSha) throw new GhHttpError('GET git/ref/heads/main', 200, 'response missing object.sha');

    const commitData = (await ghFetch(
      'GET git/commits/{base}',
      `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/git/commits/${baseCommitSha}`,
    )) as { tree?: { sha?: string } };
    const baseTreeSha = commitData.tree?.sha;
    if (!baseTreeSha) throw new GhHttpError('GET git/commits/{base}', 200, 'response missing tree.sha');

    // 5b. blob 作成 (per-req per-file)
    const treeEntries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = [];
    for (const { req, files } of perReqFiles) {
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
            `binary file detected (NULL byte): ${req.biblioName}/${f.rel}. ` +
              `M3 で binary 対応予定、現状は手動除外してください。`,
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
        )) as { sha?: string };
        if (typeof blobData.sha !== 'string') {
          throw new GhHttpError('POST git/blobs', 200, `response missing sha for ${req.biblioName}/${f.rel}`);
        }
        treeEntries.push({
          path: `${req.category}/${req.biblioName}/${f.rel}`,
          mode: '100644',
          type: 'blob',
          sha: blobData.sha,
        });
        // secondary rate limit (content-generating 系 80 req/min) を超えないための間隔。
        // GH_BLOB_SLEEP_MS = 1000ms = 60 req/min で上限の 25% 未満に収める (詳細は定数定義参照)。
        await sleep(GH_BLOB_SLEEP_MS);
      }
    }
    // marketplace.json も blob として送る (= 重複検知後の更新版を 1 つだけ、N entries まとめ)。
    const marketplaceContent = `${JSON.stringify(updatedMarketplace, null, 2)}\n`;
    const mpBlobData = (await ghFetch(
      'POST git/blobs (marketplace)',
      `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/git/blobs`,
      {
        method: 'POST',
        body: JSON.stringify({ content: marketplaceContent, encoding: 'utf-8' }),
      },
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

    // 5c. tree 作成 (GOTCHA-6: sha と content は排他 = sha のみ渡す)
    const treeRes = (await ghFetch(
      'POST git/trees',
      `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/git/trees`,
      {
        method: 'POST',
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
      },
    )) as { sha?: string };
    if (typeof treeRes.sha !== 'string') throw new GhHttpError('POST git/trees', 200, 'response missing sha');

    // 5d. commit 作成 (GH App identity → 4xx 時のみ PAT fallback 1 回)
    // single 経路 (= reqs.length === 1) では旧 buildCommitMessage を使う (= 既存テスト互換)。
    const message =
      reqs.length === 1
        ? buildCommitMessage(reqs[0].biblioName, reqs[0].category, reqs[0].reason)
        : buildCommitMessageMulti(reqs);
    let commitSha: string;
    try {
      const r = await createCommit({
        env,
        message,
        treeSha: treeRes.sha,
        parentSha: baseCommitSha,
        author: { name: env.authorName, email: env.authorEmail },
      });
      commitSha = r.sha;
    } catch (err) {
      if (err instanceof GhHttpError && err.status >= 400 && err.status < 500 && env.fallbackAuthor) {
        log.warn('shelveMulti: commit failed with GH App identity, retrying with fallback author', {
          count: reqs.length,
          status: err.status,
          bodyPreview: err.body.slice(0, 200),
        });
        const r = await createCommit({
          env,
          message,
          treeSha: treeRes.sha,
          parentSha: baseCommitSha,
          author: env.fallbackAuthor,
        });
        commitSha = r.sha;
      } else {
        throw err;
      }
    }

    // 5e. branch 作成 (GOTCHA-5: refs/heads/ プレフィックス必須)
    // single 経路では旧 branchNameFor で既存命名規約を維持。
    const branchName =
      reqs.length === 1 ? branchNameFor(reqs[0].category, reqs[0].biblioName) : branchNameForMulti(reqs);
    await ghFetch('POST git/refs', `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: commitSha }),
    });

    // 5f. draft PR 作成
    // single 経路では旧 title / body 形式を維持。
    const prTitle =
      reqs.length === 1
        ? `shelve(${reqs[0].category}): ${reqs[0].biblioName}`
        : `shelve(multi): ${reqs.length} biblios from ${extractOwnerRepo(reqs[0].biblioName)}`;
    const prBody =
      reqs.length === 1 ? buildPrBody(reqs[0].biblioName, reqs[0].category, reqs[0].reason) : buildPrBodyMulti(reqs);
    const prData = (await ghFetch('POST pulls', `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title: prTitle,
        head: branchName,
        base: 'main',
        body: prBody,
        draft: true,
      }),
    })) as { html_url?: string; number?: number };
    if (typeof prData.html_url !== 'string' || typeof prData.number !== 'number') {
      throw new GhHttpError('POST pulls', 200, 'response missing html_url/number');
    }

    log.info('shelveMulti: ok', {
      count: reqs.length,
      branchName,
      prNumber: prData.number,
      prUrl: prData.html_url,
      items: reqs.map((r) => ({ biblioName: r.biblioName, category: r.category })),
    });
    return {
      ok: true,
      prUrl: prData.html_url,
      prNumber: prData.number,
      branchName,
      items: reqs.map((r) => ({ biblioName: r.biblioName, category: r.category })),
    };
  } catch (err) {
    // rename (step 3) 完了後の失敗は shelf に残骸が残る (= 次回 acquire 時の
    // quarantine_missing 経由で patron が混乱する経路を防ぐため、必ず warn ログを残す)。
    // PR #8 レビュー silent-failure-hunter Important 1 の per-req 拡張。
    for (const shelfPath of movedShelfPaths) {
      if (fs.existsSync(shelfPath)) {
        log.warn('shelveMulti: shelf 残骸残置 (= 次回 acquire 前に手動除外を)', {
          shelfPath,
          hint: `rm -rf "${shelfPath}" で削除可、または棚リポへの draft PR を patron が手動 close`,
        });
      }
    }
    if (err instanceof GhHttpError) {
      log.warn('shelveMulti: github api step failed', {
        step: err.step,
        status: err.status,
        count: reqs.length,
      });
      return failMulti(
        'github_api_error',
        `step=${err.step}, status=${err.status}, body=${err.body.slice(0, 200)}`,
        reqs,
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('shelveMulti: github api step threw (non-http)', { count: reqs.length, detail });
    return failMulti('github_api_error', `non-http error: ${detail}`, reqs);
  }
}

/**
 * 陳列本体 (throw しない、失敗は ShelveResult.ok=false で返す)。
 *
 * Phase 4 以降は `shelveMulti([req], opts)` の薄ラッパ。API は維持し、reqs.length === 1 で
 * shelveMulti 内が旧 branch 名 / commit message / PR body / PR title を使うため、verify-m2 +
 * 既存テストは完全互換。
 *
 * @param req biblioName (`<owner>--<name>` or `<owner>--<repo>--<skill>`) / category / reason
 * @param opts quarantineRoot / shelfRoot をテスト/verify 用に上書き可能
 */
export async function shelve(
  req: { biblioName: string; category: BiblioCategory; reason: string },
  opts: { quarantineRoot?: string; shelfRoot?: string } = {},
): Promise<ShelveResult> {
  const result = await shelveMulti([req], opts);
  if (result.ok) {
    return {
      ok: true,
      biblioName: req.biblioName,
      category: req.category,
      prUrl: result.prUrl,
      prNumber: result.prNumber,
      branchName: result.branchName,
    };
  }
  // multi 専用 reason (empty_items / duplicate_biblio_name) は単一経路では発生しない
  // ため safety net で github_api_error にマップする (= ShelveResult shape を維持)。
  const reason: ShelveFailureReason =
    result.reason === 'empty_items' || result.reason === 'duplicate_biblio_name' ? 'github_api_error' : result.reason;
  return fail(req.biblioName, reason, result.detail);
}
