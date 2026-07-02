/**
 * HITL 承認 tool の共有型定義 (M4-B Phase 4 review response、issue #108 対応)。
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
 * **設計判断 (Phase 4 review type-design-analyzer W3-3 / W3-4)**:
 *
 *   - PR #105 レビューで「3 箇所の重複定義」「`Record<string, unknown>` 経由の型情報損失」
 *     が指摘されたため named type に統一
 *   - 新 HITL tool 追加時は `HitlToolAction` に値を追加すると、型を経由する箇所 (adk-approvals /
 *     approval-dispatcher / tool 側 payload 構築) は自動的に型 error で検知される。
 *     dispatcher.ts の runtime 判定は `isHitlAction` type guard 経由で行うため `HITL_ACTIONS`
 *     配列に値追加が要る (忘れると unknown action として skip される silent 経路)。
 *     `adk-approvals.ts:120` の title 三項比較は exhaustiveness check 機構がないため型 error で
 *     検知されない (issue #108 scope 外、別 issue で対応検討)
 */
import type { BiblioCategory } from '../../biblio/types.js';

/**
 * HITL 承認 tool の action 名 closed union。
 *
 * 新 HITL tool 追加時は本 union に値を追加する:
 *   1. `HitlToolAction` に値追加
 *   2. `src/adk/tools/<新>-tool.ts` を Pattern 2 (enkin-tool.ts) 踏襲で作成
 *   3. `src/adk/root-agent.ts` の tools 配列に追加
 *   4. dispatcher の pending 判定 (`src/adk/dispatcher.ts`) は本型で narrow されるため
 *      自動的に型 error で検知される
 */
export type HitlToolAction = 'enkin' | 'shokyaku';

/**
 * `HitlToolAction` の union 値を列挙した readonly array。
 * `isHitlAction` type guard + 将来の exhaustiveness check に使用。
 * biblio-claw 標準の `BIBLIO_CATEGORIES` (types.ts:145-146) パターン踏襲。
 */
export const HITL_ACTIONS: readonly HitlToolAction[] = ['enkin', 'shokyaku'] as const;

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
