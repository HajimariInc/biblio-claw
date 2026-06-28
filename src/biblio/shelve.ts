/**
 * 陳列本体 — quarantine の biblio を shelf に物理移動し、棚リポへ feature branch + draft PR を作成する。
 *
 * 構造:
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
  type GhFetchCtx,
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

/**
 * 1 PR で送る blob の上限 (= 棚 1 件の biblio として現実的な範囲)。
 *
 * 大規模 marketplace (= Anthropic 公式 200-400 blob 規模) の全体仕入れに対しては Phase 4
 * `shelveMulti` でも合算 file 数で fail-closed になる。大規模 marketplace は個別 skill 仕入れ
 * 経路 (= Phase 3 `acquire(skill)` + Phase 4 `shelve_biblio_multi` の最大 10 件目安、計
 * 100 file 内) で対応する設計 (PRD individual-skill-shiire)。本上限値の引き上げ判断は
 * patron 体験フィードバック後の継続拡張で再評価する。
 */
const MAX_BLOBS_PER_PR = 100;

/** GitHub branch 名の suffix 形式 (`shelve/<cat>--<biblioName>`)。GOTCHA-5 で `refs/heads/` プレフィックスを後で付ける。 */
function branchNameFor(category: BiblioCategory, biblioName: string): string {
  return `shelve/${category}--${biblioName}`;
}

/**
 * multi shelve 経路の branch 名 (`shelve/multi-<ownerRepo>-<unixSec>`)。
 *
 * unixSec で衝突を実用上ゼロに (= patron が同一秒内に複数 multi shelve を出すケースは稀。
 * 仮に衝突しても POST /git/refs が 422 → `github_api_error` で fail-closed = silent でない)。
 * ownerRepo は `reqs[0].biblioName` の先頭 2 要素 (= `extractOwnerRepo`)。
 */
function branchNameForMulti(reqs: MultiShelveItem[]): string {
  const ownerRepo = extractOwnerRepo(reqs[0].biblioName);
  const unixSec = Math.floor(Date.now() / 1000);
  return `shelve/multi-${ownerRepo}-${unixSec}`;
}

/**
 * biblioName の先頭 2 要素 (`<owner>--<repo>`) を取り出す。
 *
 * 2 要素 / 3 要素 (`<owner>--<repo>--<skill>`) どちらでも先頭 2 要素のみを返す。
 * `BIBLIO_NAME_RE` の greedy 文字クラスが受理する 4 要素以上の入力 (= `owner--repo--skill--extra`)
 * でも `split('--').slice(0, 2)` で先頭 2 要素のみに丸める (= multi 経路 branch 名衝突防止)。
 */
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

/**
 * plugin metadata (description / version) を読む (失敗時は既定値)。
 *
 * 経路 1: `.claude-plugin/plugin.json` (= 単一 plugin 形式、従来挙動)
 * 経路 2: plugin.json ENOENT / parse 失敗 / 非 ENOENT I/O 障害なら `.claude-plugin/marketplace.json`
 *        の plugins[] から fallback (issue #63):
 *        - 3-segment biblio (`<owner>--<name>--<skill>`): plugins[].name === skill で entry を引く
 *        - 2-segment biblio: plugins[0] を代表として使う
 *
 * @param shelfPath  shelve 先 (or quarantine) の物理 path
 * @param biblioName `<owner>--<name>` または `<owner>--<name>--<skill>` (3-segment 時に経路 2 で使用)
 *
 * silent skip 禁止 (CLAUDE.md / `categorize.ts:readPluginDescription` と同パターン):
 * - ENOENT は biblio によっては自然なため経路 1 / 経路 2 とも silent fall-through (= 自然な不在)
 * - それ以外の I/O 障害 (EACCES / EMFILE 等) や JSON 不正は warn で可視化
 * - 両ファイル不在 / 該当 entry 不在 / plugins[] 空も warn で可視化 (= 通常フローでは inspect.ts:resolvePluginMeta
 *   が REJECT 済だが、直接 shelve に到達する経路の診断情報)
 *
 * 返り値は既定値で継続するため陳列自体は止めない。multi 経路 (Phase 4 `shelveMulti`) で
 * 呼ばれる件数が増えるため、shelf 上の marketplace.json entry 品質が無音で劣化する経路に
 * しないことが重要。
 */
