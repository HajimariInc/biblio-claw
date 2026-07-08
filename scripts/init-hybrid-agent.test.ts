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

import { parseArgs, seedHybridAgent, type Args } from './init-hybrid-agent.js';

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

  it('(7.5-M4F) GATE_ENABLED=true 時、既存 ADK wire に対して hybrid wire を並置 (fan-out fail-fast を skip)', () => {
    // 既存 ADK 用に slack:D0B6JA2M5GA を wire (case 7 の setup と同じ)
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

    // GATE_ENABLED=true で seedHybridAgent 実行 → fail-fast せず、hybrid wire を追加する
    const originalGateEnv = process.env.GATE_ENABLED;
    process.env.GATE_ENABLED = 'true';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      seedHybridAgent(baseArgs(), NOW);
    } finally {
      if (originalGateEnv === undefined) delete process.env.GATE_ENABLED;
      else process.env.GATE_ENABLED = originalGateEnv;
    }

    // 両 wire 成立 = ADK + hybrid の 2 rows on mg-slack-existing
    const wirings = getMessagingGroupAgents('mg-slack-existing');
    expect(wirings).toHaveLength(2);
    const providers = wirings.map((w) => w.agent_group_id).sort();
    expect(providers).toContain('ag-adk-existing');
    // hybrid の agent_group_id は generateId('ag') で生成される、prefix で確認
    expect(providers.some((id) => id.startsWith('ag-'))).toBe(true);

    // console.log に 'allowFanout' 系メッセージが emit されている
    const logCalls = logSpy.mock.calls.flat().join('\n');
    expect(logCalls).toContain('allowFanout=true');
    expect(logCalls).toContain('gate');
  });

  it('(7.5-M4F 冪等) GATE_ENABLED=true 時、2 回目の seedHybridAgent は既存 hybrid wire を検出して重複 wire を作らない', () => {
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

    const originalGateEnv = process.env.GATE_ENABLED;
    process.env.GATE_ENABLED = 'true';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      seedHybridAgent(baseArgs(), NOW);
      // 2 回目実行 = 冪等 (既存 mga.id で detect して重複作成しない)
      seedHybridAgent(baseArgs(), NOW);
    } finally {
      if (originalGateEnv === undefined) delete process.env.GATE_ENABLED;
      else process.env.GATE_ENABLED = originalGateEnv;
    }
    // wirings は 2 のまま (ADK + hybrid = 2 rows、追加 wire なし)
    const wirings = getMessagingGroupAgents('mg-slack-existing');
    expect(wirings).toHaveLength(2);
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

/**
 * parseArgs() の CLI 境界 unit test (S1)。
 *
 * GKE wrapper (`init-hybrid-agent-gke.sh`) は env → 明示 `--flag` に変換して
 * 渡すため env fallback 経路は実運用では通らないが、直接 `HYBRID_USER_ID=...
 * tsx scripts/init-hybrid-agent.ts` で叩くデバッグ用途と、必須引数欠落時の
 * fail-fast (exit 2) の regression 保護のため、CLI 境界のみを assert する。
 */
describe('init-hybrid-agent: parseArgs()', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // 各 case で env を isolate (HYBRID_* を全消し、必要な case で個別 set)
    delete process.env.HYBRID_USER_ID;
    delete process.env.HYBRID_SLACK_DM_CHANNEL_ID;
    delete process.env.HYBRID_SKIP_SLACK_DM;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('(P1) 必須引数揃い: --user-id + --slack-dm-channel-id で正常 parse', () => {
    const args = parseArgs([
      '--user-id',
      'slack:U7F8TRM6X',
      '--slack-dm-channel-id',
      'D0B6JA2M5GA',
    ]);
    expect(args.userId).toBe('slack:U7F8TRM6X');
    expect(args.slackDmChannelId).toBe('D0B6JA2M5GA');
    expect(args.displayName).toBe('Patron'); // default
    expect(args.agentName).toBe('司書 (hybrid)'); // default
    expect(args.skipSlackDm).toBe(false);
  });

  it('(P2) --user-id 欠落: process.exit(2) で fail-fast', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit called with ${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => parseArgs(['--slack-dm-channel-id', 'D0B6JA2M5GA'])).toThrow(
      'process.exit called with 2',
    );
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errSpy.mock.calls.flat().join('\n')).toContain('Missing required arg: --user-id');
  });

  it('(P3) --slack-dm-channel-id 欠落 (skipSlackDm=false): process.exit(2) で fail-fast', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit called with ${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => parseArgs(['--user-id', 'slack:U7F8TRM6X'])).toThrow(
      'process.exit called with 2',
    );
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errSpy.mock.calls.flat().join('\n')).toContain(
      'Missing required arg: --slack-dm-channel-id',
    );
  });

  it('(P4) --skip-slack-dm 指定時は slack-dm-channel-id 欠落でも正常 parse', () => {
    const args = parseArgs(['--user-id', 'slack:U7F8TRM6X', '--skip-slack-dm']);
    expect(args.userId).toBe('slack:U7F8TRM6X');
    expect(args.slackDmChannelId).toBeUndefined();
    expect(args.skipSlackDm).toBe(true);
  });

  it('(P5) env fallback: --user-id 未指定でも HYBRID_USER_ID env で拾える', () => {
    process.env.HYBRID_USER_ID = 'slack:UENVFALLBACK';
    process.env.HYBRID_SLACK_DM_CHANNEL_ID = 'DENV456';
    const args = parseArgs([]);
    expect(args.userId).toBe('slack:UENVFALLBACK');
    expect(args.slackDmChannelId).toBe('DENV456');
  });

  it('(P6) env fallback: HYBRID_SKIP_SLACK_DM=1 で --skip-slack-dm 未指定でも skip', () => {
    process.env.HYBRID_USER_ID = 'slack:UENVFALLBACK';
    process.env.HYBRID_SKIP_SLACK_DM = '1';
    const args = parseArgs([]);
    expect(args.skipSlackDm).toBe(true);
    expect(args.slackDmChannelId).toBeUndefined();
  });

  it('(P7) --display-name / --agent-name の trim + default 降格', () => {
    const args = parseArgs([
      '--user-id',
      'slack:U7F8TRM6X',
      '--slack-dm-channel-id',
      'D0B6JA2M5GA',
      '--display-name',
      '  Alice  ', // trim
      '--agent-name',
      '', // 空文字 → default 'HYBRID_DEFAULT_NAME'
    ]);
    expect(args.displayName).toBe('Alice');
    expect(args.agentName).toBe('司書 (hybrid)'); // default fallback
  });

  it('(P8) CLI 明示 flag が env fallback より優先される', () => {
    process.env.HYBRID_USER_ID = 'slack:UFROMENV';
    const args = parseArgs([
      '--user-id',
      'slack:UFROMCLI',
      '--slack-dm-channel-id',
      'D0B6JA2M5GA',
    ]);
    expect(args.userId).toBe('slack:UFROMCLI'); // CLI が勝つ
  });
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

  // --- M4-F Phase 3: seedMcpServers (Task 2/3) --------------------------------
  it('(P3-1) seedMcpServers: 空 DB から seed で tavily + drive の 2 key を assert', () => {
    // drive instructions は init 実行時の process.env.GCP_PROJECT_ID を interpolation する
    // (public 化に伴う env-driven 化)。test 中は deterministic な値を注入して assertion を安定させる。
    const savedProjectId = process.env.GCP_PROJECT_ID;
    process.env.GCP_PROJECT_ID = 'test-project-id';
    try {
      const result = seedHybridAgent(baseArgs(), NOW);
      const cc = getContainerConfig(result.agent_group_id);
      expect(cc).toBeDefined();

      const servers = JSON.parse(cc!.mcp_servers) as Record<string, unknown>;
      expect(Object.keys(servers).sort()).toEqual(['drive', 'tavily']);

      const tavily = servers.tavily as {
        command: string;
        args: string[];
        env: Record<string, string>;
        instructions: string;
      };
      expect(tavily.command).toBe('tavily-mcp');
      expect(tavily.args).toEqual([]);
      // env は空 object (tavily-mcp keyless mode を利用、OneCLI Bearer 注入で認証)。
      // TAVILY_API_KEY を env に置くと body にも api_key: "placeholder" が入って 401 になる。
      expect(tavily.env).toEqual({});
      expect(tavily.instructions).toContain('tavily_search');
      expect(tavily.instructions).toContain('1,000');

      const drive = servers.drive as {
        command: string;
        args: string[];
        env: Record<string, string>;
        instructions: string;
      };
      expect(drive.command).toBe('node');
      expect(drive.args).toEqual(['/opt/mcp-servers/drive/index.mjs']);
      expect(drive.env).toEqual({});
      expect(drive.instructions).toContain('drive_list_files');
      expect(drive.instructions).toContain('drive_get_file');
      expect(drive.instructions).toContain(
        'biblio-orchestrator@test-project-id.iam.gserviceaccount.com',
      );
    } finally {
      if (savedProjectId === undefined) {
        delete process.env.GCP_PROJECT_ID;
      } else {
        process.env.GCP_PROJECT_ID = savedProjectId;
      }
    }
  });

  it('(P3-1b) seedMcpServers: GCP_PROJECT_ID 未設定なら drive instructions が sentinel placeholder に fallback', () => {
    // fallback 経路の正 case cover (init-hybrid-agent.ts:301 の nullish coalescing 分岐)。
    // 実運用の GKE 経路では k8s manifest env に GCP_PROJECT_ID が投入されているため
    // 通常このパスは通らないが、local dev / .env 未セット時の silent fallback が
    // (public 化後の) 審査員向け reproducible run で発火し得る = 挙動を明示的に固定する。
    const savedProjectId = process.env.GCP_PROJECT_ID;
    delete process.env.GCP_PROJECT_ID;
    try {
      const result = seedHybridAgent(baseArgs(), NOW);
      const cc = getContainerConfig(result.agent_group_id);
      const servers = JSON.parse(cc!.mcp_servers) as Record<string, unknown>;
      const drive = servers.drive as { instructions: string };
      expect(drive.instructions).toContain(
        'biblio-orchestrator@<gcp-project-id>.iam.gserviceaccount.com',
      );
    } finally {
      if (savedProjectId !== undefined) {
        process.env.GCP_PROJECT_ID = savedProjectId;
      }
    }
  });

  it('(P3-2) seedMcpServers: 2 回連続 seed で mcp_servers が同一 (idempotent)', () => {
    const r1 = seedHybridAgent(baseArgs(), NOW);
    const before = getContainerConfig(r1.agent_group_id)!.mcp_servers;

    const r2 = seedHybridAgent(baseArgs(), NOW);
    const after = getContainerConfig(r2.agent_group_id)!.mcp_servers;

    expect(r1.agent_group_id).toBe(r2.agent_group_id);
    // JSON literal そのものが完全一致 = updateContainerConfigJson の overwrite で
    // 同 desired state を書き直しても中身が動かないことを保証。
    expect(after).toBe(before);
  });

  it('(P3-3) seedMcpServers: env に実 Tavily key 形式 (tvly-...) が混入していない', () => {
    // 命題 2 の runtime 保護 (動的 assert) = process.env に実 key を仕込んだ状態で
    // seedHybridAgent を実行し、結果の DB JSON に実 key パターンが混入していないかを
    // 実行時に確認する (実装で誤って `TAVILY_API_KEY: process.env.TAVILY_API_KEY` に
    // 書き換えると本 test は落ちる)。「静的 grep」= ソースファイルの text grep とは
    // 別種の検証手段 (repo 内の他所 = verify-*.sh の静的 grep とは意味が違う)。
    // keyless mode 化 (M4-F Phase 3 の fixup) で env は空 object になったため、
    // TAVILY_API_KEY key 自体も DB JSON に含まれない (以前は "placeholder" が入っていた)。
    process.env.TAVILY_API_KEY = 'tvly-realsecret1234567890abcdef';
    try {
      const result = seedHybridAgent(baseArgs(), NOW);
      const cc = getContainerConfig(result.agent_group_id)!;
      // 実 key 形式 (`tvly-` 16 文字以上) が JSON 内に一切現れない
      expect(cc.mcp_servers).not.toMatch(/tvly-[A-Za-z0-9]{16,}/);
      // TAVILY_API_KEY 自体 (key 名) が env の直接下に無い (keyless mode 化)
      expect(cc.mcp_servers).not.toContain('"TAVILY_API_KEY"');
      // tavily.env は空 object のまま
      expect(cc.mcp_servers).toContain('"tavily":{"command":"tavily-mcp","args":[],"env":{}');
    } finally {
      delete process.env.TAVILY_API_KEY;
    }
  });
});
