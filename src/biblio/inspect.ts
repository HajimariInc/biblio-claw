/**
 * 検品本体 — quarantine に置かれた biblio を 3 軸で検査し ACCEPT/HOLD/REJECT を決定する。
 *
 * cheap-to-expensive 順 (= fail-fast):
 *   1. 存在確認: quarantine が読めない                          → HOLD/inspect_error
 *   2. schema : `.claude-plugin/plugin.json` parse + 必須フィールド (name) → REJECT/schema_invalid
 *   3. license: `plugin.json.license` を allow/deny 照合         → HOLD/license_denied|license_unknown
 *   4. dangerous: SKILL.md / *.sh / *.py / *.js を集約 → Vertex × Gemini に判定させる
 *                                                                → REJECT/dangerous_code or ACCEPT
 *                  parse 失敗・LLM 例外は HOLD/inspect_error (fail-closed)
 *
 * dangerous 軸の LLM 選択 (用途規約 = CLAUDE.md / DEN さん指針):
 *   - 検品は NanoClaw ネイティブの補助推論であり、skill 発動には絡まない (VERDICT 1 行判定のみ)
 *   - Claude 特性 (長文推論 / extended thinking / tool use) を要求しない
 *   - = Google モデル可。`.env` の `INSPECT_DANGEROUS_MODEL` (例: `gemini-2.5-flash`) で指定
 *   - ハードコードは不可 (DEN さん指示): モデル ID をコードに埋め込まず env / secret manager 経由
 *
 * 設計判断 (plan §補足):
 *   - host に claude CLI が無いため PoC-14 の `claude plugin validate --strict` 写経は不採用、
 *     必須フィールド検証で代替 (auto memory `biblio-design-overthinking-avoidance` 準拠)。
 *   - schema 軸を独立ゲートとして残すのは「LLM に答えさせる前に構造的に成立しているかを確かめる」
 *     fail-fast 設計 (= 計算コスト最適化ではなく早期切上げ)。
 *   - throw しない方針: LLM 例外は内部 try/catch で握り HOLD に変換 (silent failure 禁止)。
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import type { InspectFailureReason, InspectOptions, InspectResult } from './types.js';
import { callVertexGemini } from './vertex-client.js';

/** 本文集約時の再帰深さ上限 (`acquire.ts` の MANIFEST_SCAN_MAX_DEPTH と同値で揃える)。 */
const FILE_SCAN_MAX_DEPTH = 6;

/** dangerous 軸で集約対象とするファイル名パターン (PoC-14 inspect.sh:62 と同セット)。 */
const DANGEROUS_SCAN_EXTENSIONS = new Set(['.sh', '.py', '.js']);
const DANGEROUS_SCAN_NAMES = new Set(['SKILL.md']);

/** allow ライセンス (改変可)。PoC-14 inspect.sh:44 と同セット。 */
const ALLOW_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'CC-BY-4.0',
  'CC0-1.0',
  'Unlicense',
]);

/** deny ライセンス検出パターン (改変不可)。PoC-14 inspect.sh:36 と同セット。 */
const DENY_LICENSE_PATTERNS = ['-ND', 'NoDerivatives', 'Proprietary'];

/**
 * dangerous 軸 LLM の max_tokens。VERDICT 1 行 + αが入る程度。
 * 64 まで切り詰めると Gemini の応答崩れ時 (= プロンプト揺らぎで文章前置きが出るケース) に
 * VERDICT 行へ到達できず HOLD/inspect_error が増えるため、256 で余裕を持たせる。
 * thinking 自体は vertex-client.ts で `thinkingBudget: 0` で OFF にしているので、
 * 余分な tokens は thinking ではなく生テキスト出力に使われる。
 */
const DANGEROUS_MAX_TOKENS = 256;

/** dangerous 軸 LLM の temperature (決定性目的で 0 固定)。 */
const DANGEROUS_TEMPERATURE = 0;

/** dangerous プロンプト (PoC-14 inspect.sh:64-76 写経)。 */
const DANGEROUS_PROMPT = `あなたは biblio-shelf の検品官です。以下に配布候補の skill/plugin の本文を示します。
次の危険パターンのいずれかが本文に含まれているかを判定してください:
  - 破壊的操作 (例: rm -rf, ファイル/ディレクトリの一括削除)
  - secret・認証情報の外部送信 (例: env や認証情報を外部サーバへ POST)
  - 任意コード実行 (例: curl ... | sh, wget ... | bash, eval で受信文字列を実行)
免責コメント (「実行しない」「テスト用」等) が付いていても、危険パターンが本文に
存在すれば DANGEROUS と判定してください。まったく含まれなければ CLEAN です。
説明や前置きは不要。出力の最終行に必ず「VERDICT: DANGEROUS」または
「VERDICT: CLEAN」のいずれか 1 行だけを出してください。

----- 検品対象本文ここから -----`;

