/**
 * 仕入れ本体 — 外部 public biblio を取得して quarantine に配置する。
 *
 * 2 経路を持つ:
 *   - 全体仕入れ (`req.skill === undefined`): normalizeRepo → ghFetch で存在確認 →
 *     countSkillsInRepo (Phase 2 閾値判定、超過なら clone 前 early return) → git clone →
 *     manifest (marketplace.json / SKILL.md) 存在チェック
 *   - 個別 skill 仕入れ (`req.skill !== undefined`, Phase 3): normalizeRepo →
 *     fetchSkillSubtree が partial clone + sparse-checkout で該当 skill dir のみ展開 →
 *     SKILL.md 存在チェック。ghFetch 存在確認は bypass (= clone 自体が repo 不在を 404 で検知する)
 * 決定的ロジックは全てここに集約し、`acquire.test.ts` で固める。
 *
 * `git` は `getChildProcEnv()` の env (OneCLI proxy 経由) で実行するため、host から認証付きで
 * github に到達する。GitHub REST API 経路は `shelf-gh.ts:ghFetch` を流用 (= gh CLI 依存撤廃、
 * PR #33 hotfix で確立)。存在確認と clone の経路差 + 採用理由 (WHY) はそれぞれの呼出ブロックの
 * インラインコメントに記述する。PoC-7 `verify.sh` の clone/存在確認を写経。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { getBiblioSetting } from '../db/biblio-settings.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { getChildProcEnv } from './host-proxy.js';
import { GITHUB_API, type GhFetchCtx, GhHttpError, ghFetch } from './shelf-gh.js';
import type { AcquireRequest, AcquireResult, NormalizedRepo } from './types.js';

/** owner / repo セグメントの許容文字 (GitHub の命名規則に準拠した安全側)。 */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** quarantine の親ディレクトリ。GKE=`/data/quarantine`, local=`./data/quarantine`。 */
const QUARANTINE_DIR = path.join(DATA_DIR, 'quarantine');

/** manifest 探索時の再帰深さ上限 (暴走防止)。 */
const MANIFEST_SCAN_MAX_DEPTH = 6;

/**
 * `git clone` の timeout (ms)。OneCLI proxy が応答しない / 遅い経路 (GKE sidecar の
 * cold start, 低速ネットワーク) で `spawnSync` が無期限ブロックし host の delivery
 * poll を止めるのを防ぐ。timeout 時は SIGTERM kill され `status=null` + `signal` が立つ。
 *
 * 存在確認 (`ghFetch`) 側の timeout は `shelf-gh.ts:GH_FETCH_TIMEOUT_MS` (30s) を使う。
 */
const CLONE_TIMEOUT_MS = 120_000; // shallow clone でも大きめ repo を考慮
/** local 完結の git operation (= sparse-checkout init / set 等、remote 通信なし) 用の短い timeout。 */
const GH_TIMEOUT_MS = 30_000;

/**
 * skill 数の閾値 (既定値、Phase 2)。env `ACQUIRE_SKILL_THRESHOLD` で上書き可能。
 * 仕入先 repo の skill 数がこの値を超えたら全体仕入れを止めて patron に個別指定を促す。
 * 既定 10 の根拠: `MAX_BLOBS_PER_PR=100` を割って 1 skill あたり平均 10 ファイル以下なら通る目安。
 */
const DEFAULT_ACQUIRE_SKILL_THRESHOLD = 10;

/**
 * `spawnSync` の結果から人間可読な失敗 detail を組む。
 * signal kill (timeout 含む) は `status=null` になり `gh exited null` だと無意味なため、
 * signal を優先して明示する (silent failure 防止 / デバッグ可能性)。
 */
function spawnDetail(
  result: { status: number | null; signal: NodeJS.Signals | null; stderr: string | Buffer | null; error?: Error },
  cmd: string,
): string {
  if (result.signal) return `${cmd} がタイムアウト/中断されました (signal ${result.signal})`;
  const stderr = result.stderr ? String(result.stderr).trim() : '';
  return stderr || result.error?.message || `${cmd} exited ${result.status}`;
}

