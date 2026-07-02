/**
 * `InMemoryRunner` factory — Phase 1/2/3 共通 + Phase 4 で sessionService を expose (M4-B Phase 4)。
 *
 * `InMemoryRunner` は in-process な `SessionService` / `ArtifactService` / `MemoryService` を
 * 自動セットアップする (= 外部依存ゼロ)。Phase 4 で HITL 承認機構を統合するために、内部の
 * `InMemorySessionService` を dispatcher / approval-dispatcher から touch できる必要があり、
 * `buildRunner` の戻り値を `SharedRunnerContext = { runner, sessionService }` に拡張した。
 *
 * # 経緯: なぜ sessionService を expose する必要があるか
 *
 * Phase 3 までは `InMemoryRunner.runEphemeral()` を使い、都度 ephemeral session を作って
 * 都度捨てる pattern だった (multi-turn 不要 / session 保持不要)。しかし Phase 4 の HITL
 * 承認機構 (enkin/shokyaku) では:
 *
 *   1. LLM が `enkin_biblio` tool を呼ぶ → `tool_context.requestConfirmation()` → runner pause
 *   2. Slack DM で admin が Approve / Reject 押下 (~秒〜分)
 *   3. `resolveAdkApproval` が **同 sessionId で runner.runAsync を再度呼び** functionResponse を送り込む
 *
 * この 3 で「pause した session を保持して resume」が必要になり、`runEphemeral` (= finally で
 * 自動 deleteSession) は不適合。dispatcher で `sessionService.createSession → runner.runAsync → 保持`
 * の明示管理に切り替え、pending 中は deleteSession をスキップし、resume 完了後に cleanup する
 * 経路が Phase 4 core design (plan Pattern 3)。
 *
 * # `InMemoryRunner` の sessionService 取得経路
 *
 * `InMemoryRunner` の constructor は `sessionService` option を受けない (adk-js@1.3.0 の
 * `in_memory_runner.d.ts:37-41` 参照) が、`Runner` の親クラス public readonly field
 * (`runner.sessionService: BaseSessionService`) で外部アクセス可能。`InMemoryRunner` は内部で必ず
 * `InMemorySessionService` を自動生成するため、`as InMemorySessionService` の cast は安全
 * (= adk-js@1.3.0 実装契約に依存、major version bump 時は検証必須)。
 *
 * **GOTCHA (plan Task 10)**:
 *   - `appName` は `(appName, userId, sessionId)` triple の session key 構成要素。Phase 1-4 では
 *     1 Runner のみのため `'biblio_m4b'` 固定で OK。複数 Runner 同居時はユニークにする
 *   - `Runner.runAsync` の `finally` で全 `BaseToolset.close()` が呼ばれる (= adk-js
 *     `runner.js:244-248`)。`FunctionTool` は `BaseTool` (= toolset ではない) なので Phase 4 で
 *     配線する 9 tool は close 影響なし
 */
import { InMemoryRunner, InMemorySessionService } from '@google/adk';
import type { BaseAgent } from '@google/adk';

/** Phase 1-4 共通の app name (= session key の一部、複数 Runner 同居時はユニーク化する)。 */
export const BIBLIO_M4B_APP_NAME = 'biblio_m4b';

/**
 * `buildRunner` の戻り値 (Phase 4 で追加)。dispatcher / approval-dispatcher が sessionService
 * を経由して明示的に session の create / delete を行うために expose する。
 */
export interface SharedRunnerContext {
  runner: InMemoryRunner;
  sessionService: InMemorySessionService;
}

/**
 * `InMemoryRunner` factory + `InMemorySessionService` expose。`buildRootAgent()` の戻り値を渡して使う。
 *
 * 戻り値の `sessionService` は `InMemoryRunner` 内部で自動生成された `InMemorySessionService` の
 * **参照** (= 新たな instance ではない、runner と共有)。この参照経由で作った session は
 * `runner.runAsync({sessionId, ...})` から見える。
 */
export function buildRunner(agent: BaseAgent): SharedRunnerContext {
  const runner = new InMemoryRunner({
    agent,
    appName: BIBLIO_M4B_APP_NAME,
  });
  // InMemoryRunner は必ず InMemorySessionService を内部生成する (adk-js@1.3.0 実装契約)。
  // Runner 親クラスの readonly public field 経由で取得。契約の runtime 検証で cast の
  // 安全性を機械的に保証 (本ファイル冒頭ドキュメント参照、silent failure 撲滅)。
  const sessionService = runner.sessionService;
  if (!(sessionService instanceof InMemorySessionService)) {
    throw new Error(
      `InMemoryRunner.sessionService is not an InMemorySessionService instance ` +
        `(got: ${sessionService.constructor.name}). adk-js のバージョンを確認してください。`,
    );
  }
  return { runner, sessionService };
}