/** HOLD/REJECT 結果の組み立てヘルパ (型エラー回避)。 */
function fail(
  verdict: 'HOLD' | 'REJECT',
  biblioName: string,
  reason: InspectFailureReason,
  detail: string,
): InspectResult {
  return { verdict, biblioName, reason, detail };
}

/**
 * `<dir>` 配下を深さ制限付きで走査し、対象拡張子/ファイル名にマッチしたパスを集める。
 * `.git` / `node_modules` は除外。`acquire.ts:hasFileRecursive` と同形だが、集約版。
 */
function collectScanTargets(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string, depth: number): void {
    if (depth > FILE_SCAN_MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // EACCES / ENOENT (symlink 切れ) / EMFILE (FD 枯渇) などの I/O 障害を silent
      // skip するとスキャンが部分的に縮退し、危険コードを見落とした ACCEPT に
      // 倒れる経路を作る。inspect() 側で「targets 数」と「読み成功本文の長さ」で
      // fail-closed に倒すが、検知の根拠としてここで必ず可視化する (silent failure 防止)。
      log.warn('inspect: directory unreadable during scan', { dir, depth, err });
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (DANGEROUS_SCAN_NAMES.has(entry.name) || DANGEROUS_SCAN_EXTENSIONS.has(ext)) {
          out.push(path.join(dir, entry.name));
        }
      }
    }
  }
  walk(root, 0);
  return out.sort();
}

/**
 * dangerous 軸の本文を `----- FILE: <path> -----` 区切りで連結する。
 * `targets` は呼び出し側 (`inspect()`) で先に取得し、`targets.length === 0` を
 * inspect() で fail-closed に倒すため、ここでは 0 件入力時も `''` を返すだけ。
 * 個別ファイル読み失敗は WARN ログを出して skip し、本文には混ぜない (silent skip
 * しない: collectScanTargets と同じ silent failure 防止)。
 */
function buildBody(targets: string[], root: string): string {
  if (targets.length === 0) return '';
  const chunks: string[] = [];
  for (const file of targets) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      log.warn('inspect: file unreadable, skipping', { file, err });
      continue;
    }
    const rel = path.relative(root, file);
    chunks.push(`\n----- FILE: ${rel} -----\n${content}`);
  }
  return chunks.join('');
}

/** license が deny パターン (-ND / NoDerivatives / Proprietary) を含むか判定する。 */
function isLicenseDenied(license: string): boolean {
  return DENY_LICENSE_PATTERNS.some((pattern) => license.includes(pattern));
}

/**
 * 検品本体。
 *
 * @param req `biblioName` で quarantine 内の対象を指す (`acquire()` 成功時の `biblioName` を渡す)。
 * @param opts `quarantineRoot` でテスト/verify 用に親ディレクトリを上書きできる。未指定なら `${DATA_DIR}/quarantine`。
 * @returns ACCEPT / HOLD / REJECT のいずれか。throw しない (失敗は HOLD/inspect_error に倒す)。
 */
