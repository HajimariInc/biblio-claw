// M4-H Phase 3.5 の目玉機能である `systemContext.customSystemPrompt` 分岐の regression 検知
// テスト (PR #195 review、pr-test-analyzer 評価 7 の重大な欠落への対応)。
//
// 対象: `container/agent-runner/src/providers/claude.ts:411-441` の `customPrompt ?? preset`
// 経路と `settingSources: customPrompt ? [] : ['project', 'user', 'local']` 分岐。
//
// 契約:
// - customSystemPrompt が string なら SDK に `systemPrompt: <string>` (custom variant) +
//   `settingSources: []` (CLAUDE.md / CLAUDE.local.md auto-load 遮断) を渡す
// - customSystemPrompt が undefined なら既存 preset 経路
//   (`{type:'preset',preset:'claude_code',append:instructions}` + `settingSources:['project','user','local']`)
//   を継続する = regression zero
// - customSystemPrompt が空文字 `''` の場合、`??` は string primitive を尊重するため preset に
//   fallback せず、user が明示的に空文字を渡した状態として尊重する (init 側で空文字化を避ける契約)
//
// GOTCHA: mock.module は module load 前に宣言する必要があるため、target import (`./claude.js`) は
// mock.module の後に静的 import する。sdk mock は async generator を 0 yield で即完了させ、
// `translateEvents` を 0 event で return させる = handler `for await` が即 exit する。

import { mock, describe, it, expect, beforeEach } from 'bun:test';

let lastSdkQueryOptions: Record<string, unknown> | null = null;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (arg: { prompt: unknown; options: Record<string, unknown> }) => {
    lastSdkQueryOptions = arg.options;
    return (async function* () {
      // 0 yield で完了 = translateEvents は 0 event で return
    })();
  },
}));

import { ClaudeProvider } from './claude.js';

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of events) {
    // no-op: consume events until generator completes
  }
}

beforeEach(() => {
  lastSdkQueryOptions = null;
});

describe('ClaudeProvider.query — systemContext.customSystemPrompt 分岐 (M4-H Phase 3.5)', () => {
  it('customSystemPrompt が string なら systemPrompt=string + settingSources=[]', async () => {
    const provider = new ClaudeProvider();
    const q = provider.query({
      prompt: 'hi',
      cwd: '/workspace/agent',
      systemContext: {
        instructions: 'ignored-when-custom',
        customSystemPrompt: 'FULL CUSTOM PROMPT',
      },
    });
    await drain(q.events);

    expect(lastSdkQueryOptions).not.toBeNull();
    expect(lastSdkQueryOptions?.systemPrompt).toBe('FULL CUSTOM PROMPT');
    expect(lastSdkQueryOptions?.settingSources).toEqual([]);
  });

  it('customSystemPrompt が未設定なら既存 preset 経路 (regression zero)', async () => {
    const provider = new ClaudeProvider();
    const q = provider.query({
      prompt: 'hi',
      cwd: '/workspace/agent',
      systemContext: {
        instructions: 'identity + destinations',
      },
    });
    await drain(q.events);

    expect(lastSdkQueryOptions).not.toBeNull();
    expect(lastSdkQueryOptions?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'identity + destinations',
    });
    expect(lastSdkQueryOptions?.settingSources).toEqual(['project', 'user', 'local']);
  });

  it('customSystemPrompt が空文字なら preset に fallback せず空文字を尊重する (?? 契約)', async () => {
    // 実装 (`??`) は string primitive を尊重するため empty string は preset に落ちない。
    // init 側で空文字化を避ける契約であり、意図的にこの挙動を固定化する (silent fallback を防ぐ)。
    const provider = new ClaudeProvider();
    const q = provider.query({
      prompt: 'hi',
      cwd: '/workspace/agent',
      systemContext: {
        instructions: 'ignored-when-custom-empty',
        customSystemPrompt: '',
      },
    });
    await drain(q.events);

    expect(lastSdkQueryOptions?.systemPrompt).toBe('');
    // settingSources は Boolean coerce (`customPrompt ? [] : [...]`) = 空文字は falsy →
    // preset 経路の settingSources を採用する = 契約の非対称性を明示的に固定化。
    // fugue-ask init 側で空文字を渡さない実装 contract の保護は init side の責務。
    expect(lastSdkQueryOptions?.settingSources).toEqual(['project', 'user', 'local']);
  });

  it('systemContext 自体が undefined なら preset without append + settingSources=preset', async () => {
    const provider = new ClaudeProvider();
    const q = provider.query({
      prompt: 'hi',
      cwd: '/workspace/agent',
    });
    await drain(q.events);

    // instructions が undefined なので preset 経路の inner ternary で undefined 側に落ちる
    expect(lastSdkQueryOptions?.systemPrompt).toBeUndefined();
    expect(lastSdkQueryOptions?.settingSources).toEqual(['project', 'user', 'local']);
  });
});
