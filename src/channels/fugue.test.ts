/**
 * Fugue channel adapter factory unit tests (M4-E Phase 1)。
 *
 * `createFugueAdapter` の credential 分岐 + default port + deliver throw を検証する。
 * `registerChannelAdapter('fugue', ...)` は import で発火するため、mock で
 * factory 参照を取り出して直接呼ぶ (Slack test の写経、`src/channels/slack.test.ts:1-79`)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelRegistration } from './adapter.js';

const hoist = vi.hoisted(() => ({
  register: vi.fn(),
  readEnvFile: vi.fn(),
  fugueServerInstances: [] as Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    isListening: ReturnType<typeof vi.fn>;
    ctorArgs: unknown[];
  }>,
  FugueHttpServer: vi.fn(),
}));

vi.mock('./channel-registry.js', () => ({
  registerChannelAdapter: hoist.register,
}));
vi.mock('../env.js', () => ({
  readEnvFile: hoist.readEnvFile,
}));
vi.mock('./fugue-http.js', () => ({
  FugueHttpServer: hoist.FugueHttpServer,
}));

describe('Fugue channel adapter factory', () => {
  let factory: ChannelRegistration['factory'];

  beforeEach(async () => {
    hoist.register.mockReset();
    hoist.readEnvFile.mockReset();
    hoist.fugueServerInstances.length = 0;
    hoist.FugueHttpServer.mockReset();
    // regular function (not arrow) so `new FugueHttpServer(...)` is constructable.
    // arrow functions are not [[Construct]]-able and would throw TypeError under `new`.
    hoist.FugueHttpServer.mockImplementation(function (this: Record<string, unknown>, ...ctorArgs: unknown[]) {
      this.start = vi.fn(async () => ({ port: 8080 }));
      this.stop = vi.fn(async () => {});
      this.isListening = vi.fn(() => true);
      this.ctorArgs = ctorArgs;
      hoist.fugueServerInstances.push(this as unknown as (typeof hoist.fugueServerInstances)[number]);
    });

    vi.resetModules();
    await import('./fugue.js');
    expect(hoist.register).toHaveBeenCalledTimes(1);
    const [name, registration] = hoist.register.mock.calls[0] as [string, ChannelRegistration];
    expect(name).toBe('fugue');
    factory = registration.factory;
  });

  it('returns null when FUGUE_SHARED_TOKEN is missing (empty string)', async () => {
    hoist.readEnvFile.mockReturnValue({ FUGUE_SHARED_TOKEN: '' });
    expect(await factory()).toBeNull();
    expect(hoist.FugueHttpServer).not.toHaveBeenCalled();
  });

  it('returns an adapter with name=fugue, channelType=fugue, supportsThreads=false when token is present', async () => {
    hoist.readEnvFile.mockReturnValue({
      FUGUE_SHARED_TOKEN: 'test-token-value',
      FUGUE_HTTP_PORT: '9090',
      FUGUE_HTTP_HOST: '0.0.0.0',
    });
    const adapter = await factory();
    expect(adapter).not.toBeNull();
    expect(adapter?.name).toBe('fugue');
    expect(adapter?.channelType).toBe('fugue');
    expect(adapter?.supportsThreads).toBe(false);
    expect(hoist.FugueHttpServer).toHaveBeenCalledTimes(1);
    // FugueHttpServer に渡した opts に token / port / host が正しく反映される
    const [ctorOpts] = hoist.fugueServerInstances[0]!.ctorArgs as [
      { port: number; host: string; expectedToken: string },
    ];
    expect(ctorOpts.expectedToken).toBe('test-token-value');
    expect(ctorOpts.port).toBe(9090);
    expect(ctorOpts.host).toBe('0.0.0.0');
  });

  it('uses default port 8080 and host 127.0.0.1 when only FUGUE_SHARED_TOKEN is set', async () => {
    hoist.readEnvFile.mockReturnValue({ FUGUE_SHARED_TOKEN: 'test-token-value' });
    const adapter = await factory();
    expect(adapter).not.toBeNull();
    const [ctorOpts] = hoist.fugueServerInstances[0]!.ctorArgs as [
      { port: number; host: string; expectedToken: string },
    ];
    expect(ctorOpts.port).toBe(8080);
    expect(ctorOpts.host).toBe('127.0.0.1');
  });

  it('deliver() throws to surface upstream bugs (silent no-op elimination)', async () => {
    hoist.readEnvFile.mockReturnValue({ FUGUE_SHARED_TOKEN: 'test-token-value' });
    const adapter = await factory();
    expect(adapter).not.toBeNull();
    await expect(adapter!.deliver('platform-id', null, { kind: 'chat', content: {} })).rejects.toThrow(
      /not implemented|synchronous HTTP/,
    );
  });
});