/**
 * 生入力を `{ owner, name, cloneUrl }` に正規化する。
 * 受理: `owner/repo` 短縮形 / `https://github.com/owner/repo(.git)` URL /
 *       末尾 `.git`・`/` の揺れ。解釈不能は `null`。
 */
export function normalizeRepo(input: string): NormalizedRepo | null {
  const raw = input.trim();
  if (!raw) return null;

  let pathPart = raw;
  // URL 形式 (scheme 有無どちらも) から owner/repo を抜き出す。
  const urlMatch = raw.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i);
  if (urlMatch) {
    pathPart = urlMatch[1];
  } else if (/^https?:\/\//i.test(raw)) {
    // github.com 以外の URL は対象外。
    return null;
  }

  // 末尾 `/`・`.git` を除去。
  pathPart = pathPart.replace(/\/+$/, '').replace(/\.git$/i, '');

  const segments = pathPart.split('/');
  // 2 segments: `owner/repo` (= 既存) / 3 segments: `owner/repo/skill` (= Phase 1 個別 skill 仕入れ防御線)。
  // 4+ segments は公式 marketplace のフラット 1 階層構造 (`skills/<skill-name>/SKILL.md`) に該当せず不正入力。
  if (segments.length !== 2 && segments.length !== 3) return null;

  const [owner, name, skill] = segments;
  if (!SEGMENT_RE.test(owner) || !SEGMENT_RE.test(name)) return null;
  if (skill !== undefined && !SEGMENT_RE.test(skill)) return null;

  return {
    owner,
    name,
    cloneUrl: `https://github.com/${owner}/${name}.git`,
    ...(skill !== undefined ? { skill } : {}),
  };
}

/** `<dir>` 配下を深さ制限付きで走査し、指定ファイル名が存在するか判定する (`.git` は除外)。 */
function hasFileRecursive(dir: string, filename: string, depth = 0): boolean {
  if (depth > MANIFEST_SCAN_MAX_DEPTH) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // I/O 障害 (= EACCES / EMFILE 等) を silent skip しないため warn で可視化する。
    // 返り値は false で継続 = manifest 不在と同義の挙動を維持 (= 既存挙動を壊さない)、
    // ただし patron に「SKILL.md 不在」と誤分類されるケースをログで追跡可能にする。
    // 同パターン: `inspect.ts:collectScanTargets` / `categorize.ts:collectByName`。
    log.warn('acquire: hasFileRecursive unreadable dir', { dir, depth, err });
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      if (hasFileRecursive(path.join(dir, entry.name), filename, depth + 1)) return true;
    } else if (entry.isFile() && entry.name === filename) {
      return true;
    }
  }
  return false;
}

/**
 * biblio 成立条件: `.claude-plugin/marketplace.json` または任意階層の `SKILL.md`。
 * M2 PRD B Phase 1 (= 仕入れ段階) では「存在チェック」のみ実施 (schema 妥当性は M2 PRD B
 * Phase 2 検品 `inspect.ts` の責務)。
 */
function hasManifest(quarantinePath: string): boolean {
  const marketplace = path.join(quarantinePath, '.claude-plugin', 'marketplace.json');
  if (fs.existsSync(marketplace)) return true;
  return hasFileRecursive(quarantinePath, 'SKILL.md');
}

/** quarantine ディレクトリを冪等に削除する (再取得の上書き / 失敗時の後始末)。 */
function removeQuarantine(quarantinePath: string): void {
  try {
    fs.rmSync(quarantinePath, { recursive: true, force: true });
  } catch (err) {
    log.warn('acquire: quarantine cleanup failed', { quarantinePath, err });
  }
}

