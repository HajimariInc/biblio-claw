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
  /**
   * 個別 skill 仕入れ指定 (任意、Phase 1 で追加)。
   * MCP tool `acquire_biblio` 経由で agent が `{ repo: 'owner/name', skill: '<skill>' }`
   * の 2 arg 分離で渡したとき、または `acquire-action` 直叩き経路でここに来る。
   */
  skill?: string;
}

/** 正規化済みの取得対象。 */
export interface NormalizedRepo {
  owner: string;
  name: string;
  /** HTTPS clone URL (`https://github.com/<owner>/<name>.git`)。SSH は使わない。 */
  cloneUrl: string;
  /**
   * 3 segments 入力 (`owner/repo/skill`) を normalizeRepo が直接受け取ったときのみ立つ。
   * MCP tool 経由では `AcquireRequest.skill` に来るため通常未定義。
   * `acquire()` では `req.skill ?? normalized.skill` でどちらの経路も吸収する。
   */
  skill?: string;
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
  | 'clone_failed'
  /**
   * 仕入先 repo 内の skill 数が `ACQUIRE_SKILL_THRESHOLD` (既定 10) を超過 (Phase 2)。
   * 全体仕入れすると後段 (`MAX_BLOBS_PER_PR=100`) で確実に拒否されるため、clone 前に
   * early return する (= patron への promote 文言は `detail` に動的生成、
   * `acquire-action.ts:resultText` がそのまま素通しで Slack に流す)。
   * skill 数 count が unknown (= API 失敗 / Git Trees truncated) の repo は閾値判定を
   * skip して clone 経路に倒すため、本理由で early return するのは「count に成功し
   * かつ閾値超過」が確定したケースのみ。
   */
  | 'threshold_exceeded';

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
  /** Vertex × Gemini (`INSPECT_DANGEROUS_MODEL`、既定 `gemini-2.5-flash`) が DANGEROUS 判定 → REJECT。 */
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

/**
 * カテゴライズ + 陳列 (Phase 3) の型。
 *
 * ACCEPT 済 biblio を 4 namespace に判定し (`categorize`)、patron 承認後に
 * 棚リポへ移動 + draft PR を作成する (`shelve`)。決定的ロジックは `categorize.ts` /
 * `shelve.ts` に集約し、ここでは形だけ定義する (minimal-wrap)。
 */

/**
 * 棚 namespace の確定 4 値 (PRD B §解決策の詳細 / functions §3.4 / §5.1)。
 *
 * - `biblio-dev`: 開発系 skill (コード生成 / refactor / 設計助言 等)
 * - `biblio-art`: クリエイティブ系 (画像 / 文章 / 音 / 動画 等)
 * - `biblio-bf`: バックオフィス系 (秘書 / メール / 経理 等)
 * - `biblio-ai`: AI 運用系 (LLM オーケストレーション / プロンプト管理 等)
 *
 * 配列とリテラルの整合性を `as const` で型 → 配列の単一 source of truth として担保する
 * (= ランタイム validate 用の `VALID_CATEGORIES` は本配列を直接参照、3 箇所複製しない)。
 */
export const BIBLIO_CATEGORIES = ['biblio-dev', 'biblio-art', 'biblio-bf', 'biblio-ai'] as const;
export type BiblioCategory = (typeof BIBLIO_CATEGORIES)[number];

/** カテゴライズ失敗の分類。 */
export type CategoryFailureReason =
  /** quarantine 配下に biblio dir が存在しない / 読めない (= LLM 呼び前の入力検証エラー)。 */
  | 'quarantine_missing'
  /** Vertex × Anthropic 呼び出しの fetch / proxy / 4xx / 5xx / response 構造崩れ。 */
  | 'llm_error'
  /** LLM 応答に `CATEGORY:` / `REASON:` の必須 2 行が揃わない or 空。 */
  | 'parse_error'
  /** `CATEGORY:` 行は取れたが BiblioCategory に含まれない値が返った (例: `biblio-other`)。 */
  | 'invalid_category';

/**
 * カテゴライズ結果。discriminated union — `ok` で分岐する。
 * 成功時は判定 category + 理由 1 文、失敗時は理由 + 詳細を持つ (silent failure 防止)。
 */
export type CategoryResult =
  | { ok: true; biblioName: string; category: BiblioCategory; reason: string }
  | { ok: false; biblioName: string; reason: CategoryFailureReason; detail: string };

/** 陳列失敗の分類。 */
export type ShelveFailureReason =
  /** `marketplace.json` に同 key (`owner--repo`) の entry が既存 = 重複検知で early return。 */
  | 'already_shelved'
  /** quarantine 配下に biblio dir が存在しない (= acquire 未済 or 既に移動済)。 */
  | 'quarantine_missing'
  /** Git Data API / Pulls API の non-2xx response (step + status + body を detail に含む)。 */
  | 'github_api_error'
  /** quarantine → shelf の `fs.rename` 失敗 (`EXDEV` / `EACCES` / `ENOSPC` 等)。 */
  | 'rename_error'
  /** `category` パラメータが `BiblioCategory` の 4 値に含まれない (= action handler 入口防御線)。 */
  | 'invalid_category';

/**
 * 陳列結果。discriminated union — `ok` で分岐する。
 * 成功時は PR URL + branch、失敗時は理由 + 詳細を持つ (silent failure 防止)。
 */
export type ShelveResult =
  | { ok: true; biblioName: string; category: BiblioCategory; prUrl: string; prNumber: number; branchName: string }
  | { ok: false; biblioName: string; reason: ShelveFailureReason; detail: string };
