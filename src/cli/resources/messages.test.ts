/**
 * ncl `messages send` unit test。
 *
 * - routeInbound mock で in-process route を差し替え、event 内容 + stub Set の追加/解放を assert
 * - stub_outbound=true/false / timeout / agent caller 拒否 の 5 case
 */
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import type { InboundEvent } from '../../channels/adapter.js';

const routeInboundMock = vi.fn<(event: InboundEvent) => Promise<void>>();

vi.mock('../../router.js', () => ({
  routeInbound: (event: InboundEvent) => routeInboundMock(event),
}));

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-messages' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-messages';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import { _resetStubOutboundTargetsForTest, isStubOutboundTarget } from '../../delivery.js';
// Side-effect: registers the messages-send command in the CLI registry.
import './messages.js';

const AGENT_GROUP_ID = 'ag-hybrid';
const MG_ID = 'mg-slack-dm';
const OWNER_USER_ID = 'slack:U-owner';

function now(): string {
  return new Date().toISOString();
}

function setupWorld(): void {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({
    id: AGENT_GROUP_ID,
    name: 'hybrid-biblio',
    folder: 'hybrid-biblio',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: MG_ID,
    channel_type: 'slack',
    platform_id: 'D-slack-dm',
    name: 'DM',
    is_group: 0,
    unknown_sender_policy: 'request_approval',
    denied_at: null,
    created_at: now(),
  });
  // resolveSenderUserId の owner fallback 経路は verify 経路 (実 DB + owner seed) で担保する。
  // unit test は explicit --user-id を渡す経路で行う (owner seed は migration order 依存で
  // FK 制約が壊れるためテストの安定性を優先する判断 = M4-F Phase 5 実装時判断)。
}

beforeEach(() => {
  routeInboundMock.mockReset();
  routeInboundMock.mockResolvedValue(undefined);
  _resetStubOutboundTargetsForTest();
  setupWorld();
});

afterEach(() => {
  closeDb();
  _resetStubOutboundTargetsForTest();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('ncl messages send (M4-F Phase 5)', () => {
  it('routes an InboundEvent to routeInbound with expected fields', async () => {
    const resp = await dispatch(
      {
        id: 'req-1',
        command: 'messages-send',
        args: {
          agent_group_id: AGENT_GROUP_ID,
          messaging_group_id: MG_ID,
          text: '@bot 蔵書を教えて',
          user_id: OWNER_USER_ID,
          wait_ms: 0, // session 未作成 → polling 即 timeout で return
        },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    expect(routeInboundMock).toHaveBeenCalledTimes(1);
    const passed = routeInboundMock.mock.calls[0][0];
    expect(passed.channelType).toBe('slack');
    expect(passed.platformId).toBe('D-slack-dm');
    expect(passed.threadId).toBe('D-slack-dm'); // default = platform_id (DM)
    expect(passed.message.kind).toBe('chat');
    expect(passed.message.isMention).toBe(true);
    const parsed = JSON.parse(passed.message.content) as {
      text: string;
      sender: string;
      senderId: string;
    };
    expect(parsed.text).toBe('@bot 蔵書を教えて');
    expect(parsed.senderId).toBe(OWNER_USER_ID);
    // response 側 metadata
    if (resp.ok) {
      const data = resp.data as { session_id: string | null; delivered_count: number; timed_out: boolean };
      expect(data.session_id).toBeNull(); // routeInbound mock で session を作成しないため
      expect(data.delivered_count).toBe(0);
      // session 未作成 → polling せず timedOut=false のまま return (仕様)。
      // 実 verify 経路では session が作成される (routeInbound が session を作る) → polling → timeout 判定される。
      expect(data.timed_out).toBe(false);
    }
  });

  it('adds stub-outbound target during dispatch and removes it in finally', async () => {
    // routeInbound の handler 内側で Set 状態を snapshot する。
    let stubDuringDispatch: boolean | undefined;
    routeInboundMock.mockImplementation(async () => {
      stubDuringDispatch = isStubOutboundTarget(AGENT_GROUP_ID, 'slack', 'D-slack-dm', 'D-slack-dm');
    });

    const resp = await dispatch(
      {
        id: 'req-stub',
        command: 'messages-send',
        args: {
          agent_group_id: AGENT_GROUP_ID,
          messaging_group_id: MG_ID,
          text: '@bot ...',
          user_id: OWNER_USER_ID,
          stub_outbound: true,
          wait_ms: 0,
        },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    expect(stubDuringDispatch).toBe(true);
    // finally で解放されている
    expect(isStubOutboundTarget(AGENT_GROUP_ID, 'slack', 'D-slack-dm', 'D-slack-dm')).toBe(false);
  });

  it('does not touch the stub Set when stub_outbound is false', async () => {
    let stubDuringDispatch: boolean | undefined;
    routeInboundMock.mockImplementation(async () => {
      stubDuringDispatch = isStubOutboundTarget(AGENT_GROUP_ID, 'slack', 'D-slack-dm', 'D-slack-dm');
    });

    const resp = await dispatch(
      {
        id: 'req-nostub',
        command: 'messages-send',
        args: {
          agent_group_id: AGENT_GROUP_ID,
          messaging_group_id: MG_ID,
          text: '@bot ...',
          user_id: OWNER_USER_ID,
          wait_ms: 0,
        },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    expect(stubDuringDispatch).toBe(false);
    expect(isStubOutboundTarget(AGENT_GROUP_ID, 'slack', 'D-slack-dm', 'D-slack-dm')).toBe(false);
  });

  it('rejects agent callers with forbidden error', async () => {
    const resp = await dispatch(
      {
        id: 'req-agent',
        command: 'messages-send',
        args: {
          agent_group_id: AGENT_GROUP_ID,
          messaging_group_id: MG_ID,
          text: '@bot ...',
        },
      },
      { caller: 'agent', agentGroupId: AGENT_GROUP_ID, sessionId: 'sess-any', messagingGroupId: MG_ID },
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toMatch(/host-only/);
    }
    // agent caller は routeInbound まで到達しない
    expect(routeInboundMock).not.toHaveBeenCalled();
  });

  it('rejects requests missing required args', async () => {
    const resp = await dispatch(
      {
        id: 'req-nomg',
        command: 'messages-send',
        args: {
          agent_group_id: AGENT_GROUP_ID,
          text: '@bot ...',
        },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('handler-error');
      expect(resp.error.message).toMatch(/--messaging-group-id/);
    }
    // routeInbound は呼ばれない
    expect(routeInboundMock).not.toHaveBeenCalled();
  });
});
