/**
 * Initialize the ADK-powered biblio librarian agent (M4-B Phase 3).
 *
 * `container_configs.provider = 'adk'` を持つ agent group を central DB に作成し、
 * CLI channel (`cli/local`) に自動 wire する。router.ts の provider 分岐が
 * `provider === 'adk'` を検知して orchestrator 内 in-process ADK Runner
 * (`src/adk/dispatcher.ts`) に patron 命令を流す構成になる。
 *
 * Slack channel wire は環境変数 `SLACK_WIRE_CHANNEL_ID` 指定時のみ optional で
 * 実行される (= プレゼン素材録画等の DEN さん任意作業向け、Phase 3 verify 判定には
 * 含めない設計)。
 *
 * `scripts/init-cli-agent.ts` の pattern を写経し、以下だけを差し替え:
 *   - folder: `adk-biblio-shisho` (既存 CLI agent と衝突しない slug)
 *   - agent name: `司書 (ADK)`
 *   - container_config: `provider='adk'` を追加 (`model` は Phase 3 では偶然 CLI と
 *     同値 `claude-sonnet-4-6` = LlmAgent.model hardcode 側が実際の解決者)
 *   - CLI wire は必須 (verify + DEN さん手動確認用)
 *   - Slack wire は SLACK_WIRE_CHANNEL_ID 指定時のみ
 *
 * Usage:
 *   pnpm exec tsx scripts/init-adk-agent.ts \
 *     [--display-name "Gavriel"] \
 *     [--agent-name "司書 (ADK)"]
 *
 *   # Slack channel も併せて wire する (プレゼン用):
 *   SLACK_WIRE_CHANNEL_ID='C0XXXXXX' pnpm exec tsx scripts/init-adk-agent.ts
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
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { initGroupFilesystem } from '../src/group-init.js';
import type { AgentGroup, MessagingGroup } from '../src/types.js';

const CLI_CHANNEL = 'cli';
const CLI_PLATFORM_ID = 'local';
const CLI_SYNTHETIC_USER_ID = `${CLI_CHANNEL}:${CLI_PLATFORM_ID}`;
const ADK_AGENT_FOLDER = 'adk-biblio-shisho';
const ADK_DEFAULT_NAME = '司書 (ADK)';

interface Args {
  displayName: string;
  agentName: string;
}

function parseArgs(argv: string[]): Args {
  let displayName: string | undefined;
  let agentName: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--display-name') {
      displayName = val;
      i++;
    } else if (key === '--agent-name') {
      agentName = val;
      i++;
    }
  }

  return {
    displayName: displayName?.trim() || 'Patron',
    agentName: agentName?.trim() || ADK_DEFAULT_NAME,
  };
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** CLI messaging group を idempotent に upsert し、ADK agent group に wire する。 */
function wireCliChannel(ag: AgentGroup, now: string): void {
  let cliMg: MessagingGroup | undefined = getMessagingGroupByPlatform(CLI_CHANNEL, CLI_PLATFORM_ID);
  if (!cliMg) {
    cliMg = {
      id: generateId('mg'),
      channel_type: CLI_CHANNEL,
      platform_id: CLI_PLATFORM_ID,
      name: 'Local CLI',
      is_group: 0,
      unknown_sender_policy: 'public',
      denied_at: null,
      created_at: now,
    };
    createMessagingGroup(cliMg);
    console.log(`Created CLI messaging group: ${cliMg.id}`);
  } else {
    console.log(`Reusing CLI messaging group: ${cliMg.id}`);
  }

  const existing = getMessagingGroupAgentByPair(cliMg.id, ag.id);
  if (existing) {
    console.log(`CLI wiring already exists: ${existing.id}`);
    return;
  }
  createMessagingGroupAgent({
    id: generateId('mga'),
    messaging_group_id: cliMg.id,
    agent_group_id: ag.id,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });
  console.log(`Wired CLI: ${cliMg.id} -> ${ag.id}`);
}

