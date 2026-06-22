/**
 * カテゴライズ本体 — ACCEPT 済 biblio を 4 namespace (biblio-dev/art/bf/ai) に判定する。
 *
 * 読みに行く 3 ソース:
 *   1. `.claude-plugin/plugin.json` の `description` (= 短い 1 行説明、最も信頼性高い)
 *   2. README.md / readme.md / README (= 任意階層、ルート直下優先)
 *   3. SKILL.md (= 任意階層、再帰探索)
 *
 * これらを連結して最大 `MAX_INPUT_BYTES` に切り詰め、Vertex × Anthropic on Vertex
 * (`CATEGORIZE_MODEL`、既定 `claude-sonnet-4-6`) に「CATEGORY / REASON の 2 行」で
 * 答えさせる。LLM 失敗・parse 失敗は throw せず `CategoryResult.ok=false` に倒し、
 * 判定理由は構造化ログ (Cloud Logging jsonPayload) に残す (PRD §意思決定ログ「カテゴライズ
 * 判定揺れは構造化ログに残すのみ」確定事項)。
 *
 * 用途規約 (CLAUDE.md): カテゴライズは skill 発動絡みの推論 = Anthropic 必須。Gemini 不可。
 * このゲートは `callVertexAnthropic` 側で env 名 (`CATEGORIZE_MODEL`) を分けて担保する。
 */
import fs from 'node:fs';
import path from 'node:path';

import { readEnvFile } from '../env.js';
import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import type { CategoryFailureReason, CategoryResult, InspectOptions } from './types.js';
import { BIBLIO_CATEGORIES, type BiblioCategory } from './types.js';
import { callVertexAnthropic } from './vertex-client.js';

/** 入力本文の上限 (バイト)。Sonnet-4.6 の context は十分広いが、コスト + プロンプト揺れを抑制する。 */
const MAX_INPUT_BYTES = 8 * 1024;

/** SKILL.md 再帰探索の深さ上限 (acquire.ts の MANIFEST_SCAN_MAX_DEPTH と同値)。 */
const SKILL_SCAN_MAX_DEPTH = 6;

/** 出力 token 上限。CATEGORY 1 行 + REASON 1 行で 200 程度に収まる想定で余裕を取る。 */
const CATEGORIZE_MAX_TOKENS = 256;

/** 決定性目的で 0 固定 (= 同 input で同 output)。 */
const CATEGORIZE_TEMPERATURE = 0;

/** プロンプト中で使う合法 category の集合 (== BiblioCategory)。`Set` は parse 後の validate にも使う。 */
const VALID_CATEGORIES = new Set<BiblioCategory>(BIBLIO_CATEGORIES);

/** system プロンプト — biblio 司書としての役割を固定する。 */
const SYSTEM_PROMPT = `あなたは biblio-shelf (Claude Code plugin の棚) の司書です。
patron が外部から取得した biblio (Claude Code plugin) を、次の 4 namespace のいずれか 1 つに分類してください:

- biblio-dev: 開発系 (コード生成 / refactor / 設計助言 / コードレビュー / プログラミング学習補助 等)
- biblio-art: クリエイティブ系 (画像生成 / 文章執筆 / 音楽 / 動画 / デザイン補助 等)
- biblio-bf:  バックオフィス系 (秘書 / メール / カレンダー / 経理 / 営業支援 等)
- biblio-ai:  AI 運用系 (LLM オーケストレーション / プロンプト管理 / agent 監視 / MCP server 構築 等)

判定が複数候補で迷う場合でも、最も主要な用途 1 つを選んでください。`;

/** user プロンプトの末尾 (出力フォーマットを厳密に指定する)。 */
const OUTPUT_INSTRUCTION = `以下の 2 行だけを、説明や前置きなく出力してください:

CATEGORY: biblio-<dev|art|bf|ai>
REASON: <なぜそのカテゴリに分類したかの理由を 1 文 (日本語可、100 字以内目安)>`;

/** `ok: false` の組み立てヘルパ (型エラー回避 + 重複削減)。 */
function fail(biblioName: string, reason: CategoryFailureReason, detail: string): CategoryResult {
  return { ok: false, biblioName, reason, detail };
}

