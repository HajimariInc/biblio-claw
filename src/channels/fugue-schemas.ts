/**
 * Fugue channel adapter (M4-E) の Zod schemas + response 型定義。
 *
 * Phase 2 で consult endpoint を full spec 化 (query / mode / context_hint)。
 * Phase 3 で equip endpoint を full spec 化 (skill_id / channel) + `SkillRef.equipped` を
 * `false` literal → `boolean` に緩和 (`fugue_equipped_biblios` の channel-scoped store で
 * decidable 化)。`.strict()` は使わない (codebase 慣習、schema 進化に対して unknown field を
 * 許容する保守的な姿勢のほうが Fugue 側 schema の進化に耐える)。
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

/**
 * Fugue equip endpoint の Request full spec (Phase 3)。
 *
 * `skill_id` は棚 item の name (consult SkillRef.id と同一空間)。`BIBLIO_NAME_RE` guard は
 * handler 側で fail-closed に適用する (path traversal 防御、fugue-schemas.ts は zod-only に
 * 保つ設計方針で regex 依存を作らない)。`channel` は Fugue 契約 §5.3 の HITL 簡略化
 * discriminator (literal `'fugue'` で固定、他値は Zod で 400 reject)。
 */
export const FugueEquipRequest = z.object({
  schema_version: z.literal('1').describe('Schema version. Phase 3 accepts "1" only.'),
  request_id: z.string().min(1).max(64).describe('Client-provided idempotency key (max 64 chars).'),
  skill_id: z
    .string()
    .min(1)
    .max(200)
    .describe('Biblio name from consult SkillRef.id ("<owner>--<repo>" or "<owner>--<repo>--<skill>" form).'),
  channel: z
    .literal('fugue')
    .describe('HITL simplification discriminator (Fugue contract §5.3). Only "fugue" is accepted here.'),
});
export type FugueEquipRequestT = z.infer<typeof FugueEquipRequest>;

/**
 * Fugue ask endpoint (M4-H) の intent literal union。Phase 1 では受理のみ (Zod validation
 * pass 後は log field に emit するだけ、skeleton response には反映しない)。
 *
 * TODO(M4-H Phase 2): gate 4 層と `INTENT_GATE_MISMATCH` 検出に再利用する。定数化しておく
 * ことで Phase 2 で inline enum を export し直す手戻りを防ぐ。
 */
export const FUGUE_ASK_INTENTS = ['search-web', 'drive-lookup', 'general'] as const;
export type FugueAskIntent = (typeof FUGUE_ASK_INTENTS)[number];

// M4-H Phase 2: ask endpoint 向け warnings 定数 (Contract §5.5 準拠、named export で test 済みの厳格な文字列契約)。
// consult/equip の inline literal (`'input rejected by input gate'`) との書き味の混在は許容 (Fugue 側実装が塊で疎通
// 取れた時点で fix 方針、DEN さん判断 2026-07-06)。
export const AD_ASK_DENIED_BY_GATE = 'AD_ASK_DENIED_BY_GATE' as const;
export const INTENT_GATE_MISMATCH = 'INTENT_GATE_MISMATCH' as const;

/**
 * Fugue ask endpoint (M4-H) の Request full spec (Phase 1 skeleton)。
 *
 * consult より広い `query` 上限 (2000 char) は PRD §5.5 に準拠 (Fugue Director が Web
 * 検索・Drive lookup を要求する自然文は長くなりうる)。`intent` は将来 gate 4 層で
 * `INTENT_GATE_MISMATCH` 検出に使う (Phase 2 以降)、Phase 1 では受理のみで応答には反映しない。
 * `context_hint` は consult 側と同一 shape (`.optional().nullable()` 順を統一)。
 */
export const FugueAskRequest = z.object({
  schema_version: z.literal('1').describe('Schema version. Phase 1 accepts "1" only.'),
  request_id: z.string().min(1).max(64).describe('Client-provided idempotency key (max 64 chars).'),
  query: z
    .string()
    .min(1)
    .max(2000)
    .describe('Free-text ask query from Fugue Director (max 2000 chars, wider than consult).'),
  intent: z
    .enum(FUGUE_ASK_INTENTS)
    .optional()
    .nullable()
    .describe('Optional intent hint (search-web/drive-lookup/general). Phase 1 receives but does not act on it.'),
  context_hint: z
    .record(z.string(), z.unknown())
    .optional()
    .nullable()
    .describe('Optional context (screen_summary etc). Phase 1 receives but does not use.'),
});
export type FugueAskRequestT = z.infer<typeof FugueAskRequest>;

/**
 * ask endpoint の source item (Phase 3 で外部 backend の実結果を格納)。
 *
 * Phase 1 skeleton では `sources: []` (backend 未接続)。`metadata` は上限を持たない自由な
 * dict (backend-specific な補助情報を透過的に運ぶ)。
 */
