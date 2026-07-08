/**
 * ADK tool テスト共通ヘルパ。
 *
 * `mockToolContext` は acquire / inspect / shelve の 3 tool test に各 8 行で複製されていたのを
 * 抽出。`resetLogMocks` も 4 行 × 3 ファイルで同じ pattern が現れていた。
 *
 * **抽出理由**:
 *   - ADK の `Context` 型 shape が変わったとき、3 箇所を同期する必要がある (= `as unknown as
 *     Context` キャストの単一更新点化)
 *   - tool が増えた際に更に複製が生まれる前提が高い
 *   - vitest の `vi.mocked(log.X).mockReset()` パターンは ADK tool 内で log mock を使う限り
 *     繰り返し発生する
 *
 * **scope**: ADK tool の unit test 専用。root-agent.test.ts (integration test) は SDK mock も
 * 別途行うため独自セットアップを保つ。
 */
import type { Context } from '@google/adk';
import { vi } from 'vitest';

/**
 * Context の最小 structural mock。`invocationId` / `sessionId` のみ持つ (= `ReadonlyContext`
 * getter 経由で `resolveToolCtx` がアクセスする field と整合)。
 *
 * `invocationContext.invocationId` / `invocationContext.session.id` の直アクセス経路も後方互換
 * のために残しているが、本 mock は getter 経由を主とする。
 */
export function mockToolContext(opts?: { invocationId?: string; sessionId?: string }): Context {
  const invocationId = opts?.invocationId ?? 'inv-test-1';
  const sessionId = opts?.sessionId ?? 'sess-test-1';
  return {
    invocationId,
    sessionId,
    // 直アクセス path も保つ (= ADK 内部経路 + 後方互換確認用)
    invocationContext: {
      invocationId,
      session: { id: sessionId },
    },
  } as unknown as Context;
}

/**
 * `vi.mock('../../log.js')` で差し替えた log の各 mock を beforeEach でリセットするヘルパ。
 * acquire / inspect / shelve / root-agent の 4 test 共通。
 */
export function resetLogMocks(log: { debug: unknown; info: unknown; warn: unknown; error: unknown }): void {
  vi.mocked(log.debug as ReturnType<typeof vi.fn>).mockReset();
  vi.mocked(log.info as ReturnType<typeof vi.fn>).mockReset();
  vi.mocked(log.warn as ReturnType<typeof vi.fn>).mockReset();
  vi.mocked(log.error as ReturnType<typeof vi.fn>).mockReset();
}
