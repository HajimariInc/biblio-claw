/**
 * HITL 承認 tool の共有型定義 (issue #108 対応)。
 *
 * `enkin_biblio` / `shokyaku_biblio` の破壊操作 tool は `tool_context.requestConfirmation()`
 * で pause し、admin 承認後に resume される。このとき tool → dispatcher → adk-approvals →
 * approval-dispatcher の 4 layer 間で以下 2 種の型を共有する:
 *
 *   1. `HitlToolAction` — tool 側 payload の `action` フィールド、adk-approvals の
 *      `RequestAdkApprovalOptions.action`、approval-dispatcher の
 *      `AdkApprovalPayload.innerAction`、dispatcher の pending 経路判定 で参照
 *   2. `HitlConfirmationPayload` — tool 側 `requestConfirmation({payload})` に渡す payload、
 *      dispatcher が `event.content.parts` から取り出して `requestAdkApproval` に渡す payload、
 *      adk-approvals が pending_approvals.payload に serialize する `toolPayload` の shape
 *
 * **設計判断**:
 *
 *   - 3 箇所の重複定義 + `Record<string, unknown>` 経由の型情報損失を避けるため named type に統一
 *   - `HITL_ACTIONS` 配列を single source of truth とし、`HitlToolAction` 型は
 *     `(typeof HITL_ACTIONS)[number]` で導出、`isHitlAction()` type guard も同配列を参照する
 *     (array-first パターン、`BIBLIO_CATEGORIES` / `BIBLIO_SETTING_KEYS` と同じ)。新 HITL tool
 *     追加時は 1 箇所 (`HITL_ACTIONS`) の更新で型 error と runtime 判定が同時に追従する
 *   - `adk-approvals.ts:120` の title 三項比較は exhaustiveness check 機構がないため
 *     `HitlToolAction` に値追加しても型 error で検知されない (issue #108 scope 外、
 *     別 issue で対応検討)
 */
import type { BiblioCategory } from '../../biblio/types.js';

/**
 * HITL 承認 tool の action 名 allowlist (single source of truth)。
 *
 * `HitlToolAction` 型は本配列から `(typeof HITL_ACTIONS)[number]` で導出、`isHitlAction`
 * type guard も本配列を参照する。biblio-claw 標準の `BIBLIO_CATEGORIES` (types.ts:145-146)
 * / `BIBLIO_SETTING_KEYS` (types.ts:169) と同じ array-first パターン。
 *
 * 新 HITL tool 追加時は本配列に値を追加するだけで:
 *   1. `HitlToolAction` union は自動追従 (型を経由する adk-approvals / approval-dispatcher /
 *      tool 側 payload 構築は自動的に型 error で検知される)
 *   2. `isHitlAction()` の runtime 判定も自動追従 (dispatcher.ts の pending 判定が新値を受理)
 * その後の作業:
 *   3. `src/adk/tools/<新>-tool.ts` を enkin-tool.ts 踏襲で作成
 *   4. `src/adk/root-agent.ts` の tools 配列に追加
 *   5. `adk-approvals.ts:120` の title 三項比較を更新 (exhaustiveness check 機構がないため
 *      型 error で検知されない = 手動 review 必須、issue #108 scope 外)
 */
export const HITL_ACTIONS = ['enkin', 'shokyaku'] as const;

/**
 * HITL 承認 tool の action 名 closed union。
 * `HITL_ACTIONS` から `(typeof)[number]` で導出することで手動同期を排除。
 */
export type HitlToolAction = (typeof HITL_ACTIONS)[number];

/**
 * `unknown` 由来の値が `HitlToolAction` かどうかの runtime 検証 type guard。
 *
 * dispatcher が adk-js event stream 経由で受け取る `toolConfirmation.payload.action`
 * は unsafe type assertion 経由の `HitlToolAction` narrow でしかないため、実運用上は
 * 予期外の string が来る可能性があり (ADK 実装契約変更 / payload 注入)、本 guard で
 * fail-closed 判定する。
 */
export function isHitlAction(v: unknown): v is HitlToolAction {
  return typeof v === 'string' && (HITL_ACTIONS as readonly string[]).includes(v);
}

/**
 * `tool_context.requestConfirmation({payload})` で渡す payload の共通 shape。
 *
 * dispatcher が `event.content.parts[].functionCall.args.toolConfirmation.payload` から
 * 取り出して `requestAdkApproval` に渡し、pending_approvals row の payload に serialize される。
 * admin 承認後は approval-dispatcher が payload を restore して tool.execute の再実行に使う。
 */
export interface HitlConfirmationPayload {
  biblioName: string;
  category: BiblioCategory;
  action: HitlToolAction;
}
