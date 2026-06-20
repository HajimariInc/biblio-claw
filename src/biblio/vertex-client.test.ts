/**
 * vertex-client のユニットテスト。
 *
 * カバー対象:
 *   - `callVertexAnthropic` (Phase 3 で追加): body 構造 / response parse / 4xx throw
 *   - `setupVertexProxy` (= EnvHttpProxyAgent 経路に切替後の構造的バグ回帰防止):
 *       - NO_PROXY 未設定時に `127.0.0.1` と `localhost` が必ず含まれること
 *       - 既存 `NO_PROXY` との union で元の値が失われないこと
 *       - proxy 未解決時に dispatcher install されない fail-open 挙動の温存
 *
 * 既存 `callVertexGemini` は別経路 (Phase 2 で実機検証済) のため触らない。
 *
 * mock 方針:
 *   - undici は fetch / EnvHttpProxyAgent / setGlobalDispatcher を hoisted mock で観測
 *   - `node:fs.readFileSync` は CA file 読込を固定値に差し替え
 *   - `./host-proxy.js` の `getProxyState` は各テストで返り値を設定
 *   - log / env も既存通り mock (= 起動時の env 依存を排除)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { fetchMock, envHttpProxyAgentCtorMock, setGlobalDispatcherMock, readFileSyncMock, getProxyStateMock } =
  vi.hoisted(() => ({
    fetchMock: vi.fn(),
    envHttpProxyAgentCtorMock: vi.fn(),
    setGlobalDispatcherMock: vi.fn(),
    readFileSyncMock: vi.fn(() => 'FAKE-CA-PEM'),
    getProxyStateMock: vi.fn(),
  }));

vi.mock('undici', () => ({
  fetch: fetchMock,
  EnvHttpProxyAgent: class {
    constructor(opts: unknown) {
      envHttpProxyAgentCtorMock(opts);
    }
  },
  setGlobalDispatcher: setGlobalDispatcherMock,
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

vi.mock('./host-proxy.js', () => ({
  getProxyState: getProxyStateMock,
}));

vi.mock('node:fs', () => ({
  default: { readFileSync: readFileSyncMock },
}));

import { callVertexAnthropic, setupVertexProxy } from './vertex-client.js';

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

/**
 * `setupVertexProxy` 回帰テスト。
 *
 * commit `d66058a` (= `ProxyAgent` → `EnvHttpProxyAgent` + noProxy 化) で修正した構造的バグ
 * (= OneCLI 管理 API `127.0.0.1:10254` への fetch が proxy 経由でループ → agent コンテナ
 * spawn が永久に失敗) の **回帰検知** を目的とする。`setupVertexProxy()` は host 起動時に
 * 1 回呼ばれ、以降は無症状期間が長い (= Slack 経由 agent spawn が失敗するまで気付かない)
 * ため、unit test で振る舞いを固定する価値が高い。
 */
describe('setupVertexProxy — noProxy 構成', () => {
  let originalNoProxy: string | undefined;
  let originalNoProxyLower: string | undefined;

  beforeEach(() => {
    envHttpProxyAgentCtorMock.mockReset();
    setGlobalDispatcherMock.mockReset();
    readFileSyncMock.mockReset().mockReturnValue('FAKE-CA-PEM');
    getProxyStateMock.mockReset();
    // 既存テスト環境に NO_PROXY が漏れていたら待避し、各テスト先頭で空状態から組み立てる
    originalNoProxy = process.env.NO_PROXY;
    originalNoProxyLower = process.env.no_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  });

  afterEach(() => {
    if (originalNoProxy !== undefined) {
      process.env.NO_PROXY = originalNoProxy;
    } else {
      delete process.env.NO_PROXY;
    }
    if (originalNoProxyLower !== undefined) {
      process.env.no_proxy = originalNoProxyLower;
    } else {
      delete process.env.no_proxy;
    }
  });

  it('NO_PROXY 未設定時、noProxy に 127.0.0.1 と localhost が必ず含まれる (= 構造的バグの回帰防止)', () => {
    getProxyStateMock.mockReturnValue({
      httpsProxy: 'http://x:secret@127.0.0.1:10255',
      caPath: '/tmp/fake-ca.pem',
    });
    setupVertexProxy();
    expect(envHttpProxyAgentCtorMock).toHaveBeenCalledTimes(1);
    const opts = envHttpProxyAgentCtorMock.mock.calls[0][0] as {
      httpsProxy: string;
      noProxy: string;
      requestTls: { ca: string };
      proxyTls: { ca: string };
    };
    expect(opts.noProxy.split(',')).toEqual(expect.arrayContaining(['127.0.0.1', 'localhost']));
    expect(opts.httpsProxy).toBe('http://x:secret@127.0.0.1:10255');
    expect(opts.requestTls.ca).toBe('FAKE-CA-PEM');
    expect(opts.proxyTls.ca).toBe('FAKE-CA-PEM');
    expect(setGlobalDispatcherMock).toHaveBeenCalledTimes(1);
  });

  it('既存 NO_PROXY との union — 元の値が失われない (GKE 内部 DNS bypass 等のケース)', () => {
    process.env.NO_PROXY = 'internal.cluster.local,svc.local';
    getProxyStateMock.mockReturnValue({
      httpsProxy: 'http://x:secret@127.0.0.1:10255',
      caPath: '/tmp/fake-ca.pem',
    });
    setupVertexProxy();
    const opts = envHttpProxyAgentCtorMock.mock.calls[0][0] as { noProxy: string };
    const parts = opts.noProxy.split(',');
    expect(parts).toEqual(expect.arrayContaining(['127.0.0.1', 'localhost', 'internal.cluster.local', 'svc.local']));
  });

  it('proxy 未解決なら dispatcher を install しない (= fail-open 温存)', () => {
    getProxyStateMock.mockReturnValue({ httpsProxy: undefined, caPath: undefined });
    setupVertexProxy();
    expect(envHttpProxyAgentCtorMock).not.toHaveBeenCalled();
    expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
  });
});
