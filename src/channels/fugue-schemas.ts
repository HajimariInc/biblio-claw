/**
 * Fugue channel adapter (M4-E) の Zod schemas + response 型定義。
 *
 * Phase 2 で consult endpoint を full spec 化 (query / mode / context_hint)。
 * equip 側 (`FugueEquipRequestSkeleton` + `FugueSkeletonResponse` の equip 分岐) は
 * Phase 3 で置換する予定のため一旦温存する。`.strict()` は使わない (codebase 慣習、
 * schema 進化に対して unknown field を許容する保守的な姿勢のほうが Fugue 側 schema
 * の進化に耐える)。
 */
import { z } from 'zod';

/**
 * Fugue Director round mode の literal union。Phase 2 では受理のみで検索ロジックには
 * 反映しない (log field + `raw.mode` に emit のみ)。将来 Fugue Stage 5+ で mode 別
 * 分岐を追加する予定 (Solution Approach 判断 F)。
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
 * 型担保のみ、Zod schema にしない。`equipped` は Phase 2 では常に `false` (Fugue は
 * `supportsThreads: false` = session 概念なしのため装備状態が decidable でない、
 * 判断 B)。将来 Fugue Stage 5+ で session 概念導入時に切替。
 */
export interface SkillRef {
  id: string;
  name: string;
  description: string;
  manifest_url: string;
  equipped: boolean;
}

/**
 * Fugue consult endpoint の Reply body (Phase 2)。
 *
 * `status: 'ok'` = 検索ヒットあり、`'not_found'` = 検索 0 件 (biblio-claw は生きて
 * いるが結果空、200 応答)、`'error'` は Phase 2 では返さない (エラー時は 503 で
 * `FugueErrorResponse` を返す、判断 D)。`raw` は Phase 2 では listBiblio 結果の
 * 一部 (total / counts / appliedFilter) + query + mode、将来 NanoClaw response に
 * 差し替え予定 (判断 G)。
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
 * Fugue エラー応答 body の型付き契約。writeError() 経由で 401/404/400/413/500/503 の
 * すべての error response を型付けする (S10)。field 名 typo を compile-time で
 * 検知するために `error` は closed union、他 field は optional。
 *
 * `unavailable` は Phase 2 追加 (判断 D、listBiblio throw = 503 OFFLINE)。
 * `reason` は 503 分岐の内部エラー分類を Fugue 側に伝える (`env_missing` /
 * `github_http` / `marketplace_parse` / `other`)。
 */
export interface FugueErrorResponse {
  error:
    'unauthorized' | 'not_found' | 'invalid_input' | 'invalid_url' | 'payload_too_large' | 'internal' | 'unavailable';
  detail?: string;
  path?: string;
  issues?: unknown[];
  reason?: string;
}
