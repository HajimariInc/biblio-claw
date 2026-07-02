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
 *   - 新 HITL tool 追加時は `HitlToolAction` に値を追加するだけで、dispatcher / adk-approvals /
 *     approval-dispatcher の全経路が型 error で検知される (= 更新漏れが silent に fail-safe 経路
 *     に倒れる旧挙動を撲滅)
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