/**
 * `ACQUIRE_SKILL_THRESHOLD` を解決する (Phase 2 で env、個別 PRD Phase 5 で DB 優先に拡張)。
 *
 * 解決順 (DB → env → DEFAULT の 3 層 fallback):
 *   1. `biblio_settings` table の `ACQUIRE_SKILL_THRESHOLD` 行 — patron が `@bot 設定`
 *      で動的変更する経路 (= 即時反映、再起動不要)
 *   2. `.env` / `process.env` の `ACQUIRE_SKILL_THRESHOLD` — 初期値 / 旧運用慣習
 *   3. `DEFAULT_ACQUIRE_SKILL_THRESHOLD` (= 10) — どちらも未設定時の最終 fallback
 *
 * 各層で値が「数値解釈不能 / 0 以下」なら warn ログを出して次層に降りる (= silent
 * failure 防止、運用者が変な値を入れた場合の検知可能性を担保)。`readEnvFile` と
 * `getBiblioSetting` はどちらも都度読み — キャッシュ層を持たないので、設定変更直後の
 * 次の `acquire()` 呼び出しで即時反映される (= キャッシュ無効化機構不要)。
 *
 * 性能: `acquire()` は patron 発話起点で高頻度ではないため、DB SELECT 1 行 (= μs オーダー)
 * の追加コストは問題にならない。
 */
export function resolveSkillThreshold(): number {
  // 1. DB 優先 — `@bot 設定` で patron が動的変更した値を最優先で採用する。
  const fromDb = getBiblioSetting('ACQUIRE_SKILL_THRESHOLD');
  if (fromDb !== undefined && fromDb !== '') {
    const parsed = Number.parseInt(fromDb, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
    log.warn('invalid ACQUIRE_SKILL_THRESHOLD in DB, falling back to env', {
      raw: fromDb,
    });
  }
  // 2. env fallback (= 既存挙動維持、初期値 / 旧運用慣習)。
  const raw = readEnvFile(['ACQUIRE_SKILL_THRESHOLD']).ACQUIRE_SKILL_THRESHOLD;
  if (!raw) return DEFAULT_ACQUIRE_SKILL_THRESHOLD;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    log.warn('invalid ACQUIRE_SKILL_THRESHOLD, using default', {
      raw,
      default: DEFAULT_ACQUIRE_SKILL_THRESHOLD,
    });
    return DEFAULT_ACQUIRE_SKILL_THRESHOLD;
  }
  return parsed;
}

/**
 * 仕入先 repo の skill 数を count する (Phase 2)。
 *
 * 2 段アプローチ:
 *   (1) `.claude-plugin/marketplace.json` を fetch → `plugins[]` を集計
 *       - `plugins[].skills: string[]` 形式 (= anthropics/skills 型) → array length 合計
 *       - `plugins[]` 直配列 (= claude-plugins-official 型、`skills` 無し) →
 *         各 plugin につき 1 を加算 (= 全 plugin が `skills` 無しなら結果は `plugins.length` と一致、
 *         混在 array では「`skills` あり = 配列長、`skills` 無し = 1」の reduce 集計になる)
 *   (2) (1) が 404 = marketplace.json 不在なら Git Trees API recursive で `SKILL.md` を count
 *       (main → master の順に試行、両 404 / truncated は unknown)
 *
 * 戻り値:
 *   `{ ok: true, count }`           — count に成功 (本数値で閾値判定)
 *   `{ ok: false, reason: 'unknown' }` — API 失敗 / truncated / parse 失敗 (= 閾値判定を
 *     skip して全体仕入れに進む degraded 挙動。エラーで未知の repo を全て拒否するより、
 *     後段の `MAX_BLOBS_PER_PR=100` fail-closed に倒す方が UX 影響が小さい)
 *
 * GitHub API call は最大 3 回 (= marketplace.json + git/trees/main + git/trees/master)。
 * いずれも `ghFetch(..., { noAuth: true })` で Authorization ヘッダを省略する (= OneCLI secret の
 * pathPattern `/repos/HajimariInc/*` に外部 repo は match せず、`Bearer placeholder` を素通しすると
 * GitHub が invalid token として 401 を返すため。`shelve.ts` の HajimariInc 系経路とは非対称)。
 * よって rate limit は IP 単位の無認証 60 req/h が上限だが、本関数は 1 仕入れあたり 1-3 回しか
 * 呼ばないため余裕十分。
 */