/** Slack channel wire (env `SLACK_WIRE_CHANNEL_ID` 指定時のみ実行される optional path)。 */
function wireSlackChannel(ag: AgentGroup, channelId: string, now: string): void {
  const SLACK_CHANNEL = 'slack';
  let slackMg: MessagingGroup | undefined = getMessagingGroupByPlatform(SLACK_CHANNEL, channelId);
  if (!slackMg) {
    slackMg = {
      id: generateId('mg'),
      channel_type: SLACK_CHANNEL,
      platform_id: channelId,
      name: `ADK demo (${channelId})`,
      is_group: 1,
      unknown_sender_policy: 'public',
      denied_at: null,
      created_at: now,
    };
    createMessagingGroup(slackMg);
    console.log(`Created Slack messaging group: ${slackMg.id} (${channelId})`);
  } else {
    console.log(`Reusing Slack messaging group: ${slackMg.id} (${channelId})`);
  }

  const existing = getMessagingGroupAgentByPair(slackMg.id, ag.id);
  if (existing) {
    console.log(`Slack wiring already exists: ${existing.id}`);
    return;
  }
  createMessagingGroupAgent({
    id: generateId('mga'),
    messaging_group_id: slackMg.id,
    agent_group_id: ag.id,
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });
  console.log(`Wired Slack: ${slackMg.id} -> ${ag.id}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const now = new Date().toISOString();

  // 1. Synthetic CLI user (idempotent) — router.ts の sender resolver が upsert 済 user
  // を参照する。ADK 経路でも channel adapter 経由の inbound では userId が要る。
  upsertUser({
    id: CLI_SYNTHETIC_USER_ID,
    kind: CLI_CHANNEL,
    display_name: args.displayName,
    created_at: now,
  });

  // 2. Agent group + filesystem (idempotent by folder).
  let ag: AgentGroup | undefined = getAgentGroupByFolder(ADK_AGENT_FOLDER);
  const isNewGroup = !ag;
  if (!ag) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: args.agentName,
      folder: ADK_AGENT_FOLDER,
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(ADK_AGENT_FOLDER)!;
    console.log(`Created ADK agent group: ${ag.id} (${ADK_AGENT_FOLDER})`);
  } else {
    console.log(`Reusing ADK agent group: ${ag.id} (${ADK_AGENT_FOLDER})`);
  }

  // initGroupFilesystem が `ensureContainerConfig` を内部で呼ぶため、
  // `updateContainerConfigScalars` の前に必ず通す (= 行不在なら UPDATE が silent no-op)。
  // ADK 経路は agent-runner container を起こさないので groups/<folder>/CLAUDE.md は
  // 未使用だが、container_configs 行の ensure 経路として温存する。
  initGroupFilesystem(ag, {
    instructions:
      `# ${args.agentName}\n\n` +
      'ADK Runner (in-process) 経由で稼働する司書 agent。container 起動はなく、' +
      '本 CLAUDE.md は使用されない (= LLM の system prompt は src/adk/root-agent.ts:' +
      'ROOT_AGENT_INSTRUCTION が保持)。\n',
  });

  if (isNewGroup) {
    // provider='adk' が本 script の中核設定。router.ts:deliverToAgent がこの値を
    // 見て orchestrator 内 dispatcher に patron 命令を流す。
    // model は agent-runner 経路と偶然同値 (claude-sonnet-4-6) — ADK 経路では
    // LlmAgent.model の hardcode 側が実際の解決者、container_configs.model は本経路で
    // は参照されない。運用一貫性のため揃えておく。
    updateContainerConfigScalars(ag.id, {
      provider: 'adk',
      model: 'claude-sonnet-4-6',
    });
    console.log(`Set container_config: provider='adk', model='claude-sonnet-4-6'`);
  }

  // 3. CLI channel wire (必須 — verify + DEN さん手動テスト用)。
  wireCliChannel(ag, now);

  // 4. Slack channel wire (optional — env `SLACK_WIRE_CHANNEL_ID` 指定時のみ、
  // プレゼン用手動デモ経路)。
  const slackChannelId = process.env.SLACK_WIRE_CHANNEL_ID;
  if (slackChannelId) {
    wireSlackChannel(ag, slackChannelId, now);
  } else {
    console.log('(Slack wire skipped — set SLACK_WIRE_CHANNEL_ID env to wire a Slack channel)');
  }

  console.log('');
  console.log('Init complete.');
  console.log(`  agent:    ${ag.name} [${ag.id}] @ groups/${ADK_AGENT_FOLDER}`);
  console.log(`  provider: adk (routes via src/adk/dispatcher.ts, no container spawn)`);
  console.log(`  channel:  cli/${CLI_PLATFORM_ID}${slackChannelId ? ` + slack/${slackChannelId}` : ''}`);
  console.log('');
  console.log('Run `pnpm run chat "@bot 仕入れて owner/repo"` to test.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
