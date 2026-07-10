import { describe, expect, it } from 'vitest';

import {
  getAnthropicVertexRequestContext,
  runWithAnthropicVertexRequestContext,
} from '../anthropic-vertex-request-context.js';

describe('anthropic-vertex-request-context', () => {
  it('store 外から getAnthropicVertexRequestContext を呼ぶと undefined を返す (silent 化しない前提)', () => {
    expect(getAnthropicVertexRequestContext()).toBeUndefined();
  });

  it('runWithAnthropicVertexRequestContext の中で context が回収できる', async () => {
    const inner = await runWithAnthropicVertexRequestContext(
      { requestId: 'req-1', sessionId: 'sess-1', channelType: 'cli' },
      async () => getAnthropicVertexRequestContext(),
    );
    expect(inner).toEqual({ requestId: 'req-1', sessionId: 'sess-1', channelType: 'cli' });
  });

  it('async 経路 (Promise / setTimeout) を跨いでも context を保持する', async () => {
    const result = await runWithAnthropicVertexRequestContext(
      { requestId: 'req-2', sessionId: 'sess-2', channelType: 'slack' },
      async () => {
        // setTimeout の callback 経由でも AsyncLocalStorage は context を propagate する
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getAnthropicVertexRequestContext();
      },
    );
    expect(result?.requestId).toBe('req-2');
    expect(result?.channelType).toBe('slack');
  });
});
