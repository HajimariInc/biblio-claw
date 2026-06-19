/**
 * 仕入れ (shiire / acquire) の型。
 *
 * 外部 public biblio (= Claude Code plugin repo) を取得し quarantine に置く
 * 一連の入出力を表す。決定的ロジック (normalizeRepo / エラー分類) は
 * `acquire.ts` に集約し、ここでは形だけを定義する (minimal-wrap)。
 */

/** patron からの生入力 (`owner/repo` 短縮形 or GitHub URL)。 */
export interface AcquireRequest {
  repo: string;
}

/** 正規化済みの取得対象。 */
export interface NormalizedRepo {
  owner: string;
  name: string;
  /** HTTPS clone URL (`https://github.com/<owner>/<name>.git`)。SSH は使わない。 */
  cloneUrl: string;
}

/** 取得失敗の分類。 */
export type AcquireFailureReason =
  /** 入力が owner/repo にも URL にも解釈できない。 */
  | 'invalid_input'
  /** gh api が非 0 (404 等)。不在も非公開も GitHub は 404 を返す。timeout もここに含む。 */
  | 'not_found'
  /** clone は成功したが marketplace.json も SKILL.md も無い (biblio ではない)。 */
  | 'manifest_missing'
  /** git clone 自体が失敗 (network / proxy / 権限)。 */
  | 'clone_failed';

/**
 * 取得結果。discriminated union — `ok` で分岐する。
 * 成功時は配置先、失敗時は理由 + 人間可読な詳細を持つ (silent failure 防止)。
 */
export type AcquireResult =
  | { ok: true; biblioName: string; quarantinePath: string }
  | { ok: false; reason: AcquireFailureReason; detail: string };

/**
 * 検品 (kenpin / inspect) の型。
 *
 * quarantine に置かれた biblio を 3 軸 (schema → license → dangerous) で
 * cheap-to-expensive 順に検査し、ACCEPT / HOLD / REJECT を決定的に返す。
 * 決定的ロジックは `inspect.ts` に集約し、ここでは形だけを定義する (minimal-wrap)。
 */

/** 検品の最終判定。 */
export type InspectVerdict = 'ACCEPT' | 'HOLD' | 'REJECT';

/** 検品失敗の分類 (HOLD / REJECT に紐づく)。 */
export type InspectFailureReason =
  /** `.claude-plugin/plugin.json` が parse 不可 / 必須フィールド (name) 欠落 → REJECT。 */
  | 'schema_invalid'
  /** `-ND` / NoDerivatives / Proprietary など再配布不可ライセンス → HOLD。 */
  | 'license_denied'
  /** license フィールド不在 / allow リスト外 → HOLD。 */
  | 'license_unknown'
  /** LLM (Claude haiku via Vertex) が DANGEROUS 判定 → REJECT。 */
  | 'dangerous_code'
  /** quarantine 不在 / LLM 呼び出し失敗 / parse 失敗 → HOLD (fail-closed)。 */
  | 'inspect_error';

/**
 * 検品結果。discriminated union — `verdict` で分岐する。
 * ACCEPT は biblioName のみ、HOLD/REJECT は reason + 人間可読 detail を持つ (silent failure 防止)。
 */
export type InspectResult =
  | { verdict: 'ACCEPT'; biblioName: string }
  | { verdict: 'HOLD' | 'REJECT'; biblioName: string; reason: InspectFailureReason; detail: string };

/**
 * `inspect()` のオプション。
 *
 * `quarantineRoot` を opts で受けるのは `vi.stubEnv('DATA_DIR', ...)` がモジュール
 * load 時に const 束縛された `DATA_DIR` に効かない罠を回避するため (acquire.test.ts
 * で実証済)。prod 経路では未指定 → `${DATA_DIR}/quarantine` を inspect.ts 内で計算する。
 */
export interface InspectOptions {
  quarantineRoot?: string;
}
