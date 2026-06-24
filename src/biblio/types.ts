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
  /** ghFetch が 404 を返した。GitHub は不在も非公開も 404 で返すため両方含む。 */
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
  | 'threshold_exceeded'
  /** GitHub API 経路の構成不備 (= 401/403/5xx、network エラー、proxy 到達不可、timeout 等)。
   *  patron は手で対処できず、運用者が OneCLI proxy / token / GitHub 障害を確認する必要がある。 */
  | 'internal';

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
 * load 時に const 束縛された `DATA_DIR` に効かない罠を回避するため。prod 経路では
 * 未指定 → `${DATA_DIR}/quarantine` を inspect.ts 内で計算する。
 */
export interface InspectOptions {
  quarantineRoot?: string;
  /** Vertex / ghFetch 呼び出しに propagate する追跡 context (`ShokyakuOptions.ctx` と同型)。 */
  ctx?: import('./shelf-gh.js').GhFetchCtx;
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

/**
 * 動的変更可能な biblio 設定キーの allowlist (個別 PRD Phase 5 dynamic-config)。
 *
 * `@bot 設定 <KEY> <VALUE>` の経路で patron が変更できるのは本配列の値のみ。
 * delivery action handler (`config-action.ts`) と MCP tool (`update_config`) は本配列を
 * single source として参照する (= 3 箇所に複製しない、`BIBLIO_CATEGORIES` と同流儀)。
 *
 * 追加判断: 新しい key を動的変更対象にしたいときは本配列に追記 + `acquire.ts` 等の
 * resolve 関数を DB → env → DEFAULT の 3 層に書き換える 2 箇所のみで完結する。
 */
export const BIBLIO_SETTING_KEYS = ['ACQUIRE_SKILL_THRESHOLD'] as const;
export type BiblioSettingKey = (typeof BIBLIO_SETTING_KEYS)[number];

/**
 * 蔵書一覧 (catalog) の型。
 *
 * `@bot 蔵書` で棚 (HajimariInc/biblio-shelf) の `marketplace.json` から取得した
 * plugins[] を最小投影した形。host 側 `list-biblio.ts` が `source` フィールド
 * (`./<category>/<name>` 形式、`shelve.ts:293` 契約) を split して category を抽出する。
 */

/** 蔵書一覧の 1 件 (= marketplace.json plugins[] の最小投影)。 */
export interface ListBiblioItem {
  /** `<owner>--<repo>` 形式の biblio 名。 */
  name: string;
  /** `biblio-dev|art|bf|ai` のいずれか。source 解析失敗時は 'unknown'。 */
  category: BiblioCategory | 'unknown';
  /** plugin.json 由来の description (空文字許容)。 */
  description: string;
  /** plugin.json 由来の version (空文字許容)。 */
  version: string;
}

/** `listBiblio()` の入力。 */
export interface ListBiblioParams {
  /** カテゴリ絞り込み (未指定 = 全件)。 */
  category?: BiblioCategory;
}

/** `listBiblio()` の戻り値。 */
export interface ListBiblioResult {
  ok: true;
  /** フィルタ適用後の biblio 一覧 (`category` で絞り込み済)。 */
  items: ListBiblioItem[];
  /** 全件 (= フィルタ前) のカテゴリ別件数。`unknown` も含む。 */
  counts: Record<BiblioCategory | 'unknown', number>;
  /** 全件 (= フィルタ前) の総数。 */
  total: number;
  /** 適用された category filter (= 入力をそのまま返す、agent 表示用)。 */
  appliedFilter: BiblioCategory | null;
}

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

/**
 * 複数 (biblioName, category) を 1 PR にまとめる陳列リクエストの 1 件 (Phase 4 multi-category-shelve)。
 *
 * 1 仕入れリクエストで複数 skill が異なる category に分かれるケース (= PRD シナリオ A
 * 「同一 repo 内で複数 category へ分散」) を表現する。`reason` は per-item の categorize 判定
 * 理由 (= shelveMulti が commit message / PR body に category 別 section で展開する)。
 */
export interface MultiShelveItem {
  biblioName: string;
  category: BiblioCategory;
  reason: string;
}

/**
 * `shelveMulti()` 固有の失敗理由 + 既存 `ShelveFailureReason` の継承。
 *
 * - `empty_items`: 入力配列が空 (= 上位の orchestration 不具合、agent が空配列を送ったケース)
 * - `duplicate_biblio_name`: 同一 biblioName が複数 item に含まれる (= per-req 物理移動が衝突するため pre-flight で fail)
 * - それ以外は単一 `shelve()` と同じ分類 (= 1 PR 単位で原子的に成功/失敗、部分成功なし)
 */
export type MultiShelveFailureReason = ShelveFailureReason | 'empty_items' | 'duplicate_biblio_name';

/**
 * `shelveMulti()` の結果。discriminated union — `ok` で分岐する。
 *
 * 部分成功なし (= N 件すべて陳列 or 0 件陳列の二択) で原子性を確保する。
 * 成功時は 1 PR URL + branch + 陳列された items 一覧、失敗時は reason + detail +
 * 試行された items 一覧を返す (= empty_items の空配列入力でも `items: []` で固定。
 * `failMulti` ヘルパが常に全件詰めるため、caller は ok=false 時も items に必ずアクセスできる)。
 */
export type MultiShelveResult =
  | {
      ok: true;
      prUrl: string;
      prNumber: number;
      branchName: string;
      items: Array<{ biblioName: string; category: BiblioCategory }>;
    }
  | {
      ok: false;
      reason: MultiShelveFailureReason;
      detail: string;
      items: Array<{ biblioName: string; category: BiblioCategory }>;
    };

/**
 * 解除 (kaijo / unshelve) の型 (M3 Phase 3)。
 *
 * 棚 (shelf) から biblio を除去する draft PR を作る `unshelve()` の入出力。
 * 禁書 (`enkin`) / 焼却 (`shokyaku`) はこの薄ラッパで、本ファイル末尾に
 * `EnkinResult` / `ShokyakuResult` を type alias として並べる。
 */

/** 解除 (unshelve) 失敗の分類。 */
export type UnshelveFailureReason =
  /** marketplace.json 404 or `plugins[]` に entry がない (= 既に解除済 / 元から不在)。 */
  | 'not_shelved'
  /** Git Data API / Pulls API の non-2xx response (step + status + body を detail に含む)。 */
  | 'github_api_error'
  /** `category` パラメータが `BiblioCategory` の 4 値に含まれない (= action handler 入口防御線)。 */
  | 'invalid_category';

/**
 * 解除結果。discriminated union — `ok` で分岐する。
 * 成功時は PR URL + branch、失敗時は理由 + 詳細を持つ (silent failure 防止)。
 */
export type UnshelveResult =
  | { ok: true; biblioName: string; category: BiblioCategory; prUrl: string; prNumber: number; branchName: string }
  | { ok: false; biblioName: string; reason: UnshelveFailureReason; detail: string };

/** 禁書 = `unshelve()` 薄ラッパ。挙動は完全に同じ shape。 */
export type EnkinResult = UnshelveResult;

/**
 * 焼却 = `unshelve()` + `fs.rmSync` + `deleteEquippedBiblioByName`。
 *
 * `UnshelveResult` の ok=true に **`cleanupWarning?: string` を追加** した独立 type。
 * 焼却特有の host 側 cleanup (= 装備源 dir 削除 + 全 session DB 個別削除) は shelf PR
 * 作成が成功した後の付随処理で、失敗しても `ok=true` を維持する設計だが、patron に
 * 「物理削除しました」と無条件通知すると焼却の意味 (= 再装備不可) を誤認させるため、
 * 失敗内容を `cleanupWarning` で持ち上げて action handler 側で通知文言を切替える
 * (= silent failure 防止、PR #15 silent-failure-hunter HIGH 2 対応)。
 */
export type ShokyakuResult =
  | {
      ok: true;
      biblioName: string;
      category: BiblioCategory;
      prUrl: string;
      prNumber: number;
      branchName: string;
      /** host 側 cleanup (rmSync / DB delete) が失敗した場合の警告文。成功時は undefined。 */
      cleanupWarning?: string;
    }
  | { ok: false; biblioName: string; reason: UnshelveFailureReason; detail: string };

/**
 * 装備機構 (souwa / equip) の型 (M3 Phase 1)。
 *
 * 司書が shelf clone を agent-container に取り込み実行する「装備」の
 * 物理配置 1 件を表す。install / cleanup ライフサイクルは Phase 2 以降。
 * Phase 1 は env-driven な mount 配線のみ (= `equip.ts` の stub)。
 */

/**
 * 装備済み biblio 1 件の物理配置情報。
 *
 * `readonly` で構築後の mutation を禁止 (= 不変 value object、`equip.ts` の `resolveEquippedBiblios`
 * 内で 1 度作って以降は変更されない設計を型で表現)。`sourcePath` は絶対パス保証
 * (= `equip.ts:78` の `path.resolve(root, name)` で生成、Docker run -v が相対パスを local
 * volume 名と解釈する罠を回避)。
 */
export interface EquippedBiblio {
  /** biblio 名 (= `owner--name` 形式、`BIBLIO_NAME_RE` 通過済)。 */
  readonly name: string;
  /** host 側 source path (`<DATA_DIR>/biblio-equipped/<name>/`、絶対パス)。 */
  readonly sourcePath: string;
  /** agent コンテナ内 mount path (`/workspace/biblios/<name>/`)。 */
  readonly mountPath: string;
}
