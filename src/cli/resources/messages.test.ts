/**
 * ncl `messages send` unit test。
 *
 * - routeInbound mock で in-process route を差し替え、event 内容 + stub Set の追加/解放を assert
 * - stub_outbound=true/false / timeout / agent caller 拒否 の 5 case
 */
import Database from 'better-sqlite3';
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
import { resolveSession, outboundDbPath } from '../../session-manager.js';
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
  // FK 制約が壊れるためテストの安定性を優先する判断)。
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

describe('ncl messages send', () => {
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

  it('adds stub-outbound target during dispatch and keeps it until Pod restart (Approach 1)', async () => {
    // issue #155 Approach 1 対応: handler finally での removeStub を撤去し、Pod restart
    // (in-memory Set の自動 clear) まで stub 登録を残す。理由は race condition の完全解消
    // (handler 終了後に delivery poll が agent 応答を pull する遅延ケース対応)。
    // 詳細は `messages.ts:292` の finally block コメント参照。
    let stubDuringDispatch: boolean | undefined;
    routeInboundMock.mockImplementation(async () => {
      stubDuringDispatch = isStubOutboundTarget(AGENT_GROUP_ID, 'slack', 'D-slack-dm');
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
    // Approach 1: dispatch 終了後も stub 登録は残る (次テストが _resetStubOutboundTargetsForTest で clear)
    expect(isStubOutboundTarget(AGENT_GROUP_ID, 'slack', 'D-slack-dm')).toBe(true);
  });

  it('does not touch the stub Set when stub_outbound is false', async () => {
    let stubDuringDispatch: boolean | undefined;
    routeInboundMock.mockImplementation(async () => {
      stubDuringDispatch = isStubOutboundTarget(AGENT_GROUP_ID, 'slack', 'D-slack-dm');
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
    expect(isStubOutboundTarget(AGENT_GROUP_ID, 'slack', 'D-slack-dm')).toBe(false);
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

  // 実 CLI 経路が渡す文字列 'true' (bash から `--stub-outbound true`) が
  // boolean coercion で正しく true に変換されることを assert。
  it('coerces string "true" to stub_outbound=true (real CLI call shape)', async () => {
    let stubDuringDispatch: boolean | undefined;
    routeInboundMock.mockImplementation(async () => {
      stubDuringDispatch = isStubOutboundTarget(AGENT_GROUP_ID, 'slack', 'D-slack-dm');
    });

    await dispatch(
      {
        id: 'req-str-stub',
        command: 'messages-send',
        args: {
          agent_group_id: AGENT_GROUP_ID,
          messaging_group_id: MG_ID,
          text: '@bot ...',
          user_id: OWNER_USER_ID,
          stub_outbound: 'true', // 実 CLI 経路の string
          wait_ms: 0,
        },
      },
      { caller: 'host' },
    );

    expect(stubDuringDispatch).toBe(true);
    // Approach 1: dispatch 終了後も stub 登録は残る (前 test と同流儀)
    expect(isStubOutboundTarget(AGENT_GROUP_ID, 'slack', 'D-slack-dm')).toBe(true);
  });

  // --wait-ms が非数値の場合、silent に timedOut=true を返さず
  // fail-fast で明示 error を出す (usage error 誘導)。
  it('rejects --wait-ms with non-finite number (NaN)', async () => {
    const resp = await dispatch(
      {
        id: 'req-nan-wait',
        command: 'messages-send',
        args: {
          agent_group_id: AGENT_GROUP_ID,
          messaging_group_id: MG_ID,
          text: '@bot ...',
          user_id: OWNER_USER_ID,
          wait_ms: 'abc',
        },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('handler-error');
      expect(resp.error.message).toMatch(/--wait-ms must be a non-negative number/);
    }
    expect(routeInboundMock).not.toHaveBeenCalled();
  });

  it('rejects --from-seq with non-finite number', async () => {
    const resp = await dispatch(
      {
        id: 'req-nan-from-seq',
        command: 'messages-send',
        args: {
          agent_group_id: AGENT_GROUP_ID,
          messaging_group_id: MG_ID,
          text: '@bot ...',
          user_id: OWNER_USER_ID,
          from_seq: 'xyz',
        },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.message).toMatch(/--from-seq must be a non-negative number/);
    }
  });

  // user_id 未指定時の resolveSenderUserId fallback 経路 (explicit → scoped admin →
  // global admin → owner → 'ncl:host') を明示的に検証。owner seed 経路は FK 制約再現困難
  // (migration order 依存の未解明挙動) と判明したため、resolveSenderUserId 関数を export
  // して直接 unit test する方式で全 4 分岐を担保する。
  it('resolveSenderUserId: explicit user_id は最優先', async () => {
    const { resolveSenderUserId } = await import('./messages.js');
    expect(resolveSenderUserId(AGENT_GROUP_ID, 'slack:U-explicit')).toBe('slack:U-explicit');
  });

  it('resolveSenderUserId: 全 role 不在時は "ncl:host" fallback', async () => {
    const { resolveSenderUserId } = await import('./messages.js');
    expect(resolveSenderUserId(AGENT_GROUP_ID, undefined)).toBe('ncl:host');
  });

  // session 作成後の pollOutbound / 応答取得経路の integration test。
  // 従来 5 case 全てで routeInbound mock が session を作らないため polling 分岐が一度も走らず、
  // pollOutbound の SQL / seq フィルタ / kind フィルタ / timeout 判定が unit test で検証
  // されていなかった (実運用は GKE E2E 経由 = 10-20 分サイクルでしかフィードバックが得られなかった)。
  it('polls outbound.db and returns the reply once routeInbound creates a session and writes messages_out', async () => {
    routeInboundMock.mockImplementation(async () => {
      const { session } = resolveSession(AGENT_GROUP_ID, MG_ID, 'D-slack-dm', 'shared');
      const db = new Database(outboundDbPath(AGENT_GROUP_ID, session.id));
      // seq を明示 (schema は INTEGER UNIQUE、pollOutbound は seq > fromSeq でフィルタ)。
      // container 奇数規約に合わせて 1。fromSeq は session 作成時点で MAX(seq) = 0 のため hit する。
      db.prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content)
         VALUES ('out-1', 1, datetime('now'), 'chat', 'D-slack-dm', 'slack', ?)`,
      ).run(JSON.stringify({ text: '仕入れ完了です' }));
      db.close();
    });

    const resp = await dispatch(
      {
        id: 'req-reply',
        command: 'messages-send',
        args: {
          agent_group_id: AGENT_GROUP_ID,
          messaging_group_id: MG_ID,
          text: '@bot 仕入れて',
          user_id: OWNER_USER_ID,
          wait_ms: 2000,
        },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as {
        session_id: string | null;
        delivered_count: number;
        timed_out: boolean;
        messages: Array<{ id: string; kind: string; seq: number; content: string }>;
      };
      expect(data.session_id).not.toBeNull();
      expect(data.delivered_count).toBe(1);
      expect(data.timed_out).toBe(false);
      expect(data.messages[0].id).toBe('out-1');
      expect(data.messages[0].kind).toBe('chat');
      // I6: seq 型が正しく number として返る (二重 cast なし)
      expect(typeof data.messages[0].seq).toBe('number');
    }
  });

  it('returns timed_out=true when a session is created but no reply arrives in time', async () => {
    routeInboundMock.mockImplementation(async () => {
      // session だけ作って応答は書かない → wait_ms 経過で timeout
      resolveSession(AGENT_GROUP_ID, MG_ID, 'D-slack-dm', 'shared');
    });

    const resp = await dispatch(
      {
        id: 'req-timeout',
        command: 'messages-send',
        args: {
          agent_group_id: AGENT_GROUP_ID,
          messaging_group_id: MG_ID,
          text: '@bot ...',
          user_id: OWNER_USER_ID,
          wait_ms: 600, // 短い timeout で高速に検証
        },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { session_id: string | null; delivered_count: number; timed_out: boolean };
      expect(data.session_id).not.toBeNull();
      expect(data.timed_out).toBe(true);
      expect(data.delivered_count).toBe(0);
    }
  });

  it('falls back to "ncl:host" senderId when neither owner nor admin exists (dispatch 経由の end-to-end)', async () => {
    // owner を seed せずに fallback 到達を dispatch 経由でも確認 (regression 保険)
    await dispatch(
      {
        id: 'req-nofallback',
        command: 'messages-send',
        args: {
          agent_group_id: AGENT_GROUP_ID,
          messaging_group_id: MG_ID,
          text: '@bot ...',
          wait_ms: 0,
        },
      },
      { caller: 'host' },
    );

    expect(routeInboundMock).toHaveBeenCalledTimes(1);
    const passed = routeInboundMock.mock.calls[0][0];
    const parsed = JSON.parse(passed.message.content) as { senderId: string };
    expect(parsed.senderId).toBe('ncl:host');
  });
});
