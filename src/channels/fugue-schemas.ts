/**
 * Fugue channel adapter (M4-E) の Zod schemas + response 型定義。
 *
 * Phase 1 は最小 skeleton (schema_version + request_id の 2 field のみ)。
 * Phase 2/3 で consult / equip endpoint の中身が入るタイミングで field を追加する
 * (query / mode / context_hint / skill_ref 等)。`.strict()` は使わない (codebase 慣習、
 * schema 進化に対して unknown field を許容する保守的な姿勢のほうが Fugue 側 schema
 * の進化に耐える)。
 */
import { z } from 'zod';

export const FugueConsultRequestSkeleton = z.object({
  schema_version: z.literal('1').describe('Schema version. Phase 1 accepts "1" only.'),
  request_id: z.string().min(1).max(64).describe('Client-provided idempotency key (max 64 chars).'),
});

export const FugueEquipRequestSkeleton = z.object({
  schema_version: z.literal('1').describe('Schema version. Phase 1 accepts "1" only.'),
  request_id: z.string().min(1).max(64).describe('Client-provided idempotency key (max 64 chars).'),
});

export type FugueConsultRequestSkeletonT = z.infer<typeof FugueConsultRequestSkeleton>;
export type FugueEquipRequestSkeletonT = z.infer<typeof FugueEquipRequestSkeleton>;

export interface FugueSkeletonResponse {
  schema_version: '1';
  request_id: string;
  operation: 'consult' | 'equip';
  status: 'ok';
  stub: true;
}

/**
 * Fugue エラー応答 body の型付き契約。writeError() 経由で 401/404/400/413/500 の
 * すべての error response を型付けする (S10 対応)。field 名 typo を compile-time で
 * 検知するために `error` は closed union、他 field は optional。
 *
 * Phase 2 で PRD 記載の `UNAUTHORIZED` / `INVALID_INPUT` 定数化・code 体系化と併せて
 * 再設計する予定 (現状は Phase 1 skeleton で 5 種類の error 状況を扱う最小契約)。
 */
export interface FugueErrorResponse {
  error: 'unauthorized' | 'not_found' | 'invalid_input' | 'invalid_url' | 'payload_too_large' | 'internal';
  detail?: string;
  path?: string;
  issues?: unknown[];
}