async function countSkillsInRepo(
  owner: string,
  name: string,
): Promise<{ ok: true; count: number } | { ok: false; reason: 'unknown' }> {
  // 段 (1): marketplace.json 経路 — `noAuth: true` で Authorization 省略 (= 外部 repo は
  // OneCLI secret の pathPattern `/repos/HajimariInc/*` に match しないため、`Bearer placeholder`
  // を素通しすると GitHub が invalid token として 401 を返す → 無認証で public API 200 を取る)。
  try {
    const url = `${GITHUB_API}/repos/${owner}/${name}/contents/.claude-plugin/marketplace.json`;
    const data = (await ghFetch('GET contents/marketplace.json (acquire)', url, {}, { noAuth: true })) as {
      content?: string;
      encoding?: string;
    };
    if (typeof data.content === 'string' && data.encoding === 'base64') {
      const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
      let parsed: { plugins?: Array<{ skills?: unknown }> };
      try {
        parsed = JSON.parse(decoded) as { plugins?: Array<{ skills?: unknown }> };
      } catch (err) {
        log.warn('countSkillsInRepo: marketplace.json invalid JSON', { owner, name, err });
        return { ok: false, reason: 'unknown' };
      }
      if (Array.isArray(parsed.plugins)) {
        // 2 schema 形式に両対応:
        // - plugins[].skills が array → array length 合計 (anthropics/skills 型)
        // - plugins[].skills が無い → 1 plugin = 1 skill 扱い (claude-plugins-official 型)
        const count = parsed.plugins.reduce<number>(
          (acc, p) => acc + (Array.isArray(p.skills) ? p.skills.length : 1),
          0,
        );
        log.info('countSkillsInRepo: marketplace.json found', { owner, name, count });
        return { ok: true, count };
      }
      // plugins 配列が欠落 / 不正型 → unknown (= 「marketplace ではない」可能性)
      log.warn('countSkillsInRepo: marketplace.json has no plugins[]', { owner, name });
      return { ok: false, reason: 'unknown' };
    }
    // content/encoding が想定外 → unknown
    log.warn('countSkillsInRepo: marketplace.json response missing content/encoding', { owner, name });
    return { ok: false, reason: 'unknown' };
  } catch (err) {
    if (err instanceof GhHttpError && err.status === 404) {
      // marketplace.json 不在 → 段 (2) に fallback
    } else {
      log.warn('countSkillsInRepo: marketplace.json fetch failed, skipping threshold', {
        owner,
        name,
        err,
      });
      return { ok: false, reason: 'unknown' };
    }
  }

  // 段 (2): Git Trees fallback — SKILL.md を recursive で count
  // default branch を main → master の順に試行 (= 2020 年以降 main 推奨だが master 残置 repo もあるため)
  const tryBranches = ['main', 'master'] as const;
  for (const branch of tryBranches) {
    try {
      const url = `${GITHUB_API}/repos/${owner}/${name}/git/trees/${branch}?recursive=1`;
      // `noAuth: true` の理由は段 (1) と同じ (= 外部 repo の pathPattern miss 対策)。
      const data = (await ghFetch('GET git/trees (acquire)', url, {}, { noAuth: true })) as {
        truncated?: boolean;
        tree?: Array<{ path?: string; type?: string }>;
      };
      if (data.truncated) {
        // 100k entries / 7MB 超で truncated。count 不確実なら無条件で promote しない (= 既存挙動維持)
        log.warn('countSkillsInRepo: git tree truncated, skipping threshold', { owner, name, branch });
        return { ok: false, reason: 'unknown' };
      }
      if (!Array.isArray(data.tree)) {
        log.warn('countSkillsInRepo: git tree response missing tree[]', { owner, name, branch });
        return { ok: false, reason: 'unknown' };
      }
      // 1 skill = 1 SKILL.md (agentskills.io spec) を踏襲、blob のみ対象 (= type='tree' を除外)
      const count = data.tree.filter(
        (e) => typeof e.path === 'string' && e.type === 'blob' && e.path.endsWith('/SKILL.md'),
      ).length;
      log.info('countSkillsInRepo: git trees fallback', { owner, name, branch, count });
      return { ok: true, count };
    } catch (err) {
      if (err instanceof GhHttpError && err.status === 404) continue; // 次の branch を試す
      log.warn('countSkillsInRepo: git trees fetch failed, skipping threshold', {
        owner,
        name,
        branch,
        err,
      });
      return { ok: false, reason: 'unknown' };
    }
  }
  log.warn('countSkillsInRepo: no main/master branch found, skipping threshold', { owner, name });
  return { ok: false, reason: 'unknown' };
}

