/**
 * vertex-client.callVertexAnthropic のユニットテスト (Phase 3 で追加した関数のみ対象)。
 *
 * - undici.fetch を vi.mock で差し替え、body 構造 + response parse + 4xx throw を網羅
 * - readEnvFile も mock して `CATEGORIZE_MODEL` / `ANTHROPIC_VERTEX_PROJECT_ID` / `CLOUD_ML_REGION`
 *   をテスト側で固定する (= 起動時の env 依存を排除)
 *
 * 既存 callVertexGemini は別経路 (Phase 2 で実機検証済) のため触らない。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('undici', () => ({
  fetch: fetchMock,
  ProxyAgent: class {},
  setGlobalDispatcher: vi.fn(),
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({
    ANTHROPIC_VERTEX_PROJECT_ID: 'test-project',
    CLOUD_ML_REGION: 'global',
    CATEGORIZE_MODEL: 'claude-sonnet-4-6',
  })),
}));

import { callVertexAnthropic } from './vertex-client.js';

/** 簡易 Response モック (ok / status / json / text)。 */
function res(
  status: number,
  body: unknown,
): {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
} {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('callVertexAnthropic — request body 構造', () => {
  it('anthropic_version / messages / max_tokens / temperature / system を載せて POST する', async () => {
    fetchMock.mockResolvedValue(res(200, { content: [{ type: 'text', text: 'CATEGORY: biblio-dev\nREASON: x' }] }));
    await callVertexAnthropic({
      prompt: 'judge this',
      system: 'you are a librarian',
      maxTokens: 256,
      temperature: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    const url = call[0] as string;
    const init = call[1] as { method?: string; body?: string };
    // URL は publishers/anthropic/.../rawPredict 経路 (= GOTCHA-3 / OneCLI MITM 対応)
    expect(url).toContain('/publishers/anthropic/models/claude-sonnet-4-6:rawPredict');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.anthropic_version).toBe('vertex-2023-10-16');
    expect(body.messages).toEqual([{ role: 'user', content: 'judge this' }]);
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0);
    expect(body.system).toBe('you are a librarian');
  });

  it('system を渡さなければ body から system フィールドを省く (空文字回避)', async () => {
    fetchMock.mockResolvedValue(res(200, { content: [{ type: 'text', text: 'ok' }] }));
    await callVertexAnthropic({ prompt: 'x', maxTokens: 32, temperature: 0 });
    const init = fetchMock.mock.calls[0][1] as { body?: string };
    const body = JSON.parse(init.body as string);
    expect(body.system).toBeUndefined();
  });
});

describe('callVertexAnthropic — response parse', () => {
  it('content[type=text].text を取り出して返す', async () => {
    fetchMock.mockResolvedValue(
      res(200, {
        content: [{ type: 'text', text: 'CATEGORY: biblio-art\nREASON: image' }],
        stop_reason: 'end_turn',
      }),
    );
    const text = await callVertexAnthropic({ prompt: 'x', maxTokens: 32, temperature: 0 });
    expect(text).toBe('CATEGORY: biblio-art\nREASON: image');
  });

  it('content[] に text ブロックが無いと throw する (応答崩れ防御)', async () => {
    fetchMock.mockResolvedValue(res(200, { content: [{ type: 'tool_use' }] }));
    await expect(callVertexAnthropic({ prompt: 'x', maxTokens: 32, temperature: 0 })).rejects.toThrow(
      /content\[type=text\]\.text/,
    );
  });
});

describe('callVertexAnthropic — 4xx/5xx', () => {
  it('403 (project enable 未了) を status 付きで throw する', async () => {
    fetchMock.mockResolvedValue(res(403, 'Publisher Model not found or access denied'));
    await expect(callVertexAnthropic({ prompt: 'x', maxTokens: 32, temperature: 0 })).rejects.toThrow(/403/);
  });
});