export const Source = z.object({
  id: z.string().min(1).max(64).describe('Unique source id within a single ask response.'),
  kind: z.enum(['web', 'drive']).describe('Source backend kind (Phase 3 で `web` = Tavily, `drive` = Google Drive).'),
  title: z.string().min(1).max(400).describe('Source title (Web page title / Drive file name).'),
  url: z.string().min(1).max(1000).describe('Source URL (Web link / Drive file URL).'),
  snippet: z.string().min(1).max(1100).describe('Short excerpt or summary from the source.'),
  metadata: z.record(z.string(), z.unknown()).default({}).describe('Optional backend-specific metadata.'),
});
export type SourceT = z.infer<typeof Source>;

/**
 * ask endpoint の finding item (Phase 3 で外部 backend の抽出結果を格納)。
 *
 * Phase 1 skeleton では `findings: []` (backend 未接続)。`source_ids` は上限 5 で
 * findings 側から `sources` の item を後方参照する形。
 *
 * GOTCHA (Zod v4): `source_ids` は `.max(5).default([])` の順で書く必要がある。逆順
 * (`.default([]).max(5)`) にすると `TS2339: Property 'max' does not exist on type
 * 'ZodDefault<...>'` の compile error になる (v4 で `.default()` は output 型扱いに変更、
 * v3 記法と非互換)。
 */
export const Finding = z.object({
  text: z.string().min(1).max(600).describe('Extracted finding text (max 600 chars).'),
  source_ids: z
    .array(z.string())
    .max(5)
    .default([])
    .describe('Source ids from `sources[]` supporting this finding (max 5).'),
});
export type FindingT = z.infer<typeof Finding>;

/**
 * Fugue ask endpoint の Reply body (Phase 1 skeleton)。
 *
 * status の意味 (Contract §5.5):
 *
 * - `ok` — 正常応答 (summary / findings / sources のいずれかが埋まる、Phase 3 完了時点で発火)
 * - `denied` — gate `in-secure` 判定 (Phase 2 で扱う)
 * - `not_available` — バックエンド未接続 (backend が Phase 3 で結線されるまで発火)。**Phase 1
 *   skeleton の意味と一致** — agent-container backend を呼ばない = Contract 上「未接続状態」の
 *   semantics。Fugue 側 AD は `not_available` を「AD ラウンド省略」の signal として静かに fallback する。
 * - `error` — timeout / 部分失敗
 *
 * Phase 1 skeleton は必ず `status: 'not_available'` + `warnings: ['skeleton_response']` を返す。
 * TODO(M4-H Phase 3): backend 結線完了時に (a) `status` を `'ok'` に切替、(b) `warnings` から
 * `'skeleton_response'` を除去、(c) `summary` / `findings` / `sources` の 3 並列 payload を実データで埋める。
 *
 * **discriminated union 設計 (A3-1)**: Phase 3 で status ごとの分岐が実装される時点で `FugueEquipReply`
 * (PR #117) と同型の discriminated union 化を予告している。Phase 1 skeleton では常に `status:'not_available'`
 * だが、Contract §5.5 の 4 status を型で明示することで、Phase 2/3 実装時に status × payload 相関の
 * silent 不整合を compile-time で検知する。
 */
export const FugueAskReply = z.discriminatedUnion('status', [
  // 'ok': backend 結線後の正常応答 (Phase 3)
  z.object({
    schema_version: z.literal('1'),
    request_id: z.string(),
    operation: z.literal('ask'),
    status: z.literal('ok'),
    summary: z.string().min(1).max(600),
    findings: z.array(Finding).max(10).default([]),
    sources: z.array(Source).max(20).default([]),
    raw: z.record(z.string(), z.unknown()).default({}),
    processing_time_ms: z.number().int().nonnegative(),
    warnings: z.array(z.string()).default([]),
  }),
  // 'denied': gate in-secure 判定 (Phase 2)
  z.object({
    schema_version: z.literal('1'),
    request_id: z.string(),
    operation: z.literal('ask'),
    status: z.literal('denied'),
    summary: z.string().min(1).max(600),
    findings: z.array(Finding).max(10).default([]),
    sources: z.array(Source).max(20).default([]),
    raw: z.record(z.string(), z.unknown()).default({}),
    processing_time_ms: z.number().int().nonnegative(),
    warnings: z.array(z.string()).default([]),
  }),
  // 'not_available': backend 未接続 (Phase 1 skeleton の default)
  z.object({
    schema_version: z.literal('1'),
    request_id: z.string(),
    operation: z.literal('ask'),
    status: z.literal('not_available'),
    summary: z.string().min(1).max(600),
    findings: z.array(Finding).max(10).default([]),
    sources: z.array(Source).max(20).default([]),
    raw: z.record(z.string(), z.unknown()).default({}),
    processing_time_ms: z.number().int().nonnegative(),
    warnings: z.array(z.string()).default([]),
  }),
  // 'error': timeout / 部分失敗
  z.object({
    schema_version: z.literal('1'),
    request_id: z.string(),
    operation: z.literal('ask'),
    status: z.literal('error'),
    summary: z.string().min(1).max(600),
    findings: z.array(Finding).max(10).default([]),
    sources: z.array(Source).max(20).default([]),
    raw: z.record(z.string(), z.unknown()).default({}),
    processing_time_ms: z.number().int().nonnegative(),
    warnings: z.array(z.string()).default([]),
  }),
]);
export type FugueAskReplyT = z.infer<typeof FugueAskReply>;