/**
 * `<dir>` 配下を深さ制限付きで走査し、ファイル名一致を集める。
 * `.git` / `node_modules` を除外。`inspect.ts:collectScanTargets` 同形。
 */
function collectByName(root: string, target: string, depth = 0): string[] {
  if (depth > SKILL_SCAN_MAX_DEPTH) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    // I/O 障害は WARN + skip。本体スキャンが部分縮退するのを silent に許さない。
    log.warn('categorize: directory unreadable during scan', { root, depth, err });
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      out.push(...collectByName(path.join(root, entry.name), target, depth + 1));
    } else if (entry.isFile() && entry.name === target) {
      out.push(path.join(root, entry.name));
    }
  }
  return out.sort();
}

/** ルート直下の README を 1 件だけ探す (`README.md` → `readme.md` → `README` の順)。 */
function findRootReadme(root: string): string | null {
  for (const candidate of ['README.md', 'readme.md', 'README']) {
    const p = path.join(root, candidate);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

/**
 * plugin.json の description を読む。
 *
 * 失敗時 (= ENOENT / JSON 不正) は null を返して LLM 入力から外し、README / SKILL.md のみで
 * カテゴリ判定を続行する縮退設計。ただし plugin.json は categorize の **判定根拠として最も
 * 信頼性の高い情報源** (= 開発者が明示的に書いた biblio の役割記述) なので、欠落は warn で
 * 必ず可視化する (silent skip 禁止)。
 */
function readPluginDescription(root: string): string | null {
  const p = path.join(root, '.claude-plugin', 'plugin.json');
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err) {
    // ENOENT は biblio によっては自然 (= description なし)。それ以外は I/O 障害の可能性。
    const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
    if (code !== 'ENOENT') {
      log.warn('categorize: plugin.json unreadable (using README/SKILL.md only)', { p, code, err });
    }
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    log.warn('categorize: plugin.json invalid JSON (using README/SKILL.md only)', { p, err });
    return null;
  }
  const desc = parsed.description;
  return typeof desc === 'string' && desc.trim().length > 0 ? desc.trim() : null;
}

/** ファイル読み (失敗時は空文字 + WARN — silent skip しない)。 */
function readFileSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    log.warn('categorize: file unreadable, skipping', { filePath, err });
    return '';
  }
}

/**
 * 3 ソース (plugin.json description / README / SKILL.md) を連結し、`MAX_INPUT_BYTES` で切り詰める。
 * 区切りは `----- FILE: <rel> -----` 形式 (inspect.ts:buildBody と同流儀)。
 */
function buildBody(root: string): string {
  const chunks: string[] = [];
  const description = readPluginDescription(root);
  if (description) {
    chunks.push(`----- FILE: .claude-plugin/plugin.json (description) -----\n${description}`);
  }
  const readme = findRootReadme(root);
  if (readme) {
    const text = readFileSafe(readme);
    if (text.length > 0) {
      const rel = path.relative(root, readme);
      chunks.push(`----- FILE: ${rel} -----\n${text}`);
    }
  }
  for (const skillPath of collectByName(root, 'SKILL.md')) {
    const text = readFileSafe(skillPath);
    if (text.length === 0) continue;
    const rel = path.relative(root, skillPath);
    chunks.push(`----- FILE: ${rel} -----\n${text}`);
  }
  let body = chunks.join('\n\n');
  if (Buffer.byteLength(body, 'utf-8') > MAX_INPUT_BYTES) {
    // バイト単位で切ると multibyte 文字を割る可能性があるが、`Buffer.toString` で
    // 末尾の不完全 sequence は replacement character に置換されるだけ (= LLM 側は読める)。
    body = Buffer.from(body, 'utf-8').slice(0, MAX_INPUT_BYTES).toString('utf-8');
    body += '\n\n----- (本文はここで切り詰めました) -----';
  }
  return body;
}

/** CATEGORY 行から `biblio-<dev|art|bf|ai>` を抽出。 */
const CATEGORY_RE = /^\s*CATEGORY:\s*(biblio-(?:dev|art|bf|ai))\s*$/im;
/** REASON 行から `<reason>` を抽出 (改行なしの 1 行を想定)。 */
const REASON_RE = /^\s*REASON:\s*(.+?)\s*$/im;