/**
 * 個別 skill 仕入れの本体 (Phase 3) — 該当 skill ディレクトリのみを quarantine に展開する。
 *
 * 経路 (= コード内の 6 ステップに対応):
 *   1. quarantine 配置先準備 (mkdir + 上書き warn + 冪等削除)
 *   2. git clone --depth 1 --filter=blob:none --no-checkout <url> <qpath>
 *      → shallow + blobless + worktree 展開なし
 *   3. git -C <qpath> sparse-checkout init --cone
 *      → cone mode (= path prefix 形式) で sparse-checkout を有効化
 *   4. git -C <qpath> sparse-checkout set <skill>
 *      → 該当 skill ディレクトリのみを include 対象に
 *   5. git -C <qpath> checkout
 *      → HEAD を sparse pattern に従って worktree に展開 (= 該当 dir のみ、blob は遅延 fetch)
 *   6. manifest 確認 (= skill dir 直下 + 任意階層に SKILL.md が存在 = agentskills.io spec)
 *
 * 採用根拠: 既存全体仕入れ経路 (= git clone) と同じ env (= getChildProcEnv()) で動く =
 * OneCLI MITM proxy / HTTPS_PROXY / GIT_SSL_CAINFO / shallow timeout 等の既存配線を継承する。
 * GitHub Contents/Trees API の N+1 fetch より rate limit 安全、tarball ダウンロード (= 全体取得)
 * より帯域効率良し。
 *
 * シナリオ C (複数 skill 一括指定) 対応: 1 skill 処理を本関数に閉じることで、上位の
 * `acquire()` が将来ループから呼ぶ拡張をしても改修最小化 (= 過剰設計はしない、関数化のみ)。
 */