/**
 * biblio-shelf の 1 skill を Fugue Director に返すときの参照型 (Phase 3 で decidable 化)。
 *
 * biblio-claw 側で組み立てて返すのみで、Fugue 側から受け取ることはない → interface で
 * 型担保のみ、Zod schema にしない。`equipped` は Phase 3 で `fugue_equipped_biblios`
 * (channel-scoped store) の membership に基づき決まる (session 概念とは独立、Fugue Director
 * 1 人前提の channel-scoped 装備セット)。
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
 * status の意味:
 *
 * - `ok` = 検索ヒットあり (skills_found >= 1)
 * - `not_found` = biblio-claw は生きているが検索 0 件 (200 応答、Fugue 側で「該当なし」と扱う)
 * - `error` = 蔵書検索が部分失敗 (GitHub API 一時障害 / marketplace.json 破損 / env 未設定
 *   等) だが biblio-claw 自体は応答可能な状態。200 + `warnings` に理由を載せることで
 *   Fugue 側の AD ラウンド継続判断を許容する (5xx を出さない設計、PRD「AD の本義」節)。
 *
 * 4xx/5xx (401 / 413 / 500) は認可 / 上限超過 / biblio-claw 自体の応答不能に限定。
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

/**
 * Fugue equip endpoint の Reply body (Phase 3)。
 *
 * status の意味:
 *
 * - `equipped` = 新規装備成功 (`fugue_equipped_biblios` に新規 INSERT、`skill` に対象を返す)
 * - `already_equipped` = 既に装備中 (`INSERT OR IGNORE` で changes=0、200 でエラーではない。
 *   `skill.equipped: true` + summary で「既に装備済み」を返す = 冪等性の担保)
 * - `not_found` = `skill_id` が棚に存在しない (200、Fugue 側は「棚に無い」と扱う。
 *   consult の可視範囲 (= `category !== 'unknown'`) と整合。`skill: null`)
 * - `error` = 部分失敗 (listBiblio 障害 / DB write 失敗、`warnings` に理由 + `skill: null`)。
 *   consult と同様の PRD「AD の本義」節に従い 5xx を出さない
 *
 * 5xx (401 / 413 / 500) は認可 / 上限超過 / biblio-claw 自体の応答不能 (uncaught exception) に限定。
 *
 * **型設計 (PR #117 review、type-design-analyzer)**: `status` × `skill` の相関 (equipped/
 * already_equipped は skill 非 null、not_found/error は skill: null) を discriminated union で
 * 型レベル強制する。5 か所の object literal (fugue-http.ts の handleEquip 内) は既に正しく
 * ペア化されているため object literal 自体は無変更で narrowing が成立する。将来 status/skill
 * の不整合 (例: `status:'not_found'` で skill を書く / `status:'equipped'` で skill:null にする)
 * は compile error として検知される。
 */
export type FugueEquipReply =
  | {
      schema_version: '1';
      request_id: string;
      operation: 'equip';
      status: 'equipped' | 'already_equipped';
      summary: string;
      skill: SkillRef;
      processing_time_ms: number;
      warnings: string[];
    }
  | {
      schema_version: '1';
      request_id: string;
      operation: 'equip';
      status: 'not_found' | 'error';
      summary: string;
      skill: null;
      processing_time_ms: number;
      warnings: string[];
    };

/**
 * biblio-claw 内部の分類 code — 蔵書検索の失敗を Fugue 側に伝えるために使う。
 *
 * consult 経路では:
 *
 * - 部分失敗時 (200 + `status:'error'`): `warnings` に `consult failed: ${reason}` として emit
 * - biblio-claw 自体の応答不能時 (`error:'unavailable'`): `FugueErrorResponse.reason` に emit
 *   (現状 `writeError()` の 5xx path は 500 `error:'internal'` のみ発火、`unavailable` variant
 *   は未実装の予備 = discriminated union で reason を持てる契約だけ用意している)
 *
 * 5 分類 (M4-F Phase 2 で `in_secure` を追加):
 *
 * - `env_missing`: 棚 owner/repo の env 未設定 = biblio-claw 設定不備 (Phase 5 の Prod
 *   deploy で解消予定、Phase 2 development 期は起こりうる)
 * - `github_http`: GitHub API が 5xx / rate limit / auth failure を返した (transient)
 * - `marketplace_parse`: `marketplace.json` が壊れている (shelve PR の途中状態等、transient
 *   になりうる)
 * - `in_secure`: **M4-F Phase 2 追加**。gate 4 層で prompt injection と判定された発話
 *   (`raw.reason: 'in_secure'` として consult reply に emit)。Fugue Director consumer は
 *   `warnings` の `'input rejected by input gate'` と併せて「入力が拒否された」を認識する。
 * - `other`: 未分類の Error / 非 Error 値
 */
export type FugueUnavailableReason = 'env_missing' | 'github_http' | 'marketplace_parse' | 'in_secure' | 'other';

/**
 * Fugue エラー応答 body の型付き契約 (writeError() 経由で 401 / 404 / 400 / 413 / 500
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
