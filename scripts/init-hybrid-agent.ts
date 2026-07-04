/**
 * Initialize the hybrid (agent-container-backed) biblio librarian agent
 * (M4-F Phase 1: revival-core).
 *
 * `container_configs.provider = null` (= claude fallback via
 * `resolveProviderName`) を持つ agent group を central DB に作成し、
 * **DEN さん Slack DM に限定して wire** する。これにより M4-B Phase 4 完了以降
 * DB 行不在で休眠していた agent-container 経路 (spawn / M3 装備機構 /
 * container skill / container 側 MCP 9 tool) が K8s Job spawn 経路で再稼働する。
 *
 * `scripts/init-adk-agent.ts` (M4-B Phase 3) + `scripts/init-first-agent.ts`
 * (M1 継承の DM 配線) の合成写経で、以下 3 差分を入れる:
 *   - folder: `hybrid-biblio-shisho` (ADK 用 `adk-biblio-shisho` と物理分離)
 *   - `container_configs.provider`: `null` を毎回 assert
 *     (= isNewGroup gate 外 = self-healing、fallback で 'claude' が効く)
 *   - CLI wire なし + Slack DM wire (必須) — CLI/Slack channel 経路の
 *     ADK wire は不変。fan-out 二重発火防止のため、Slack DM の既存 mg が
 *     他 agent group に wire 済なら **fail-fast + 手動対応 prompt**。
 *
 * Slack channel (bot mention) wire は本 script では扱わない
 * (= ADK 経路が ハッカソン demo channel を占有継続)。
 *
 * Usage:
 *   pnpm exec tsx scripts/init-hybrid-agent.ts \
 *     --user-id slack:U7F8TRM6X \
 *     --slack-dm-channel-id D0B6JA2M5GA \
 *     [--display-name "Patron"] \
 *     [--agent-name "司書 (hybrid)"] \
 *     [--skip-slack-dm]   # test / dry-run 用 (Slack DM wire を skip)
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { updateContainerConfigScalars } from '../src/db/container-configs.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { addMember } from '../src/modules/permissions/db/agent-group-members.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { initGroupFilesystem } from '../src/group-init.js';
import type { AgentGroup, MessagingGroup } from '../src/types.js';

const SLACK_CHANNEL = 'slack';
const HYBRID_AGENT_FOLDER = 'hybrid-biblio-shisho';
const HYBRID_DEFAULT_NAME = '司書 (hybrid)';
const HYBRID_DEFAULT_DISPLAY = 'Patron';

export interface Args {
  userId: string;
  slackDmChannelId?: string;
  displayName: string;
  agentName: string;
  skipSlackDm: boolean;
}

function parseArgs(argv: string[]): Args {
  let userId: string | undefined;
  let slackDmChannelId: string | undefined;
  let displayName: string | undefined;
  let agentName: string | undefined;
  let skipSlackDm = false;

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    switch (key) {
      case '--user-id':
        userId = val;
        i++;
        break;
      case '--slack-dm-channel-id':
        slackDmChannelId = val;
        i++;
        break;
      case '--display-name':
        displayName = val;
        i++;
        break;
      case '--agent-name':
        agentName = val;
        i++;
        break;
      case '--skip-slack-dm':
        skipSlackDm = true;
        break;
    }
  }

  // env fallback は test / GKE wrapper からの override 経路を有効化
  userId = userId ?? process.env.HYBRID_USER_ID;
  slackDmChannelId = slackDmChannelId ?? process.env.HYBRID_SLACK_DM_CHANNEL_ID;
  if (!skipSlackDm && (process.env.HYBRID_SKIP_SLACK_DM === '1' || process.env.HYBRID_SKIP_SLACK_DM === 'true')) {
    skipSlackDm = true;
  }

  if (!userId) {
    console.error('Missing required arg: --user-id (or HYBRID_USER_ID env)');
    console.error('See scripts/init-hybrid-agent.ts header for usage.');
    process.exit(2);
  }
  if (!skipSlackDm && !slackDmChannelId) {
    console.error(
      'Missing required arg: --slack-dm-channel-id (raw D... ID, e.g. D0B6JA2M5GA)',
    );
    console.error('  Pass --skip-slack-dm to seed the agent group without a Slack DM wire (test / dry-run).');
    process.exit(2);
  }

  return {
    userId,
    slackDmChannelId,
    displayName: (displayName ?? '').trim() || HYBRID_DEFAULT_DISPLAY,
    agentName: (agentName ?? '').trim() || HYBRID_DEFAULT_NAME,
    skipSlackDm,
  };
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Slack DM messaging group を idempotent に upsert し、hybrid agent group に wire する。
 *
 * **fan-out 二重発火防止 (init-adk-agent.ts:wireCliChannel パターンを Slack DM へ転写)**:
 * router.ts:routeInbound は 1 メッセージにつき、その messaging_group に紐づく全 agent
 * (fan-out 全件) を engage 対象にする。DEN さん Slack DM の `slack:D...` mg が既に
 * 他 agent_group (典型例: ADK) に wire されていると、hybrid をここで追加 wire すると
 * **1 DM = 2 agent への fan-out 発火** = 応答二重 + Vertex API rate limit 消費倍増。
 *
 * したがって、既存 mg に他 agent への wire が検出されたら **fail-fast + 手動対応 prompt**
 * を出す。DEN さんが「既存 wire を先に外す」か「別 platform_id で分離する」か判断する。
 *
 * plan §Solution Approach (1) の「fan-out 二重発火なしを Task 1 で構造的に保証」を
 * 満たす構造的 assert。init-adk-agent.ts:98-156 の CLI 経路と対称。
 */