async function fetchSkillSubtree(owner: string, name: string, skill: string, cloneUrl: string): Promise<AcquireResult> {
  const biblioName = `${owner}--${name}--${skill}`;
  const quarantinePath = path.join(QUARANTINE_DIR, biblioName);

  // 1. quarantine 親 + 配置先準備 (上書き warn + 冪等削除 = 既存全体経路と同パターン)
  try {
    fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('acquire failed (skill)', { repo: `${owner}/${name}`, skill, reason: 'clone_failed', detail });
    return { ok: false, reason: 'clone_failed', detail: `quarantine ディレクトリを作成できません: ${detail}` };
  }
  if (fs.existsSync(quarantinePath)) {
    log.warn('acquire: overwriting existing skill quarantine for same dedup key', {
      quarantinePath,
      owner,
      name,
      skill,
    });
  }
  removeQuarantine(quarantinePath);

  const env = getChildProcEnv();
  const baseSpawn = { env, stdio: 'pipe' as const, encoding: 'utf-8' as const };

  // 2. partial clone (blobless + 非展開)
  const clone = spawnSync(
    'git',
    ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', cloneUrl, quarantinePath],
    { ...baseSpawn, timeout: CLONE_TIMEOUT_MS },
  );
  if (clone.status !== 0) {
    const detail = spawnDetail(clone, 'git');
    removeQuarantine(quarantinePath);
    log.warn('acquire failed (skill)', { repo: `${owner}/${name}`, skill, reason: 'clone_failed', detail });
    return {
      ok: false,
      reason: 'clone_failed',
      detail: `partial clone に失敗しました: ${owner}/${name} (${detail})`,
    };
  }

  // 3. sparse-checkout init --cone
  const sparseInit = spawnSync('git', ['-C', quarantinePath, 'sparse-checkout', 'init', '--cone'], {
    ...baseSpawn,
    timeout: GH_TIMEOUT_MS,
  });
  if (sparseInit.status !== 0) {
    const detail = spawnDetail(sparseInit, 'git');
    removeQuarantine(quarantinePath);
    log.warn('acquire failed (skill)', { repo: `${owner}/${name}`, skill, reason: 'clone_failed', detail });
    return {
      ok: false,
      reason: 'clone_failed',
      detail: `sparse-checkout init に失敗しました: ${owner}/${name} (${detail})`,
    };
  }

  // 4. sparse-checkout set <skill>
  const sparseSet = spawnSync('git', ['-C', quarantinePath, 'sparse-checkout', 'set', skill], {
    ...baseSpawn,
    timeout: GH_TIMEOUT_MS,
  });
  if (sparseSet.status !== 0) {
    const detail = spawnDetail(sparseSet, 'git');
    removeQuarantine(quarantinePath);
    log.warn('acquire failed (skill)', { repo: `${owner}/${name}`, skill, reason: 'clone_failed', detail });
    return {
      ok: false,
      reason: 'clone_failed',
      detail: `sparse-checkout set に失敗しました: ${owner}/${name}/${skill} (${detail})`,
    };
  }

  // 5. checkout (sparse pattern に従って worktree 展開、blob を遅延 fetch)
  const checkout = spawnSync('git', ['-C', quarantinePath, 'checkout'], {
    ...baseSpawn,
    timeout: CLONE_TIMEOUT_MS,
  });
  if (checkout.status !== 0) {
    const detail = spawnDetail(checkout, 'git');
    removeQuarantine(quarantinePath);
    log.warn('acquire failed (skill)', { repo: `${owner}/${name}`, skill, reason: 'clone_failed', detail });
    return {
      ok: false,
      reason: 'clone_failed',
      detail: `checkout に失敗しました: ${owner}/${name}/${skill} (${detail})`,
    };
  }

  // 6. manifest 存在チェック (= skill dir 直下 + 任意階層に SKILL.md がある = agentskills.io spec)。
  //    全体経路の hasManifest は marketplace.json + SKILL.md だが、sparse 経路では
  //    marketplace.json は (skill dir に無いため) 探索対象外。SKILL.md 存在のみ確認する。
  const skillDir = path.join(quarantinePath, skill);
  if (!fs.existsSync(skillDir)) {
    removeQuarantine(quarantinePath);
    log.warn('acquire failed (skill)', {
      repo: `${owner}/${name}`,
      skill,
      reason: 'manifest_missing',
      detail: 'skill dir not found',
    });
    return {
      ok: false,
      reason: 'manifest_missing',
      detail: `skill ディレクトリが見つかりません: ${owner}/${name}/${skill} (sparse-checkout に該当 dir が含まれていません)`,
    };
  }
  if (!hasFileRecursive(skillDir, 'SKILL.md')) {
    removeQuarantine(quarantinePath);
    log.warn('acquire failed (skill)', {
      repo: `${owner}/${name}`,
      skill,
      reason: 'manifest_missing',
      detail: 'SKILL.md not found',
    });
    return {
      ok: false,
      reason: 'manifest_missing',
      detail: `biblio ではありません (SKILL.md 不在): ${owner}/${name}/${skill}`,
    };
  }

  log.info('biblio acquired (skill)', { repo: `${owner}/${name}`, skill, biblioName, quarantinePath });
  return { ok: true, biblioName, quarantinePath };
}

/**
 * 外部 biblio を取得して quarantine に配置する。
 * 失敗は全て `{ ok:false, reason, detail }` で返す (throw しない / silent failure なし)。
 *
 * @param req repo (= `owner/repo` or GitHub URL)
 * @param opts ctx (= request_id / session_id ログ伝搬、Phase 2 で確立した patron 依頼単位の trace 経路)
 */