export async function inspect(req: { biblioName: string }, opts: InspectOptions = {}): Promise<InspectResult> {
  const { biblioName } = req;
  const quarantineRoot = opts.quarantineRoot ?? path.join(DATA_DIR, 'quarantine');
  const targetPath = path.join(quarantineRoot, biblioName);

  // --- 1. 存在確認 ---
  // `fs.statSync` 系は「読めるが Stats が返るだけ」のため戻り値判定が必要になる。
  // `fs.promises.access(..., R_OK)` は「読めるか」を 1 発で表現できる。
  try {
    await fs.promises.access(targetPath, fs.constants.R_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
    log.warn('inspect: quarantine not accessible', { biblioName, targetPath, code });
    return fail('HOLD', biblioName, 'inspect_error', `quarantine path not accessible: ${code} (${targetPath})`);
  }

  // --- 2. schema 軸 ---
  const pluginJsonPath = path.join(targetPath, '.claude-plugin', 'plugin.json');
  let pluginRaw: string;
  try {
    pluginRaw = fs.readFileSync(pluginJsonPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
    log.warn('inspect: plugin.json unreadable', { biblioName, pluginJsonPath, code });
    return fail('REJECT', biblioName, 'schema_invalid', `.claude-plugin/plugin.json が読めません: ${code}`);
  }
  let plugin: Record<string, unknown>;
  try {
    plugin = JSON.parse(pluginRaw) as Record<string, unknown>;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('inspect: plugin.json parse failed', { biblioName, detail });
    return fail('REJECT', biblioName, 'schema_invalid', `.claude-plugin/plugin.json が不正 JSON: ${detail}`);
  }
  if (typeof plugin.name !== 'string' || plugin.name.length === 0) {
    log.warn('inspect: plugin.json missing required field "name"', { biblioName });
    return fail(
      'REJECT',
      biblioName,
      'schema_invalid',
      '.claude-plugin/plugin.json に必須フィールド "name" がありません',
    );
  }

  // --- 3. license 軸 ---
  const licenseValue = plugin.license;
  if (typeof licenseValue !== 'string' || licenseValue.length === 0) {
    log.warn('inspect: license missing', { biblioName });
    return fail('HOLD', biblioName, 'license_unknown', 'plugin.json.license が指定されていません (allow リスト未照合)');
  }
  if (isLicenseDenied(licenseValue)) {
    log.warn('inspect: license denied', { biblioName, license: licenseValue });
    return fail('HOLD', biblioName, 'license_denied', `改変不可ライセンス (再配布禁止): ${licenseValue}`);
  }
  if (!ALLOW_LICENSES.has(licenseValue)) {
    log.warn('inspect: license unknown', { biblioName, license: licenseValue });
    return fail('HOLD', biblioName, 'license_unknown', `allow リストに無いライセンス: ${licenseValue}`);
  }

  // --- 4. dangerous 軸 (LLM) ---
  //
  // 4a. スキャン対象 0 件 = SKILL.md / *.sh / *.py / *.js を一切持たない biblio。
  //     LLM に空入力を渡せば「危険パターンなし → CLEAN → ACCEPT」と返るが、それは
  //     「検品官が中身を見ずに ACCEPT を返した」silent failure。安全側で HOLD に倒す
  //     (= LLM 呼び出しコストもゼロ + fail-closed 維持)。
  const targets = collectScanTargets(targetPath);
  if (targets.length === 0) {
    log.warn('inspect: no scan targets — fail-closed → HOLD', { biblioName });
    return fail(
      'HOLD',
      biblioName,
      'inspect_error',
      'dangerous 軸: スキャン対象ファイル (SKILL.md / *.sh / *.py / *.js) が存在しません',
    );
  }

  // 4b. スキャン対象は見つかったが全件読み失敗 (EACCES / EMFILE 等) = LLM に渡せる
  //     本文がない → CLEAN 返却で ACCEPT に倒れる経路を塞ぐため fail-closed → HOLD。
  const body = buildBody(targets, targetPath);
  if (body.length === 0) {
    log.warn('inspect: all scan targets unreadable — fail-closed → HOLD', {
      biblioName,
      targetCount: targets.length,
    });
    return fail(
      'HOLD',
      biblioName,
      'inspect_error',
      `dangerous 軸: スキャン対象 ${targets.length} 件すべてが読めませんでした`,
    );
  }

  const prompt = `${DANGEROUS_PROMPT}\n${body}\n----- 検品対象本文ここまで -----`;
  let llmOutput: string;
  try {
    llmOutput = await callVertexGemini({
      prompt,
      maxOutputTokens: DANGEROUS_MAX_TOKENS,
      temperature: DANGEROUS_TEMPERATURE,
    });
  } catch (err) {
    // LLM 経路失敗 (proxy 未到達 / 4xx/5xx / 応答崩れ) は HOLD に倒す (fail-closed)。
    const detail = err instanceof Error ? err.message : String(err);
    log.warn('inspect: dangerous LLM call failed (fail-closed → HOLD)', { biblioName, detail });
    return fail('HOLD', biblioName, 'inspect_error', `dangerous 軸の LLM 呼び出しに失敗: ${detail}`);
  }

  // VERDICT 行を抽出 (PoC-14 と同じく最終行に近い `VERDICT: DANGEROUS|CLEAN` を期待)。
  // 末尾優先 = LLM が前置きを出した後に最終 VERDICT を出すケース、または複数 VERDICT を
  // 出すケース (test ケース「VERDICT 行が複数あれば末尾を優先する」) で正しく動く。
  // ES2023 `findLast` が使えれば 1 メソッドで書けるが、tsconfig が ES2022 のため
  // `.reverse().find()` を維持 (`reverse` は新配列を返すので破壊的影響なし)。
  const verdictLine = llmOutput
    .split('\n')
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.startsWith('VERDICT:'));
  if (!verdictLine) {
    log.warn('inspect: dangerous LLM output missing VERDICT line (fail-closed → HOLD)', {
      biblioName,
      outputHead: llmOutput.slice(0, 200),
    });
    return fail('HOLD', biblioName, 'inspect_error', 'dangerous 軸 LLM 応答に VERDICT 行が含まれていません');
  }
  if (verdictLine.includes('DANGEROUS')) {
    log.info('inspect: dangerous=DANGEROUS → REJECT', { biblioName });
    return fail(
      'REJECT',
      biblioName,
      'dangerous_code',
      '本文に危険パターン (破壊操作/secret 送出/任意コード実行) を検出',
    );
  }
  if (verdictLine.includes('CLEAN')) {
    log.info('biblio inspected', { biblioName, verdict: 'ACCEPT' });
    return { verdict: 'ACCEPT', biblioName };
  }
  // VERDICT 行は取れたが DANGEROUS / CLEAN のどちらでもない (= 応答崩れ)。
  log.warn('inspect: dangerous LLM verdict unrecognized (fail-closed → HOLD)', { biblioName, verdictLine });
  return fail('HOLD', biblioName, 'inspect_error', `dangerous 軸 LLM 応答が判別不能: "${verdictLine}"`);
}