function wireSlackDm(
  ag: AgentGroup,
  dmChannelIdRaw: string,
  displayName: string,
  now: string,
): void {
  // Chat SDK bridge の channelIdFromThreadId() は `slack:<channel>` を返すので、
  // messaging_groups.platform_id もこの encoded 形式で保存する (fix `4892ee5` の教訓、
  // raw のまま渡すと router.ts の lookup key と mismatch して silent drop)。
  const encodedPlatformId = `${SLACK_CHANNEL}:${dmChannelIdRaw}`;

  let dmMg: MessagingGroup | undefined = getMessagingGroupByPlatform(SLACK_CHANNEL, encodedPlatformId);
  if (!dmMg) {
    dmMg = {
      id: generateId('mg'),
      channel_type: SLACK_CHANNEL,
      platform_id: encodedPlatformId,
      name: `DM with ${displayName}`,
      is_group: 0, // DM
      unknown_sender_policy: 'strict',
      denied_at: null,
      created_at: now,
    };
    createMessagingGroup(dmMg);
    console.log(`Created Slack DM messaging group: ${dmMg.id} (${encodedPlatformId})`);
  } else {
    console.log(`Reusing Slack DM messaging group: ${dmMg.id} (${encodedPlatformId})`);
    // fan-out 二重発火の観点で既存 wire を検査 (fail-fast)。
    const existingWirings = getMessagingGroupAgents(dmMg.id);
    const otherWirings = existingWirings.filter((w) => w.agent_group_id !== ag.id);
    if (otherWirings.length > 0) {
      console.error('');
      console.error(
        `ERROR: Slack DM ${encodedPlatformId} is already wired to ${otherWirings.length} other agent group(s):`,
      );
      for (const w of otherWirings) {
        console.error(
          `  - agent_group_id=${w.agent_group_id} (mga.id=${w.id}, engage_mode=${w.engage_mode})`,
        );
      }
      console.error('');
      console.error(
        'router.ts:routeInbound is fan-out (all wired agents engage), so a single DEN Slack DM',
      );
      console.error('would double-invoke both the existing agent(s) and the hybrid agent group.');
      console.error('');
      console.error('Resolve either by:');
      console.error(
        '  (a) Removing existing wire(s) with `ncl wirings remove --id <mga.id>` before re-running',
      );
      console.error(
        '      (recommended if you intend to migrate the DEN DM to hybrid = agent-container path)',
      );
      console.error(
        '  (b) Retiring the existing wire manually via SQL (advanced) after backing up the DB',
      );
      console.error('');
      console.error(
        'Phase 2 (gate + routing) will lift this constraint by routing on classifier output.',
      );
      console.error('');
      process.exit(1);
    }
  }

  const existing = getMessagingGroupAgentByPair(dmMg.id, ag.id);
  if (existing) {
    console.log(`Slack DM wire exists: ${existing.id}`);
    return;
  }
  // DM 経路: engage_mode='pattern' + engage_pattern='.' = 常時応答 (mention 不要)。
  // init-first-agent.ts:159-160 の DM デフォルトと同流儀。
  createMessagingGroupAgent({
    id: generateId('mga'),
    messaging_group_id: dmMg.id,
    agent_group_id: ag.id,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });
  console.log(`Wired Slack DM: ${dmMg.id} -> ${ag.id}`);
}

