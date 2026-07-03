/**
 * `buildRunner` smoke test — adk-js@1.3.0 実装契約 (InMemoryRunner が自動生成する
 * sessionService が InMemorySessionService) を runtime で検証する。
 *
 * 意図的に `@google/adk` を **mock せず実 import** する (= mock すると assertion の
 * 意味が消える)。adk-js bump で契約が壊れた場合、本 test が fail して runner.ts の
 * assertion 発火より前に検知できる。
 */
import { describe, it, expect } from 'vitest';
import { InMemorySessionService, LlmAgent } from '@google/adk';
import { buildRunner, BIBLIO_M4B_APP_NAME } from './runner.js';

describe('buildRunner — adk-js 実装契約', () => {
  it('InMemoryRunner が自動生成する sessionService は InMemorySessionService instance', () => {
    // 最小限の agent (実 LLM 呼出は行わない = model 指定のみ、tools 空)
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'claude-sonnet-4-6',
    });
    const { runner, sessionService } = buildRunner(agent);

    expect(sessionService).toBeInstanceOf(InMemorySessionService);
    expect(runner).toBeDefined();
  });

  it('BIBLIO_M4B_APP_NAME は Runner に伝搬される (session key 構成要素)', () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'claude-sonnet-4-6',
    });
    const { runner } = buildRunner(agent);
    // Runner の appName field は public readonly (runner.js 参照)
    expect((runner as unknown as { appName: string }).appName).toBe(BIBLIO_M4B_APP_NAME);
  });
});
