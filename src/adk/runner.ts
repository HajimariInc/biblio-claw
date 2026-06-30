/**
 * `InMemoryRunner` factory — Phase 1/2/3 共通の Runner 起動 entry (M4-B Phase 1)。
 *
 * `InMemoryRunner` は in-process な `SessionService` / `ArtifactService` / `MemoryService` を
 * 自動セットアップする (= 外部依存ゼロ)。Phase 1 では local verify script でのみ使用、
 * Phase 2 で GKE 上の本番 main() bootstrap に組み込む際は本 factory を `Runner` (= 親クラス) +
 * 永続 `SessionService` に差し替える経路を残す (= 同 API を保つことで Phase 3 Slack inbound
 * 統合時にも factory 差し替えで対応可能)。
 *
 * **GOTCHA (plan Task 6)**:
 *   - `appName` は `(appName, userId, sessionId)` triple の session key 構成要素。Phase 1 では
 *     1 Runner のみのため `'biblio_m4b'` 固定で OK。複数 Runner 同居時はユニークにする
 *   - `Runner.runAsync` の `finally` で全 `BaseToolset.close()` が呼ばれる。`FunctionTool` は
 *     `BaseTool` (= toolset ではない) なので close 影響なし
 */
import { InMemoryRunner } from '@google/adk';
import type { BaseAgent } from '@google/adk';

/** Phase 1-3 共通の app name (= session key の一部、複数 Runner 同居時はユニーク化する)。 */
export const BIBLIO_M4B_APP_NAME = 'biblio_m4b';

/**
 * `InMemoryRunner` factory。`buildRootAgent()` の戻り値を渡して使う。
 */
export function buildRunner(agent: BaseAgent): InMemoryRunner {
  return new InMemoryRunner({
    agent,
    appName: BIBLIO_M4B_APP_NAME,
  });
}
