/**
 * M4-F Phase 4 progress-status module 公開 API。
 *
 * 内部モジュール構成:
 *   - `tool-status-map.ts` — tool 名 → 日本語文言 の pure mapper
 *   - `poller.ts` — 1s tick で container_state.current_tool → updateTypingStatus
 *   - `pre-spawn.ts` — session 未確定 / ADK 経路の一発 status 発射
 *
 * refresh loop 本体 (4s tick + heartbeat 判定) は既存 `src/modules/typing/index.ts` に温存。
 * 本 module は「refresh loop が forward する currentStatus を書き換える」責務のみを担う。
 */
export { refreshProgressStatus } from './poller.js';
export { toolNameToStatus, PIPELINE_STATUS } from './tool-status-map.js';
export { emitPreSpawnStatus, emitAdkToolStatus, clearAdkTargetStatus } from './pre-spawn.js';
export {
  logProgressStatusTransition,
  type ProgressStatusSource,
  type ProgressStatusOutcome,
  type ProgressStatusTransitionFields,
} from './transition-log.js';
