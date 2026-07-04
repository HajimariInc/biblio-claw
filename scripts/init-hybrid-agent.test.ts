/**
 * `scripts/init-hybrid-agent.ts` の seedHybridAgent() unit test (M4-F Phase 1)。
 *
 * 保護対象 (plan §Task 2 の 6 case + 実装で追加した fan-out fail-fast 保護
 * + PR #139 review 対応の 2 case):
 *   (1) 新規 seed: agent_group + container_config(provider=null, model=publisher ID) + Slack DM mg + mga
 *   (2) 冪等 assert: 2 回連続 seed で全テーブル count 不変
 *   (3) 既存 ADK agent group と並存: ADK 側 wire 無傷
 *   (4) Slack platform_id encoding: raw `D...` → `slack:D...` に encode
 *   (5) `--skip-slack-dm`: messaging_group 一切作らない (agent_group + config のみ)
 *   (6) container_config: provider=null (claude fallback), model='claude-sonnet-4-6' (Vertex publisher ID)
 *   (7) fan-out fail-fast: Slack DM 既存 mg が他 agent に wire 済なら process.exit(1)
 *   (8) I5 assert: skipSlackDm=false + slackDmChannelId 欠落なら fail-fast throw (silent skip 撲滅)
 *   (9) C3 guard: 既存 owner user は upsertUser で display_name を上書きされない (getUser guard 動作確認)
 *
 * fixture は `session-equipped-biblios.test.ts` の initTestDb + runMigrations
 * pattern を継承。`initGroupFilesystem` (= GROUPS_DIR に依存する fs 副作用) は
 * mock で `ensureContainerConfig` 呼び出しのみに簡素化 (= 本 test の focus は
 * DB seed logic であり、fs 側の scaffold は Task 5 の local 実測で確認する)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// initGroupFilesystem を「container_config 行だけ ensure する no-op mock」に置換。
// これにより GROUPS_DIR / DATA_DIR env の振り替えが不要になり、connection.ts の
// singleton _db をテスト全体で共有できる。
vi.mock('../src/group-init.js', async () => {
  const { ensureContainerConfig } = await import('../src/db/container-configs.js');
  return {
    initGroupFilesystem: (group: { id: string }) => {
      ensureContainerConfig(group.id);
    },
  };
});

vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { closeDb, initTestDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { getAllAgentGroups, createAgentGroup } from '../src/db/agent-groups.js';
import { getContainerConfig } from '../src/db/container-configs.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getAllMessagingGroups,
  getMessagingGroupAgents,
} from '../src/db/messaging-groups.js';
import { getUser, upsertUser } from '../src/modules/permissions/db/users.js';

import { seedHybridAgent, type Args } from './init-hybrid-agent.js';

const NOW = '2026-07-04T12:00:00.000Z';

function baseArgs(overrides: Partial<Args> = {}): Args {
  return {
    userId: 'slack:U7F8TRM6X',
    slackDmChannelId: 'D0B6JA2M5GA',
    displayName: 'Patron',
    agentName: '司書 (hybrid)',
    skipSlackDm: false,
    ...overrides,
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
});

describe('init-hybrid-agent: seedHybridAgent()', () => {
  it('(1) 新規 seed: agent_group + container_config(provider=null) + slack DM mg + mga を作成', () => {
    const result = seedHybridAgent(baseArgs(), NOW);

    // agent_group
    const ags = getAllAgentGroups();
    expect(ags).toHaveLength(1);
    expect(ags[0].folder).toBe('hybrid-biblio-shisho');
    expect(ags[0].id).toBe(result.agent_group_id);
    expect(result.is_new_group).toBe(true);

    // container_config: provider=null (= claude fallback), model=Vertex publisher ID
    const cc = getContainerConfig(result.agent_group_id);
    expect(cc).toBeDefined();
    expect(cc!.provider).toBeNull();
    expect(cc!.model).toBe('claude-sonnet-4-6');

    // Slack DM messaging_group (encoded platform_id, is_group=0)
    const mgs = getAllMessagingGroups();
    expect(mgs).toHaveLength(1);
    expect(mgs[0].channel_type).toBe('slack');
    expect(mgs[0].platform_id).toBe('slack:D0B6JA2M5GA');
    expect(mgs[0].is_group).toBe(0);

    // wiring (hybrid agent group のみ)
    const wirings = getMessagingGroupAgents(mgs[0].id);
    expect(wirings).toHaveLength(1);
    expect(wirings[0].agent_group_id).toBe(result.agent_group_id);
    expect(wirings[0].engage_mode).toBe('pattern');
    expect(wirings[0].engage_pattern).toBe('.');

    // SeedResult のフィールド
    expect(result.slack_dm_wired).toBe(true);
    expect(result.slack_dm_platform_id).toBe('slack:D0B6JA2M5GA');
  });

  it('(2) 冪等 assert: 2 回連続 seed で全テーブル count 不変', () => {
    const r1 = seedHybridAgent(baseArgs(), NOW);
    const r2 = seedHybridAgent(baseArgs(), NOW);

    expect(r1.agent_group_id).toBe(r2.agent_group_id);
    expect(r1.is_new_group).toBe(true);
    expect(r2.is_new_group).toBe(false);

    expect(getAllAgentGroups()).toHaveLength(1);
    expect(getAllMessagingGroups()).toHaveLength(1);
    const wirings = getMessagingGroupAgents(getAllMessagingGroups()[0].id);
    expect(wirings).toHaveLength(1);
  });

  it('(3) 既存 ADK agent group + 別 platform_id wire と並存: ADK 側無傷', () => {
    // ADK agent group + CLI wire を先に注入 (別 platform_id なので fan-out fail-fast は不発)。
    createAgentGroup({
      id: 'ag-adk-existing',
      name: '司書 (ADK)',
      folder: 'adk-biblio-shisho',
      agent_provider: null,
      created_at: NOW,
    });
    createMessagingGroup({
      id: 'mg-cli-existing',
      channel_type: 'cli',
      platform_id: 'local',
      name: 'Local CLI',
      is_group: 0,
      unknown_sender_policy: 'public',
      denied_at: null,
      created_at: NOW,
    });
    createMessagingGroupAgent({
      id: 'mga-cli-adk',
      messaging_group_id: 'mg-cli-existing',
      agent_group_id: 'ag-adk-existing',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: NOW,
    });

    const result = seedHybridAgent(baseArgs(), NOW);

    // ADK 側 CLI wire は無傷。
    const cliWirings = getMessagingGroupAgents('mg-cli-existing');
    expect(cliWirings).toHaveLength(1);
    expect(cliWirings[0].agent_group_id).toBe('ag-adk-existing');

    // hybrid 側は独自の Slack DM mg (別 platform_id) で共存。
    expect(getAllAgentGroups()).toHaveLength(2);
    const mgs = getAllMessagingGroups();
    expect(mgs).toHaveLength(2); // cli/local + slack:D0B6JA2M5GA
    const hybridMg = mgs.find((mg) => mg.channel_type === 'slack')!;
    expect(hybridMg.platform_id).toBe('slack:D0B6JA2M5GA');
    const hybridWirings = getMessagingGroupAgents(hybridMg.id);
    expect(hybridWirings).toHaveLength(1);
    expect(hybridWirings[0].agent_group_id).toBe(result.agent_group_id);
  });

  it('(4) Slack platform_id encoding: raw D... が slack:D... で INSERT/lookup される', () => {
    seedHybridAgent(baseArgs({ slackDmChannelId: 'DABC123' }), NOW);

    const mgs = getAllMessagingGroups();
    expect(mgs).toHaveLength(1);
    expect(mgs[0].platform_id).toBe('slack:DABC123');
    // raw ID そのままでは保存されない (fix `4892ee5` の教訓)
    expect(mgs[0].platform_id).not.toBe('DABC123');
  });

  it('(5) --skip-slack-dm: messaging_group を作らず、agent_group + container_config のみ', () => {
    const result = seedHybridAgent(
      baseArgs({ skipSlackDm: true, slackDmChannelId: undefined }),
      NOW,
    );

    expect(getAllAgentGroups()).toHaveLength(1);
    expect(getContainerConfig(result.agent_group_id)!.provider).toBeNull();
    expect(getAllMessagingGroups()).toHaveLength(0);
    expect(result.slack_dm_wired).toBe(false);
    expect(result.slack_dm_platform_id).toBeNull();
  });

  it('(6) container_config: provider=null (claude fallback) + model=Vertex publisher ID', () => {
    const result = seedHybridAgent(baseArgs(), NOW);

    const cc = getContainerConfig(result.agent_group_id);
    expect(cc).toBeDefined();
    // provider=null = resolveProviderName の "claude" fallback 経路。
    expect(cc!.provider).toBeNull();
    // model は明示 Vertex publisher ID 必須 (M1 で 404 を実際に踏んだため)。
    // null にすると agent-runner container が --model 未指定で claude-code SDK 内蔵
    // デフォルトが Anthropic API alias を返して Vertex rawPredict が 404 化する。
    expect(cc!.model).toBe('claude-sonnet-4-6');
  });

  it('(7) fan-out 二重発火 fail-fast: Slack DM 既存 mg が他 agent に wire 済なら process.exit(1)', () => {
    // 既存 ADK 用に slack:D0B6JA2M5GA を wire (= 本番 mg-i5lnbv 状態を再現)
    createAgentGroup({
      id: 'ag-adk-existing',
      name: '司書 (ADK)',
      folder: 'adk-biblio-shisho',
      agent_provider: null,
      created_at: NOW,
    });
    createMessagingGroup({
      id: 'mg-slack-existing',
      channel_type: 'slack',
      platform_id: 'slack:D0B6JA2M5GA',
      name: 'ADK DM',
      is_group: 1,
      unknown_sender_policy: 'public',
      denied_at: null,
      created_at: NOW,
    });
    createMessagingGroupAgent({
      id: 'mga-slack-adk',
      messaging_group_id: 'mg-slack-existing',
      agent_group_id: 'ag-adk-existing',
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: NOW,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit called with ${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => seedHybridAgent(baseArgs(), NOW)).toThrow('process.exit called with 1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errCalls = errSpy.mock.calls.flat().join('\n');
    expect(errCalls).toContain('already wired to 1 other agent group');
    expect(errCalls).toContain('ag-adk-existing');

    // 既存 ADK wire は無傷 (fail-fast なので hybrid の wire は作られていない)
    const wirings = getMessagingGroupAgents('mg-slack-existing');
    expect(wirings).toHaveLength(1);
    expect(wirings[0].agent_group_id).toBe('ag-adk-existing');
  });

  it('(8) I5 assert: skipSlackDm=false + slackDmChannelId 欠落なら fail-fast throw', () => {
    // parseArgs は CLI 境界で防ぐが、seedHybridAgent 直接呼出経路 (= 本 test) で
    // silent skip されると「wire するつもりが黙って skip」= silent failure。
    // 冒頭 assert が throw で撲滅することを保護する。
    expect(() =>
      seedHybridAgent(
        baseArgs({ skipSlackDm: false, slackDmChannelId: undefined }),
        NOW,
      ),
    ).toThrow('slackDmChannelId is required unless skipSlackDm=true');

    // throw 経路なので DB には何も書かれていない (agent_group / mg 全て 0 件)。
    expect(getAllAgentGroups()).toHaveLength(0);
    expect(getAllMessagingGroups()).toHaveLength(0);
  });

  it('(9) C3 guard: 既存 owner user の display_name は upsertUser で上書きされない', () => {
    // 既存 owner (init-first-agent.ts 経路で先に登録済) を fixture 注入。
    // display_name は DEN さん本名相当 (Patron default とは異なる値)。
    upsertUser({
      id: 'slack:U7F8TRM6X',
      kind: 'slack',
      display_name: 'DEN (real name)',
      created_at: NOW,
    });
    expect(getUser('slack:U7F8TRM6X')!.display_name).toBe('DEN (real name)');

    // hybrid seed 実行 (args.displayName は parseArgs 経路 default 'Patron')。
    seedHybridAgent(baseArgs(), NOW);

    // getUser guard により既存 user 行は touch されず、display_name は保たれる。
    // (guard を外すと upsertUser の COALESCE で 'Patron' に silent 上書きされる)
    expect(getUser('slack:U7F8TRM6X')!.display_name).toBe('DEN (real name)');
  });
});
