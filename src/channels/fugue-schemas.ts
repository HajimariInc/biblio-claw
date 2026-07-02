/**
 * Fugue channel adapter (M4-E) の Zod schemas + response 型定義。
 *
 * Phase 2 で consult endpoint を full spec 化 (query / mode / context_hint)。
 * equip 側 (`FugueEquipRequestSkeleton` + `FugueSkeletonResponse` の equip 分岐) は
 * TODO(M4-E Phase 3): consult と同様に full spec 化する。`.strict()` は使わない
 * (codebase 慣習、schema 進化に対して unknown field を許容する保守的な姿勢のほうが
 * Fugue 側 schema の進化に耐える)。
 */
import { z } from 'zod';

/**
 * Fugue Director round mode の literal union。Phase 2 では受理のみで検索ロジックには
 * 反映しない (log field + `raw.mode` に emit のみ)。TODO(M4-E Phase 4+): mode 別に
 * 検索経路を分岐する (Fugue Stage 5+ の Director 挙動に合わせる)。
 */
export const FUGUE_CONSULT_MODES = ['brainstorm-with-ad', 'review-with-ad', 'ask-ad', 'coaching-with-ad'] as const;
export type FugueConsultMode = (typeof FUGUE_CONSULT_MODES)[number];

/**
 * Fugue consult endpoint の Request full spec (Phase 2)。
 *
 * `context_hint` は `.optional().nullable()` で受理、Phase 2 は検索ロジック非反映
 * (log の `context_hint_keys` のみ emit、dict の中身は PII 保護でログ非記録)。
 */
export const FugueConsultRequest = z.object({
  schema_version: z.literal('1').describe('Schema version. Phase 2 accepts "1" only.'),
  request_id: z.string().min(1).max(64).describe('Client-provided idempotency key (max 64 chars).'),
  query: z
    .string()
    .min(1)
    .max(500)
    .describe('Free-text query from Fugue Director (e.g. "Figma のレビューできる skill ある?").'),
  mode: z
    .enum(FUGUE_CONSULT_MODES)
    .describe('Fugue Director round mode. Phase 2 accepts the mode but does not branch search logic on it.'),
  context_hint: z
    .record(z.string(), z.unknown())
    .optional()
    .nullable()
    .describe('Optional context (screen_summary etc). Phase 2 receives but does not use.'),
});
export type FugueConsultRequestT = z.infer<typeof FugueConsultRequest>;

export const FugueEquipRequestSkeleton = z.object({
  schema_version: z.literal('1').describe('Schema version. Phase 1 accepts "1" only.'),
  request_id: z.string().min(1).max(64).describe('Client-provided idempotency key (max 64 chars).'),
});

export type FugueEquipRequestSkeletonT = z.infer<typeof FugueEquipRequestSkeleton>;

/**
 * biblio-shelf の 1 skill を Fugue Director に返すときの参照型 (Phase 2)。
 *
 * biblio-claw 側で組み立てて返すのみで、Fugue 側から受け取ることはない → interface で
 * 型担保のみ、Zod schema にしない。`equipped` は Phase 2 では常に `false` を literal 型で
 * 強制する (Fugue は `supportsThreads: false` = session 概念なしのため装備状態が
 * decidable でない)。TODO(M4-E Phase 4+): Fugue Stage 5+ で session 概念導入時に
 * `boolean` へ緩める。
 */
export interface SkillRef {
  id: string;
  name: string;
  description: string;
  manifest_url: string;
  equipped: false;
}

/**
 * Fugue consult endpoint の Reply body (Phase 2)。
 *
 * status の意味:
 *
 * - `ok` = 検索ヒットあり (skills_found >= 1)
 * - `not_found` = biblio-claw は生きているが検索 0 件 (200 応答、Fugue 側で「該当なし」と扱う)
 * - `error` = 蔵書検索が部分失敗 (GitHub API 一時障害 / marketplace.json 破損 / env 未設定
 *   等) だが biblio-claw 自体は応答可能な状態。200 + `warnings` に理由を載せることで
 *   Fugue 側の AD ラウンド継続判断を許容する (5xx を出さない設計、PRD「AD の本義」節)。
 *
 * 5xx (401 / 413 / 503) は認可 / 上限超過 / biblio-claw 自体の応答不能に限定。
 * `raw` は Phase 2 では listBiblio 結果の一部 (total / counts / appliedFilter) +
 * query + mode。TODO(M4-E Phase 5+): NanoClaw response を含める。
 */
export interface FugueConsultReply {
  schema_version: '1';
  request_id: string;
  operation: 'consult';
  status: 'ok' | 'not_found' | 'error';
  summary: string;
  skills_found: SkillRef[];
  raw: Record<string, unknown>;
  processing_time_ms: number;
  warnings: string[];
}

export interface FugueSkeletonResponse {
  schema_version: '1';
  request_id: string;
  operation: 'consult' | 'equip';
  status: 'ok';
  stub: true;
}

/**
 * biblio-claw 内部の分類 code — 蔵書検索の失敗を Fugue 側に伝えるために使う。
 *
 * consult 経路では:
 *
 * - 部分失敗時 (200 + `status:'error'`): `warnings` に `consult failed: ${reason}` として emit
 * - biblio-claw 自体の応答不能時 (503 + `error:'unavailable'`): `FugueErrorResponse.reason` に emit
 *
 * 4 分類:
 *
 * - `env_missing`: 棚 owner/repo の env 未設定 = biblio-claw 設定不備 (Phase 5 の Prod
 *   deploy で解消予定、Phase 2 development 期は起こりうる)
 * - `github_http`: GitHub API が 5xx / rate limit / auth failure を返した (transient)
 * - `marketplace_parse`: `marketplace.json` が壊れている (shelve PR の途中状態等、transient
 *   になりうる)
 * - `other`: 未分類の Error / 非 Error 値
 */
export type FugueUnavailableReason = 'env_missing' | 'github_http' | 'marketplace_parse' | 'other';

/**
 * Fugue エラー応答 body の型付き契約 (writeError() 経由で 401 / 404 / 400 / 413 / 500 / 503
 * のすべての error response を型付け)。
 *
 * discriminated union で `error='unavailable'` の場合のみ `reason` を必須にし、他の
 * error では `reason` を持てないよう compile-time で禁止する
 * (例: `{error:'unauthorized', reason:'github_http'}` のような無意味な組み合わせを弾く)。
 * `error='unavailable'` を返すのは biblio-claw 自体の応答不能時に限定 (認可・上限超過・
 * 内部例外)。listBiblio() の部分失敗は 200 + `FugueConsultReply.status='error'` で運ぶため
 * `unavailable` variant は現状 uncaught exception 経路の予備 (現行 code path で明示発火なし)。
 */
export type FugueErrorResponse =
  | {
      error: 'unauthorized' | 'not_found' | 'invalid_input' | 'invalid_url' | 'payload_too_large' | 'internal';
      detail?: string;
      path?: string;
      issues?: unknown[];
    }
  | {
      error: 'unavailable';
      reason: FugueUnavailableReason;
      detail?: string;
      path?: string;
      issues?: unknown[];
    };