/**
 * カテゴライズ本体。
 *
 * @param req `biblioName` は `<owner>--<name>` 形式 (Phase 3 で acquire.ts も統一)
 * @param opts `quarantineRoot` でテスト/verify 用に親ディレクトリを上書き可能。未指定なら `${DATA_DIR}/quarantine`
 * @returns CategoryResult (throw しない、失敗は ok=false に倒す)
 */
export async function categorize(req: { biblioName: string }, opts: InspectOptions = {}): Promise<CategoryResult> {
  const { biblioName } = req;
  const quarantineRoot = opts.quarantineRoot ?? path.join(DATA_DIR, 'quarantine');
  const targetPath = path.join(quarantineRoot, biblioName);

  // 1. 存在確認 (= R_OK で読める = ディレクトリと中身を見られる)
  try {
    fs.accessSync(targetPath, fs.constants.R_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
    log.warn('categorize: quarantine not accessible', { biblioName, targetPath, code });
    return fail(biblioName, 'quarantine_missing', `quarantine path not accessible: ${code} (${targetPath})`);
  }

  // 2. 本文収集 (plugin.json description / README / SKILL.md)
  const body = buildBody(targetPath);
  if (body.length === 0) {
    // 入力 0 で LLM を叩くと判定根拠ゼロの hallucination が出るリスクが大きいので fail-closed。
    log.warn('categorize: no readable description sources — fail-closed', { biblioName });
    return fail(
      biblioName,
      'parse_error',
      'カテゴライズ用の本文 (plugin.json description / README / SKILL.md) が読み取れません',
    );
  }

  // 3. LLM 呼び出し (Vertex × Sonnet-4.6)
  // modelId は callVertexAnthropic に明示的に渡す (= 内部の env 再読 fallback には依存しない、
  // 将来 callVertexAnthropic 側で env 解決を除去するリファクタが入ってもサイレント回帰しない)。
  const env = readEnvFile(['CATEGORIZE_MODEL']);
  const modelId = env.CATEGORIZE_MODEL;
  let llmOutput: string;
  try {
    llmOutput = await callVertexAnthropic(
      {
        system: SYSTEM_PROMPT,
        prompt: `${body}\n\n----- 本文ここまで -----\n\n${OUTPUT_INSTRUCTION}`,
        maxTokens: CATEGORIZE_MAX_TOKENS,
        temperature: CATEGORIZE_TEMPERATURE,
        modelId: modelId ?? undefined,
      },
      { ...opts.ctx, axis: 'categorize', biblioName },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('categorize: LLM call failed', { biblioName, detail });
    return fail(biblioName, 'llm_error', `Vertex × Anthropic 呼び出しに失敗: ${detail}`);
  }

  // 4. CATEGORY / REASON 2 行を抽出
  const categoryMatch = llmOutput.match(CATEGORY_RE);
  const reasonMatch = llmOutput.match(REASON_RE);
  if (!categoryMatch || !reasonMatch) {
    log.warn('categorize: LLM output missing CATEGORY/REASON lines', {
      biblioName,
      outputHead: llmOutput.slice(0, 300),
      hasCategory: Boolean(categoryMatch),
      hasReason: Boolean(reasonMatch),
    });
    return fail(
      biblioName,
      'parse_error',
      `LLM 応答に CATEGORY / REASON 行が揃いません — 応答冒頭: "${llmOutput.slice(0, 200)}"`,
    );
  }

  const category = categoryMatch[1] as BiblioCategory;
  if (!VALID_CATEGORIES.has(category)) {
    log.warn('categorize: invalid category value returned', { biblioName, category });
    return fail(biblioName, 'invalid_category', `LLM が想定外の category を返しました: "${category}"`);
  }

  const reason = reasonMatch[1];
  // PRD §意思決定ログ: 判定理由 + (将来 patron 変更 category) を構造化ログに残す。集計は M4 観測。
  log.info('categorize: ok', { biblioName, category, reason, model: modelId });
  return { ok: true, biblioName, category, reason };
}
