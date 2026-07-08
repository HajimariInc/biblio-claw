import { describe, expect, it, vi } from 'vitest';

import type { Adapter, AdapterPostableMessage, RawMessage } from 'chat';

vi.mock('../log.js', () => ({
  log: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { log } from '../log.js';

import { createChatSdkBridge, splitForLimit } from './chat-sdk-bridge.js';

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

interface PostCall {
  threadId: string;
  message: AdapterPostableMessage;
}

function makePostCapture() {
  const calls: PostCall[] = [];
  const postMessage = async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
    calls.push({ threadId, message });
    return { id: 'msg-stub', threadId, raw: {} };
  };
  return { calls, postMessage };
}

describe('splitForLimit', () => {
  it('returns a single chunk when text fits', () => {
    expect(splitForLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const chunks = splitForLimit(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('falls back to line boundaries when no paragraph fits', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot';
    const chunks = splitForLimit(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(100);
    const chunks = splitForLimit(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunks.join('')).toBe(text);
  });
});

describe('createChatSdkBridge', () => {
  // The bridge is now transport-only: forward inbound events, relay outbound
  // ops. All per-wiring engage / accumulate / drop / subscribe decisions live
  // in the router (src/router.ts routeInbound / evaluateEngage) and are
  // exercised by host-core.test.ts end-to-end. These tests only cover the
  // bridge's narrow, platform-adjacent surface.

  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });

  it('exposes subscribe (lets the router initiate thread subscription on mention-sticky engage)', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: true,
    });
    expect(typeof bridge.subscribe).toBe('function');
  });
});

describe('createChatSdkBridge.deliver — display cards (send_card)', () => {
  // The send_card MCP tool writes outbound rows with `{ type: 'card', card, fallbackText }`.
  // Before this branch existed the bridge silently dropped them: cards have no
  // `text` / `markdown`, so the trailing fallback `if (text)` was false and the
  // function returned without calling the adapter. These tests pin the contract
  // for the dedicated card branch.

  it('renders title, description, and string children, then posts via the adapter', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Daily',
          description: 'Your plate today',
          children: ['• item one', '• item two'],
        },
        fallbackText: 'Daily: your plate',
      },
    });
    expect(id).toBe('msg-stub');
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { card?: unknown; fallbackText?: string };
    expect(msg.fallbackText).toBe('Daily: your plate');
    expect(msg.card).toBeDefined();
  });

  it('drops actions without url (send_card is fire-and-forget; non-URL buttons would have nowhere to land)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Card',
          description: 'has only label-only actions',
          actions: [{ label: 'Add' }, { label: 'Skip' }],
        },
      },
    });
    expect(calls).toHaveLength(1);
    // Cast through the public Card shape to read the children we set
    const msg = calls[0].message as { card?: { children?: Array<{ type?: string }> } };
    const childTypes = (msg.card?.children ?? []).map((c) => c.type);
    expect(childTypes).not.toContain('actions');
  });

  it('renders url actions as link buttons inside an Actions row', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [{ label: 'Open', url: 'https://example.com' }, { label: 'No-link' }],
        },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string }> }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    const buttons = actionsRow?.children ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].type).toBe('link-button');
    expect(buttons[0].url).toBe('https://example.com');
  });

  it('skips delivery when the card has neither title nor body content', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { type: 'card', card: {} },
    });
    expect(id).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('falls through to the text branch for non-card chat-sdk payloads (no regression)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { text: 'plain hello' },
    });
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { markdown?: string };
    expect(msg.markdown).toBe('plain hello');
  });
});

// bridge.setTyping の status forward の contract test。`status ?? undefined` 正規化
// (vendor 側 `"Typing..."` fallback 温存の要) が silent regression する経路を塞ぐ
// 最小の contract test。
describe('createChatSdkBridge.setTyping (status forward)', () => {
  interface TypingCall {
    tid: string;
    status: string | undefined;
  }

  function makeTypingCapture(): { calls: TypingCall[]; startTyping: (tid: string, status?: string) => Promise<void> } {
    const calls: TypingCall[] = [];
    const startTyping = async (tid: string, status?: string): Promise<void> => {
      calls.push({ tid, status });
    };
    return { calls, startTyping };
  }

  it('forwards non-null status to vendor startTyping as-is', async () => {
    const { calls, startTyping } = makeTypingCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ startTyping } as Partial<Adapter>),
      supportsThreads: true,
    });
    await bridge.setTyping!('U1', 'T1', 'Web 検索中');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ tid: 'T1', status: 'Web 検索中' });
  });

  it('normalizes null status to undefined (vendor default fallback)', async () => {
    const { calls, startTyping } = makeTypingCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ startTyping } as Partial<Adapter>),
      supportsThreads: true,
    });
    await bridge.setTyping!('U1', 'T1', null);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ tid: 'T1', status: undefined });
  });

  it('normalizes undefined status to undefined (vendor default fallback)', async () => {
    const { calls, startTyping } = makeTypingCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ startTyping } as Partial<Adapter>),
      supportsThreads: true,
    });
    await bridge.setTyping!('U1', 'T1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ tid: 'T1', status: undefined });
  });

  it('falls back to platformId when threadId is null (=DM 経路)', async () => {
    const { calls, startTyping } = makeTypingCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ startTyping } as Partial<Adapter>),
      supportsThreads: true,
    });
    await bridge.setTyping!('U1', null, '仕入れ中');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ tid: 'U1', status: '仕入れ中' });
  });
});

// chat-sdk-bridge の setTyping は vendor `startTyping()` 呼出時に
// `progress.status.transition` info emit で「送信を試みた事実」を確定的に記録する。
// vendor 内部の 401/429 は本 code から取れないため outcome='triggered' で統一。
describe('createChatSdkBridge.setTyping progress.status.transition emit', () => {
  it('emits progress.status.transition with vendor call params (source=chat-sdk-bridge.setTyping)', async () => {
    vi.mocked(log.info).mockClear();
    const startTyping = async (): Promise<void> => {};
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ startTyping } as Partial<Adapter>),
      supportsThreads: true,
    });
    await bridge.setTyping!('U1', 'T1', 'Web 検索中');

    expect(log.info).toHaveBeenCalledWith(
      'progress.status.transition',
      expect.objectContaining({
        event: 'progress.status.transition',
        source: 'chat-sdk-bridge.setTyping',
        channel_type: 'slack',
        platform_id: 'U1',
        thread_id: 'T1',
        vendor_thread_id: 'T1',
        status: 'Web 検索中',
        adapter_supports_typing: true,
        outcome: 'triggered',
      }),
    );
  });

  it('emit payload uses vendor_thread_id=platformId when threadId is null (DM 経路)', async () => {
    vi.mocked(log.info).mockClear();
    const startTyping = async (): Promise<void> => {};
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ startTyping } as Partial<Adapter>),
      supportsThreads: true,
    });
    await bridge.setTyping!('U1', null, '仕入れ中');

    expect(log.info).toHaveBeenCalledWith(
      'progress.status.transition',
      expect.objectContaining({
        source: 'chat-sdk-bridge.setTyping',
        platform_id: 'U1',
        thread_id: null,
        vendor_thread_id: 'U1',
        status: '仕入れ中',
      }),
    );
  });
});
