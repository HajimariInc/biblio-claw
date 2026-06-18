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
  /** repo が存在しない / 非公開 (gh api 404)。 */
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
