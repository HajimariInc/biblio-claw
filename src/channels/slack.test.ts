/**
 * Tests for the Slack channel adapter's factory — specifically that the
 * factory returns null when either of the Socket Mode credentials is missing,
 * preventing a half-configured adapter from being instantiated.
 *
 * The factory is registered on import via `registerChannelAdapter('slack', ...)`,
 * so the test captures the registration call to extract the factory closure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelRegistration } from './adapter.js';

const hoist = vi.hoisted(() => ({
  register: vi.fn(),
  createSlackAdapter: vi.fn(),
  readEnvFile: vi.fn(),
  createChatSdkBridge: vi.fn(() => ({ resolveChannelName: undefined as unknown })),
}));

vi.mock('./channel-registry.js', () => ({
  registerChannelAdapter: hoist.register,
}));
vi.mock('./chat-sdk-bridge.js', () => ({
  createChatSdkBridge: hoist.createChatSdkBridge,
}));
vi.mock('@chat-adapter/slack', () => ({
  createSlackAdapter: hoist.createSlackAdapter,
}));
vi.mock('../env.js', () => ({
  readEnvFile: hoist.readEnvFile,
}));

describe('Slack channel adapter factory', () => {
  let factory: ChannelRegistration['factory'];

  beforeEach(async () => {
    hoist.register.mockReset();
    hoist.createSlackAdapter.mockReset();
    hoist.readEnvFile.mockReset();
    hoist.createChatSdkBridge.mockClear();
    vi.resetModules();
    await import('./slack.js');
    expect(hoist.register).toHaveBeenCalledTimes(1);
    const [name, registration] = hoist.register.mock.calls[0] as [string, ChannelRegistration];
    expect(name).toBe('slack');
    factory = registration.factory;
  });

  it('returns null when SLACK_APP_TOKEN is missing — half-config must not instantiate Socket Mode', async () => {
    hoist.readEnvFile.mockReturnValue({ SLACK_BOT_TOKEN: 'xoxb-foo', SLACK_APP_TOKEN: '' });
    expect(await factory()).toBeNull();
    expect(hoist.createSlackAdapter).not.toHaveBeenCalled();
    expect(hoist.createChatSdkBridge).not.toHaveBeenCalled();
  });

  it('returns null when SLACK_BOT_TOKEN is missing', async () => {
    hoist.readEnvFile.mockReturnValue({ SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: 'xapp-bar' });
    expect(await factory()).toBeNull();
    expect(hoist.createSlackAdapter).not.toHaveBeenCalled();
  });

  it('returns null when both tokens are missing', async () => {
    hoist.readEnvFile.mockReturnValue({});
    expect(await factory()).toBeNull();
  });

  it('creates the Slack adapter in Socket Mode when both tokens are present', async () => {
    hoist.readEnvFile.mockReturnValue({ SLACK_BOT_TOKEN: 'xoxb-foo', SLACK_APP_TOKEN: 'xapp-bar' });
    hoist.createSlackAdapter.mockReturnValue({ fetchThread: vi.fn() });
    const result = await factory();
    expect(result).not.toBeNull();
    expect(hoist.createSlackAdapter).toHaveBeenCalledWith({
      mode: 'socket',
      botToken: 'xoxb-foo',
      appToken: 'xapp-bar',
    });
    expect(hoist.createChatSdkBridge).toHaveBeenCalled();
  });
});