export interface SeedResult {
  agent_group_id: string;
  folder: string;
  is_new_group: boolean;
  provider: null;
  model: null;
  slack_dm_wired: boolean;
  slack_dm_platform_id: string | null;
}

/**
 * DB seed 本体 (test から直接呼べる純粋関数)。DB は呼び出し側で
 * `initDb + runMigrations` (or test の `initTestDb + runMigrations`) 済の前提。
 *
 * main() は「argv 解析 + DB 初期化 + seedHybridAgent(args) + summary print」
 * の順に呼ぶ。fs 書込み (`initGroupFilesystem`) の副作用があるため、test 側は
 * `GROUPS_DIR` env を tmp dir に振り替えてから import すること。
 */
export function seedHybridAgent(args: Args, now: string): SeedResult {
  // 1. Owner user assert (既存 owner 前提、`INSERT OR IGNORE` 相当)。
  //    init-first-agent.ts で先に owner 登録済の想定 = display_name は上書きしない
  //    (upsertUser の COALESCE 挙動でも維持される)。
  upsertUser({
    id: args.userId,
    kind: SLACK_CHANNEL,
    display_name: args.displayName,
    created_at: now,
  });

  // 2. Agent group + filesystem (idempotent by folder)。
  let ag: AgentGroup | undefined = getAgentGroupByFolder(HYBRID_AGENT_FOLDER);
  const isNewGroup = !ag;
  if (!ag) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: args.agentName,
      folder: HYBRID_AGENT_FOLDER,
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(HYBRID_AGENT_FOLDER)!;
    console.log(`Created hybrid agent group: ${ag.id} (${HYBRID_AGENT_FOLDER})`);
  } else {
    console.log(`Reusing hybrid agent group: ${ag.id} (${HYBRID_AGENT_FOLDER})`);
  }

  // initGroupFilesystem が `ensureContainerConfig` を内部で呼ぶため、
  // updateContainerConfigScalars の前に必ず通す (行不在なら UPDATE が silent no-op)。
  initGroupFilesystem(ag, {
    instructions:
      `# ${args.agentName}\n\n` +
      'M4-F Phase 1 revival-core 用の hybrid provider agent。' +
      '`container_configs.provider = null` → resolveProviderName の "claude" fallback で ' +
      'agent-runner container 経路 (NanoClaw v2 の原点) が起動する。\n\n' +
      'あなたは司書 (hybrid) として、装備 skill / container skill (welcome / onecli-gateway / ' +
      'self-customize / agent-browser / slack-formatting 等) / Bash / File tool を活用して ' +
      'patron の生活 + 対話 + 実行力仕事を担う。biblio 特化操作 (仕入れ / 検品 / カテゴライズ / ' +
      '陳列 / 蔵書一覧 / 装備) は M4-G で ADK 側へ吸収される予定のため、Phase 1 では ' +
      'container 側 MCP 9 tool は残置されているが積極利用しない (= ADK 経路が担当継続)。\n\n' +
      '自己拡張は `/self-customize` skill で本 CLAUDE.local.md を追記する。\n',
  });

  // provider=null が本 script の中核設定。router.ts:deliverToAgent で
  // provider === 'adk' 分岐が偽になり、既存 agent-container 経路 (spawn / K8s Job) に
  // 素通りする。resolveProviderName (`src/container-runner.ts:275-297`) の
  // `|| 'claude'` fallback が実際の provider 名を返す。
  //
  // model=null は agent-runner container が読む container.json で undefined になり、
  // container 側の DEFAULT_MODEL (= agent-runner が持つデフォルト) にフォールバック。
  // Phase 1 では model 固定を避けて container 側の判断に委ねる。
  //
  // **isNewGroup gate から外して毎回 assert** (I2 = PR #101 review 指摘、
  // init-adk-agent.ts:256-266 の pattern を継承):
  // initGroupFilesystem 途中の fs 書込み failure 等で agent_group 行だけ残り
  // updateContainerConfigScalars が飛ばされた場合、次回実行時に isNewGroup=false と
  // 判定されて provider 設定が永久に反映されない (silent 破綻)。毎回 assert する
  // 方が真の意味での冪等・自己修復に近い。
  updateContainerConfigScalars(ag.id, {
    provider: null,
    model: null,
  });
  console.log(`Ensured container_config: provider=null (claude fallback), model=null`);

  // 3. Membership row (owner is implicit via user_roles、これは access ゲート用)。
  //    init-first-agent.ts:270-275 と同流儀の `INSERT OR IGNORE`。
  addMember({
    user_id: args.userId,
    agent_group_id: ag.id,
    added_by: null,
    added_at: now,
  });

  // 4. Slack DM wire — CLI wire は意図的に**しない** (`cli/local` の既存 ADK wire に
  //    hybrid を追加すると `pnpm run chat "..."` が fan-out 二重発火する)。
  //    Phase 2 の gate + routing で解消される前提。
  if (!args.skipSlackDm && args.slackDmChannelId) {
    wireSlackDm(ag, args.slackDmChannelId, args.displayName, now);
  } else {
    console.log('(Slack DM wire skipped — pass --slack-dm-channel-id to enable)');
  }

  // 5. 最終 state を SeedResult として返す。
  //    isNewGroup を含めることで、seed が create 経路 / reuse 経路のどちらを通ったか
  //    後段の観察 script (Task 7 K8s Job 観察) が判別できる。
  return {
    agent_group_id: ag.id,
    folder: HYBRID_AGENT_FOLDER,
    is_new_group: isNewGroup,
    provider: null,
    model: null,
    slack_dm_wired: !args.skipSlackDm && !!args.slackDmChannelId,
    slack_dm_platform_id:
      args.slackDmChannelId ? `${SLACK_CHANNEL}:${args.slackDmChannelId}` : null,
  };
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);



  const now = new Date().toISOString();
  const summary = seedHybridAgent(args, now);

  console.log('');
  console.log('Init complete.');
  console.log(`  agent:    [${summary.agent_group_id}] @ groups/${HYBRID_AGENT_FOLDER}`);
  console.log(`  provider: null (routes via container-runner spawn, K8s Job on GKE)`);
  console.log(
    `  channel:  ${summary.slack_dm_wired ? `slack DM (${summary.slack_dm_platform_id})` : '(none)'}`,
  );
  console.log('');
  console.log('SEED_RESULT=' + JSON.stringify(summary));
}

// script として直接起動時のみ main() を実行 (unit test では import のみ)。
// scripts/init-adk-agent.ts と同様の bottom-of-file 起動パターン。
const invokedDirectly = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const normalized = argv1.replace(/\\/g, '/');
  return normalized.endsWith('/scripts/init-hybrid-agent.ts')
    || normalized.endsWith('/scripts/init-hybrid-agent.js');
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
