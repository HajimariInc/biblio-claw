/**
 * M4-F Phase 4: 秒オーダー ポーラー本体。
 *
 * `src/delivery.ts:pollActive()` の既存 1s tick loop から呼ばれ、outbound.db の
 * `container_state.current_tool` を read-only で叩き、`tool-status-map` で日本語文言に
 * 変換して `updateTypingStatus(session.id, status)` を呼ぶ。
 *
 * 契約 (PR #145 review I4 で契約と実装の乖離を修正):
 *   - **db open (`openOutboundDb`) の失敗のみ本関数内で catch**、warn / debug に振り分ける
 *   - **`getContainerState` / `updateTypingStatus` の予期しない throw は呼出元 (`pollActive`) の
 *     `.catch()` に委譲**する (稀ケース、`poller.test.ts` で defensive test 済)
 *   - db open ENOENT (or SQLITE_CANTOPEN、better-sqlite3 readonly open 特有) は初回 spawn 前 =
 *     正常経路として debug ログで silent 化 (frequent poll で noise になる)
 *   - db open EACCES 等の非 ENOENT / SQLITE_CANTOPEN は warn に倒す (I/O 障害を見える化)
 *   - `updateTypingStatus` は変化時のみ再送する契約 (typing/index.ts の rate limit ガード) =
 *     同じ tool 継続中に本 poller が 1s tick で呼び出されても追加 API 呼出しなし
 *   - agent group 不在 (削除済 session) は silent skip
 *   - outDb は必ず finally で close (fd リーク防止)
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerState } from '../../db/session-db.js';
import { log } from '../../log.js';
import { openOutboundDb } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { updateTypingStatus } from '../typing/index.js';

import { toolNameToStatus } from './tool-status-map.js';

/**
 * 単一 session の progress-status を 1 tick 分更新する。
 *
 * @param session getRunningSessions() が返した Session。id + agent_group_id 参照のみ。
 */
export async function refreshProgressStatus(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  let outDb;
  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ENOENT = fs level (write-mode open path で fs 経由の open が先に失敗)
    // SQLITE_CANTOPEN = better-sqlite3 readonly open 特有 (fs stat は通るが sqlite level
    // で file open が失敗する = PR #145 review C3 実測、readonly=true 経路で発生)
    // どちらも「初回 spawn 前」の正常経路として debug 抑制。
    if (code === 'ENOENT' || code === 'SQLITE_CANTOPEN') {
      log.debug('progress-status poll: outbound.db not found (pre-spawn)', {
        event: 'progress.status.pre_spawn',
        session_id: session.id,
        agent_group_id: agentGroup.id,
        err_code: code,
      });
    } else {
      // EACCES / EMFILE / EIO 等の I/O 障害は本番 LOG_LEVEL=info でも見える warn に倒す
      // (drainSession の pattern と対称)。
      log.warn('progress-status poll: outbound.db open failed', {
        event: 'progress.status.db_open_failed',
        session_id: session.id,
        agent_group_id: agentGroup.id,
        err_code: code,
        err,
      });
    }
    return;
  }

  try {
    const state = getContainerState(outDb);
    // state?.current_tool は snake_case (ContainerState interface に一致)。
    // null (= 現在 tool 未実行 = post-tool-use hook 後の idle) は null を渡し、
    // updateTypingStatus 側で「前値と同じなら no-op」の変化時再送に載る。
    // 非 null → null の遷移は「作業終了」を表す 1 回の再送で status バーが Slack default に戻る。
    const status = toolNameToStatus(state?.current_tool);
    updateTypingStatus(session.id, status);
  } finally {
    outDb.close();
  }
}
