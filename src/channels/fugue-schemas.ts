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
