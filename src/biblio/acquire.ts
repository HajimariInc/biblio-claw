/**
 * 仕入れ本体 — 外部 public biblio を取得して quarantine に配置する。
 *
 * patron の `owner/repo`(または GitHub URL)を起点に:
 *   normalizeRepo → ghFetch で存在確認 → git clone → quarantine 配置 →
 *   manifest (marketplace.json / SKILL.md) 存在チェック
 * を行う。決定的ロジックは全てここに集約し、`acquire.test.ts` で固める。
 *
 * 存在確認と git clone の経路差 + 採用理由 (WHY) はそれぞれの呼出ブロックの
 * インラインコメントに記述する。ここでは流れだけを示す。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import { getChildProcEnv } from './host-proxy.js';
import { GITHUB_API, GhHttpError, ghFetch } from './shelf-gh.js';
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
  if (segments.length !== 2) return null;

  const [owner, name] = segments;
  if (!SEGMENT_RE.test(owner) || !SEGMENT_RE.test(name)) return null;

  return { owner, name, cloneUrl: `https://github.com/${owner}/${name}.git` };
}

/** `<dir>` 配下を深さ制限付きで走査し、指定ファイル名が存在するか判定する (`.git` は除外)。 */
function hasFileRecursive(dir: string, filename: string, depth = 0): boolean {
  if (depth > MANIFEST_SCAN_MAX_DEPTH) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
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
 * Phase 1 は「存在チェック」のみ (schema 妥当性は Phase 2 検品)。
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
 * 外部 biblio を取得して quarantine に配置する。
 * 失敗は全て `{ ok:false, reason, detail }` で返す (throw しない / silent failure なし)。
 */
export async function acquire(req: AcquireRequest): Promise<AcquireResult> {
  const normalized = normalizeRepo(req.repo);
  if (!normalized) {
    log.warn('acquire failed', { repo: req.repo, reason: 'invalid_input' });
    return { ok: false, reason: 'invalid_input', detail: `owner/repo か GitHub URL を指定してください: "${req.repo}"` };
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
    await ghFetch('acquire.check-repo', `${GITHUB_API}/repos/${owner}/${name}`);
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

  // 2. quarantine 配置先 (biblioName = `<owner>--<name>` の dedup key)。
  //
  // Phase 1 では `biblioName = name` だったが、別 owner の同名 repo が同じ
  // quarantine dir を奪い合う silent failure を産んでいた (= Phase 3 で陳列が
  // 別ownerの同名 biblio をすり替えるリスク)。GitHub 規約上 `/` は owner/repo に
  // 含まれず、`--` は通常 repo 名に出現しない (= 衝突可能性は実務上ゼロ) ため、
  // dedup key かつ shelf entry name として安全に使える形式 (PRD B Phase 3 §補足)。
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
