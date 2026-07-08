/**
 * `progress.status.transition` event の共有 payload 定義 + emit helper。
 *
 * 5 発火点 (`updateTypingStatus` / `triggerTyping` / `emitPreSpawnStatus` /
 * `emitAdkToolStatus` / `chat-sdk-bridge.setTyping`) に info emit を追加した際、payload
 * の field 名 / union 値が inline object literal で分散コピーされ、typing/index.test.ts +
 * pre-spawn.test.ts + chat-sdk-bridge.test.ts + verify-m4-f.sh の 4 箇所に同じ field list
 * が独立管理される状態になる問題があった。本 helper でコンパイル時 union 検査 +
 * 必須 field 欠落検知を集中化する。
 *
 * `withBiblioActionSpan` の `BiblioActionName` 12 値 closed union (`action-helpers.ts`)
 * と同じ設計判断: 「typo は compile-time で block、意味の source of truth を 1 箇所に集約」。
 */
import { log } from '../../log.js';

export type ProgressStatusSource =
  'updateTypingStatus' | 'triggerTyping' | 'emitPreSpawnStatus' | 'emitAdkToolStatus' | 'chat-sdk-bridge.setTyping';

/**
 * status 遷移の結末を分類する closed union。
 *   - `transition`  — 状態変化を記録 (updateTypingStatus / emitAdkToolStatus の遷移 emit)
 *   - `triggered`   — vendor / adapter に status を「送信を試みた」事実 (成功パスの記録)
 *   - `failed`      — vendor / adapter が throw
 *   - `no_adapter`  — adapter 未登録 or setTyping 未実装 (CLI/Fugue で正常経路)
 */
export type ProgressStatusOutcome = 'transition' | 'triggered' | 'failed' | 'no_adapter';

export interface ProgressStatusTransitionFields {
  source: ProgressStatusSource;
  session_id: string | null;
  agent_group_id: string | null;
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
  status: string | null;
  previous_status?: string | null;
  tool_name?: string;
  vendor_thread_id?: string;
  adapter_supports_typing: boolean;
  outcome: ProgressStatusOutcome;
}

/**
 * `progress.status.transition` info を emit する共通 helper。5 発火点は本 helper 経由で
 * emit することで、payload field 名の typo / union 値の drift を compile-time で検知する。
 *
 * `event` field は helper 内で `'progress.status.transition'` に固定 (呼出側では省略)。
 */
export function logProgressStatusTransition(fields: ProgressStatusTransitionFields): void {
  log.info('progress.status.transition', {
    event: 'progress.status.transition',
    ...fields,
  });
}