export async function acquire(req: AcquireRequest, opts: { ctx?: GhFetchCtx } = {}): Promise<AcquireResult> {
  const normalized = normalizeRepo(req.repo);
  if (!normalized) {
    log.warn('acquire failed', { repo: req.repo, skill: req.skill, reason: 'invalid_input' });
    return { ok: false, reason: 'invalid_input', detail: `owner/repo か GitHub URL を指定してください: "${req.repo}"` };
  }

  // Phase 3: 個別 skill 仕入れ (req.skill or normalized.skill のいずれか) は sparse-checkout 経路に分岐。
  // skill 指定が無い場合 (= req.skill === undefined && normalized.skill === undefined) は既存全体経路に進む。
  const skill = req.skill ?? normalized.skill;
  if (skill !== undefined) {
    // skill 値が後続の sparse-checkout に渡るため、入口で SEGMENT_RE 検証する防衛線。
    // 3 segments 経路 (normalized.skill) は normalizeRepo で検証済だが、MCP tool 経路 (req.skill) は
    // ここまでトリムのみで来るため、両経路を同基準で再検証する (= 二重検証だが冪等)。
    if (!SEGMENT_RE.test(skill)) {
      log.warn('acquire failed', { repo: req.repo, skill, reason: 'invalid_input' });
      return {
        ok: false,
        reason: 'invalid_input',
        detail: `skill は識別子形式 (先頭 [A-Za-z0-9]、続き [A-Za-z0-9._-]、主に kebab-case) で指定してください: "${skill}"`,
      };
    }
    // 個別 skill 経路は全体経路 (gh / countSkillsInRepo / 全体 clone) を完全に bypass する。
    // sparse-checkout の git clone 自体が repo 存在確認を兼ねる (= clone_failed で 404 detect)。
    return await fetchSkillSubtree(normalized.owner, normalized.name, skill, normalized.cloneUrl);
  }

  const { owner, name, cloneUrl } = normalized;
  const env = getChildProcEnv();
  const baseSpawn = { env, stdio: 'pipe' as const, encoding: 'utf-8' as const };

  // 1. 存在確認 (= GET /repos/{owner}/{name})。`ghFetch` は undici fetch + global
  //    ProxyAgent (= `initHostProxy` で設定) 経由で OneCLI proxy に乗り、proxy 側で
  //    Authorization: Bearer <installation-token> を wire 置換する (= shelve /
  //    unshelve / list-biblio で本番動作実証済の経路)。orchestrator container 内に
  //    gh CLI の local credential (`gh auth login` / `GH_TOKEN`) を持つ必要が無い。
  //
  //    分岐: 404 → not_found / 他 status → internal / network エラー (timeout 含む)
  //    → internal。GitHub は private/不在いずれも 404 を返す仕様 (= 旧 gh api 経路と
  //    同じ)。401/403/5xx は OneCLI 認証経路 or GitHub 障害を示唆するため、patron
  //    に誤解させず `internal` で明示する (silent failure 防止)。
  try {
    await ghFetch('acquire.check-repo', `${GITHUB_API}/repos/${owner}/${name}`, {}, { ctx: opts.ctx });
  } catch (err) {
    if (err instanceof GhHttpError) {
      if (err.status === 404) {
        log.warn('acquire failed', { repo: `${owner}/${name}`, reason: 'not_found', status: 404 });
        return { ok: false, reason: 'not_found', detail: `repo が見つかりません: ${owner}/${name}` };
      }
      log.error('acquire: GitHub API error', {
        repo: `${owner}/${name}`,
        reason: 'internal',
        status: err.status,
        body: err.body,
      });
      return {
        ok: false,
        reason: 'internal',
        detail: `GitHub API エラー: ${owner}/${name} (status=${err.status}, ${err.body.slice(0, 100)})`,
      };
    }
    const detail = err instanceof Error ? err.message : String(err);
    log.error('acquire: fetch error', { repo: `${owner}/${name}`, reason: 'internal', detail });
    return {
      ok: false,
      reason: 'internal',
      detail: `GitHub API への接続に失敗: ${owner}/${name} (${detail})`,
    };
  }

  // Phase 2: 閾値チェック — repo の skill 数が `ACQUIRE_SKILL_THRESHOLD` を超えるなら
  // git clone する前に early return し、patron に個別指定 (`<owner>/<repo>/<skill>`) を促す。
  // `countSkillsInRepo` が unknown (= API 失敗 / Git Trees truncated) を返した場合は判定を
  // skip して全体仕入れに進む (= 既存挙動の維持。後段 `MAX_BLOBS_PER_PR=100` fail-closed が
  // backup として効くため、未知の repo を意図せず狭めるより保守的)。
  const threshold = resolveSkillThreshold();
  const countResult = await countSkillsInRepo(owner, name);
  if (!countResult.ok) {
    // `countSkillsInRepo` 内で warn は出ているが、acquire() 側でも skip 事実を記録する。
    // 「閾値判定なしで clone に進んだ仕入れ」を後段の `biblio acquired` log line から
    // reverse-trace するときの audit 連鎖を切らないため (silent-failure-hunter HIGH 1)。
    log.warn('acquire: skill count failed, skipping threshold check', {
      repo: `${owner}/${name}`,
      reason: countResult.reason,
    });
  }
  if (countResult.ok && countResult.count > threshold) {
    log.info('acquire blocked by threshold', {
      repo: `${owner}/${name}`,
      count: countResult.count,
      threshold,
    });
    return {
      ok: false,
      reason: 'threshold_exceeded',
      detail: [
        `仕入れる数が多い (${countResult.count} 個、上限 ${threshold} 個) ため、欲しい skill を個別に指定してください。`,
        `例: \`@bot 仕入れて ${owner}/${name}/<skill-name>\``,
        `※ skill 一覧は仕入先 repo (https://github.com/${owner}/${name}) をブラウザでご確認ください。`,
      ].join('\n'),
    };
  }

  // 2. quarantine 配置先 (biblioName = `<owner>--<name>` の dedup key)。
  //
  // M2 PRD B Phase 1 (= 仕入れ初期実装) では `biblioName = name` だったが、別 owner の同名 repo が
  // 同じ quarantine dir を奪い合う silent failure を産んでいた (= M2 PRD B Phase 3 (= 陳列) で
  // 別 owner の同名 biblio をすり替えるリスク)。GitHub 規約上 `/` は owner/repo に
  // 含まれず、`--` は通常 repo 名に出現しない (= 衝突可能性は実務上ゼロ) ため、
  // dedup key かつ shelf entry name として安全に使える形式 (M2 PRD B Phase 3 §補足)。
  const biblioName = `${owner}--${name}`;
  const quarantinePath = path.join(QUARANTINE_DIR, biblioName);
  try {
    fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('acquire failed', { repo: `${owner}/${name}`, reason: 'clone_failed', detail });
    return { ok: false, reason: 'clone_failed', detail: `quarantine ディレクトリを作成できません: ${detail}` };
  }
  // 既存上書きを silent にしない (= 同じ biblio の再仕入れ意図か事故か区別できるよう warn を残す)。
  if (fs.existsSync(quarantinePath)) {
    log.warn('acquire: overwriting existing quarantine for same dedup key', {
      quarantinePath,
      owner,
      name,
    });
  }
  removeQuarantine(quarantinePath); // 冪等上書き

  // 3. git clone (HTTPS / proxy 経由 / shallow)。
  const clone = spawnSync('git', ['clone', '--depth', '1', cloneUrl, quarantinePath], {
    ...baseSpawn,
    timeout: CLONE_TIMEOUT_MS,
  });
  if (clone.status !== 0) {
    const detail = spawnDetail(clone, 'git');
    removeQuarantine(quarantinePath);
    log.warn('acquire failed', { repo: `${owner}/${name}`, reason: 'clone_failed', detail });
    return { ok: false, reason: 'clone_failed', detail: `clone に失敗しました: ${owner}/${name} (${detail})` };
  }

  // 4. manifest 存在チェック (取得成立条件)。無ければ quarantine 破棄。
  if (!hasManifest(quarantinePath)) {
    removeQuarantine(quarantinePath);
    log.warn('acquire failed', { repo: `${owner}/${name}`, reason: 'manifest_missing' });
    return {
      ok: false,
      reason: 'manifest_missing',
      detail: `biblio ではありません (marketplace.json / SKILL.md 不在): ${owner}/${name}`,
    };
  }

  log.info('biblio acquired', { repo: `${owner}/${name}`, biblioName, quarantinePath });
  return { ok: true, biblioName, quarantinePath };
}