function readPluginMeta(shelfPath: string, biblioName: string): { description: string; version: string } {
  // 経路 1: plugin.json (= 単一 plugin 形式、従来挙動)
  const pluginJsonPath = path.join(shelfPath, '.claude-plugin', 'plugin.json');
  let pluginJsonEnoent = false;
  try {
    const raw = fs.readFileSync(pluginJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      description: typeof parsed.description === 'string' ? parsed.description : '',
      version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
    if (err instanceof SyntaxError) {
      log.warn('shelve: plugin.json invalid JSON (trying marketplace.json)', { p: pluginJsonPath, err });
    } else if (code !== 'ENOENT') {
      log.warn('shelve: plugin.json unreadable (trying marketplace.json)', { p: pluginJsonPath, code, err });
    } else {
      pluginJsonEnoent = true;
    }
    // いずれのエラーも経路 2 へ (ENOENT は silent、SyntaxError / 非 ENOENT I/O は上記 warn 済み)
  }

  // 経路 2: marketplace.json fallback (issue #63)
  //   3-segment biblio (`<owner>--<name>--<skill>`): plugins[].name === skill で entry を引く
  //   2-segment biblio: plugins[0] を代表として使う
  const marketplaceJsonPath = path.join(shelfPath, '.claude-plugin', 'marketplace.json');
  let marketplaceEnoent = false;
  try {
    const raw2 = fs.readFileSync(marketplaceJsonPath, 'utf-8');
    const marketplace = JSON.parse(raw2) as { plugins?: unknown };
    if (Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0) {
      const plugins = marketplace.plugins as Record<string, unknown>[];
      const segments = biblioName.split('--');
      const skillSegment = segments.length === 3 ? segments[2] : null;
      const entry =
        skillSegment !== null ? plugins.find((p) => typeof p.name === 'string' && p.name === skillSegment) : plugins[0];
      if (entry !== undefined) {
        return {
          description: typeof entry.description === 'string' ? entry.description : '',
          version: typeof entry.version === 'string' ? entry.version : '0.0.0',
        };
      }
      // 3-segment で plugins[] に該当 entry 不在 → silent fall-through 禁止 (docblock 「無音劣化禁止」)。
      // 通常フローでは inspect.ts:resolvePluginMeta が同条件で REJECT 済のためここに到達しないが、
      // 別経路で shelve に直接到達するケースの診断情報として warn を残す。
      if (skillSegment !== null) {
        log.warn('shelve: marketplace.json に該当 skill entry 不在 (using defaults)', {
          biblioName,
          skillSegment,
          p: marketplaceJsonPath,
        });
      }
    } else {
      // plugins[] 自体が空 / 非配列 — 同じく silent skip 禁止
      log.warn('shelve: marketplace.json plugins[] が空 or 不正 (using defaults)', {
        biblioName,
        p: marketplaceJsonPath,
      });
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
    if (err instanceof SyntaxError) {
      log.warn('shelve: marketplace.json invalid JSON (using defaults)', { p: marketplaceJsonPath, err });
    } else if (code !== 'ENOENT') {
      log.warn('shelve: marketplace.json unreadable (using defaults)', { p: marketplaceJsonPath, code, err });
    } else {
      marketplaceEnoent = true;
    }
  }

  // 両ファイル ENOENT (経路 1 ENOENT + 経路 2 ENOENT) は完全 silent fall-through を許さない
  // (docblock 「無音劣化禁止」)。通常フローでは inspect.ts:resolvePluginMeta が同条件で REJECT 済だが、
  // 直接 shelve 経路 (CLI ハーネス等) の診断として warn を残す。
  // ※ 経路 1 が SyntaxError / 非 ENOENT I/O だった場合は既に warn 済みのため二重通知は出さない。
  if (pluginJsonEnoent && marketplaceEnoent) {
    log.warn('shelve: .claude-plugin/ に plugin.json も marketplace.json も無い (using defaults)', {
      biblioName,
      shelfPath,
    });
  }

  return { description: '', version: '0.0.0' };
}

/**
 * rename 完了後の失敗経路で、shelf 残骸を per-path warn ログに出す + detail 用 trail 文字列を返す共通 helper。
 *
 * step 4 (= ファイル列挙の早期 return 3 箇所: ioErrorCount > 0 / files.length === 0 /
 * totalFiles > MAX_BLOBS_PER_PR) と step 5 (= GitHub API 経路の catch) で共有する。
 * いずれも全 reqs の rename が完了済の状態で fail するため、移動済 path 全件を per-path で
 * warn に出す (= 運用者が `rm -rf` で個別 cleanup 可能、PR #8 silent-failure-hunter Important
 * 1 の per-req 拡張)。
 *
 * step 3 (= rename 途中失敗) では `movedShelfPaths` がループ進行中の部分集合なので、本 helper
 * は使わず inline trail 文字列構築 + `alreadyMoved` フィールドを warn 構造体に直接埋め込む
 * 既存パターンで対応する (= 失敗時点の状態を 1 つの warn ログに集約する設計上の使い分け)。
 */
function warnAndBuildResidualTrail(stage: string, movedShelfPaths: string[]): string {
  if (movedShelfPaths.length === 0) return '';
  for (const sp of movedShelfPaths) {
    if (fs.existsSync(sp)) {
      log.warn('shelveMulti: shelf 残骸残置 (= 次回 acquire 前に手動除外を)', {
        stage,
        shelfPath: sp,
        hint: `rm -rf "${sp}" で削除可、または棚リポへの draft PR を patron が手動 close`,
      });
    }
  }
  return `\n既に shelf に移動済の残骸: ${movedShelfPaths.join(', ')} (= rm -rf で削除可)`;
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

/**
 * category 別に items をグループ化。
 *
 * Map で insertion order を維持することで、PR body / commit message の category 別 section
 * 表示順が `reqs` の入力順 (= patron が承認したカテゴライズ結果の出現順) に揃う。
 * 将来 Object 等で実装し直す場合はこの順序保証が崩れる点に注意。
 */
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
  opts: { quarantineRoot?: string; shelfRoot?: string; ctx?: GhFetchCtx } = {},
): Promise<MultiShelveResult> {
  const ctx = opts.ctx;
  // 0. 入力 validation
  if (reqs.length === 0) {
    log.warn('shelveMulti: empty items');
    return {
      ok: false,
      reason: 'empty_items',
      detail: '陳列項目が空です (items 配列が必要)。',
      // items: [] で型と実装を一致させる (= MultiShelveResult.ok=false の items は required、
      // failMulti と同形)。空入力なので空配列で正しい。
      items: [],
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
    // 必須 env 欠落 = `'config_error'` reason で patron に通知 (issue #50)。
    // 旧来は `'github_api_error'` に集約していたが、運用者が「GitHub API 障害」と
    // 誤認するため reason を型分離した (= `MultiShelveFailureReason` は
    // `ShelveFailureReason` 継承で `'config_error'` を自動取得)。
    // 本 catch は step 3 (rename) より前 = `movedShelfPaths` は常に空のため、
    // step 5 catch のような `warnAndBuildResidualTrail` 呼び出しは行わない
    // (= 残骸が存在しないので可視化不要。step 5 と構造が違うのは意図的)。
    log.warn('shelveMulti: env not ready', { count: reqs.length, detail });
    return failMulti('config_error', detail, reqs);
  }

  // 2. 重複検知 (marketplace.json 事前読み、per-req で 1 件でも引っかかれば全体 fail)
  let marketplace: Record<string, unknown>;
  try {
    const fetched = await fetchMarketplace(env, ctx);
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
      const trail = warnAndBuildResidualTrail('step 3 / quarantine missing', movedShelfPaths);
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
      const trail = warnAndBuildResidualTrail('step 3 / rename failed', movedShelfPaths);
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
        alreadyMoved: movedShelfPaths,
      });
      const trail = warnAndBuildResidualTrail('step 4 / I/O error', movedShelfPaths);
      return failMulti(
        'github_api_error',
        `shelf dir 走査中に ${ioErrorCount} 件の読み取りエラー (権限 / FD 枯渇) が発生したため陳列を中止しました。shelfPath=${shelfPath}${trail}`,
        reqs,
      );
    }
    if (files.length === 0) {
      log.warn('shelveMulti: shelf dir has no files after rename — fail-closed', {
        biblioName: req.biblioName,
        shelfPath,
        alreadyMoved: movedShelfPaths,
      });
      const trail = warnAndBuildResidualTrail('step 4 / empty shelf dir', movedShelfPaths);
      return failMulti('github_api_error', `shelf dir 内にファイルが一切ありません: ${shelfPath}${trail}`, reqs);
    }
    perReqFiles.push({ req, shelfPath, files });
    totalFiles += files.length;
  }
  if (totalFiles > MAX_BLOBS_PER_PR) {
    log.warn('shelveMulti: too many files (combined) exceeds MAX_BLOBS_PER_PR limit', {
      total: totalFiles,
      limit: MAX_BLOBS_PER_PR,
      perReq: perReqFiles.map((p) => ({ biblio: p.req.biblioName, count: p.files.length })),
      alreadyMoved: movedShelfPaths,
    });
    const trail = warnAndBuildResidualTrail('step 4 / MAX_BLOBS_PER_PR exceeded', movedShelfPaths);
    return failMulti(
      'github_api_error',
      `1 PR で送れるファイル数 (${MAX_BLOBS_PER_PR}) を超えています (合算 ${totalFiles} 件、${reqs.length} biblios)${trail}`,
      reqs,
    );
  }
  let updatedMarketplace = marketplace;
  for (const { req, shelfPath } of perReqFiles) {
    const meta = readPluginMeta(shelfPath, req.biblioName);
    updatedMarketplace = mergeMarketplace(updatedMarketplace, {
      name: req.biblioName,
      source: `./${req.category}/${req.biblioName}`,
      description: meta.description,
      version: meta.version,
    });
  }

  // 5. GitHub Git Data API + Pulls API
  // single/multi 経路分岐の共通フラグ — 4 箇所 (5d message / 5e branch / 5f title / 5f body)
  // で同じ条件を評価するため step 5 入口で 1 度だけ判定 (= 変更時の修正箇所が 1 箇所に集約)。
  // `reqs.length === 1` のとき旧 shelve() との完全互換を維持する (= 既存テスト / verify-m2 無変更)。
  const isSingle = reqs.length === 1;
  try {
    // 5a. base SHA + tree SHA 取得
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

    // 5b. blob 作成 (per-req per-file)
    const treeEntries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = [];
    for (const { req, files } of perReqFiles) {
      for (const f of files) {
        // バイナリ非対応 (= UTF-8 のみ)。M3 までは binary 対応を Out of Scope として記載
        // していたが、M3 完了時点でも対応されず継続スコープ外 (= 司書 skill のほとんどが
        // テキストファイル前提のため、binary 対応はパトロン体験フィードバック後に再評価)。
        // NULL byte 検出で binary を fail-closed に倒す (= 旧実装は文字化けで silent に
        // 棚 PR を作る経路があった、PR #8 レビュー silent-failure-hunter Important 2)。
        // Buffer で読んで NULL byte 含むなら GhHttpError で中断 → catch で github_api_error に。
        const rawBuffer = fs.readFileSync(f.abs);
        if (rawBuffer.includes(0)) {
          throw new GhHttpError(
            'POST git/blobs (binary detected)',
            0,
            `binary file detected (NULL byte): ${req.biblioName}/${f.rel}. ` +
              `binary 対応は現状スコープ外、手動除外してください。`,
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
          { ctx },
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
      { ctx },
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
      { ctx },
    )) as { sha?: string };
    if (typeof treeRes.sha !== 'string') throw new GhHttpError('POST git/trees', 200, 'response missing sha');

    // 5d. commit 作成 (GH App identity → 4xx 時のみ PAT fallback 1 回)
    // single 経路 (= isSingle) では旧 buildCommitMessage を使う (= 既存テスト互換)。
    const message = isSingle
      ? buildCommitMessage(reqs[0].biblioName, reqs[0].category, reqs[0].reason)
      : buildCommitMessageMulti(reqs);
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
        log.warn('shelveMulti: commit failed with GH App identity, retrying with fallback author', {
          count: reqs.length,
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

    // 5e. branch 作成 (GOTCHA-5: refs/heads/ プレフィックス必須)
    // single 経路では旧 branchNameFor で既存命名規約を維持。
    const branchName = isSingle ? branchNameFor(reqs[0].category, reqs[0].biblioName) : branchNameForMulti(reqs);
    await ghFetch(
      'POST git/refs',
      `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/git/refs`,
      {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: commitSha }),
      },
      { ctx },
    );

    // 5f. draft PR 作成
    // single 経路では旧 title / body 形式を維持。
    const prTitle = isSingle
      ? `shelve(${reqs[0].category}): ${reqs[0].biblioName}`
      : `shelve(multi): ${reqs.length} biblios from ${extractOwnerRepo(reqs[0].biblioName)}`;
    const prBody = isSingle
      ? buildPrBody(reqs[0].biblioName, reqs[0].category, reqs[0].reason)
      : buildPrBodyMulti(reqs);
    const prData = (await ghFetch(
      'POST pulls',
      `${GITHUB_API}/repos/${env.shelfOwner}/${env.shelfRepo}/pulls`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: prTitle,
          head: branchName,
          base: 'main',
          body: prBody,
          draft: true,
        }),
      },
      { ctx },
    )) as { html_url?: string; number?: number };
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
    // PR #8 レビュー silent-failure-hunter Important 1 の per-req 拡張、
    // helper で step 4 と統一形式 (= per-path warn + trail 文字列)。
    const trail = warnAndBuildResidualTrail('step 5 / GitHub API exception', movedShelfPaths);
    if (err instanceof GhHttpError) {
      log.warn('shelveMulti: github api step failed', {
        step: err.step,
        status: err.status,
        count: reqs.length,
      });
      return failMulti(
        'github_api_error',
        `step=${err.step}, status=${err.status}, body=${err.body.slice(0, 200)}${trail}`,
        reqs,
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('shelveMulti: github api step threw (non-http)', { count: reqs.length, detail });
    return failMulti('github_api_error', `non-http error: ${detail}${trail}`, reqs);
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
  opts: { quarantineRoot?: string; shelfRoot?: string; ctx?: GhFetchCtx } = {},
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
  // MultiShelveFailureReason = ShelveFailureReason | 'empty_items' | 'duplicate_biblio_name'
  // のため、2 値を除いた residual は ShelveFailureReason と型が一致する。将来 multi 専用 reason
  // を追加したときは、本マッピングも更新すること。
  if (result.reason === 'empty_items' || result.reason === 'duplicate_biblio_name') {
    // ありえない経路 (= shelveMulti([req]) は常に length 1 の単一要素配列を渡す) に到達した
    // 場合の defensive log。silent な github_api_error マッピングを残骸ログで可視化する。
    log.warn('shelve (wrapper): multi-only reason reached single path (defensive)', {
      biblioName: req.biblioName,
      reason: result.reason,
      detail: result.detail,
    });
    return fail(req.biblioName, 'github_api_error', result.detail);
  }
  return fail(req.biblioName, result.reason, result.detail);
}
