/**
 * Initialize the Fugue-ask (agent-container-backed) biblio librarian agent
 * (M4-H Phase 3: life-capabilities-wiring).
 *
 * `container_configs.provider = null` (= claude fallback via
 * `resolveProviderName`) を持つ **Fugue ask 専用 agent group** を central DB に
 * 作成し、`channel_type='fugue'` の synthetic messaging_group に wire する。
 * これにより `handleAsk` が `resolveSession(fugueAskAgentGroupId,
 * fugueMessagingGroupId, request_id, 'per-thread')` で 1 request = 1 session を
 * 都度作成し、`wakeContainer` で K8s Job / Docker で agent-container を起動して
 * Tavily / Drive R4 backend を activate できる。
 *
 * `scripts/init-hybrid-agent.ts` (M4-F Phase 1) の写経を base にし、Fugue 特有の
 * 差分だけ入れる:
 *   - folder: `fugue-ask-biblio-shisho` (hybrid / ADK と物理分離)
 *   - `container_configs.provider = null` を毎回 assert (self-healing)
 *   - MCP: Tavily + Drive を hybrid と完全同一 seed (seedMcpServers 転写)
 *   - **CLI wire なし + Slack DM wire なし** (fan-out 完全排除、Fugue 経由のみで
 *     稼働)。channels/fugue channel type の synthetic messaging_group のみを wire
 *   - owner user なし + `addMember` 呼出なし (Fugue Cloud Run が唯一の client、
 *     人間の owner は存在しない = user_roles / agent_group_members に持たない)
 *
 * DEN さんの通常 Slack 会話・CLI 会話への fan-out 発火を **構造的に不可能**にする
 * (= Slack DM mg / CLI mg には触らないので、既存 hybrid / ADK の wire に何ら影響しない)。
 *
 * Usage:
 *   pnpm exec tsx scripts/init-fugue-ask-agent.ts \
 *     [--agent-name "司書 (Fugue ask)"]
 */
import path from 'path';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DATA_DIR } from '../src/config.js';
import type { McpServerConfig } from '../src/container-config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { updateContainerConfigJson, updateContainerConfigScalars } from '../src/db/container-configs.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { initGroupFilesystem } from '../src/group-init.js';
import type { AgentGroup, MessagingGroup } from '../src/types.js';

const FUGUE_CHANNEL = 'fugue';
const FUGUE_PLATFORM_ID = 'fugue-ask-mg';
const FUGUE_ASK_AGENT_FOLDER = 'fugue-ask-biblio-shisho';
const FUGUE_ASK_DEFAULT_NAME = '司書 (Fugue ask)';

/**
 * fugue-ask 専用 system prompt file (M4-H Phase 3.5)。
 *
 * 本 init script は host (local dev = project root cwd / GKE = orchestrator container の
 * `/app` cwd) 上で走るため、`process.cwd()` からの相対 path 解決で拾う。
 * 内容 (~300 行) を read 後、`container_configs.system_prompt_override` に投入し、
 * agent-runner 側 (`providers/claude.ts`) が SDK `systemPrompt: <string>` (custom) に
 * 直渡しする。この経路では `settingSources: []` (SDK isolation mode) が同時に有効化されるため
 * CLAUDE.md / CLAUDE.local.md auto-load は完全 disable = fugue-ask.md の指示だけが LLM に届く。
 *
 * GKE 経路の前提: orchestrator container image が本 file を含む必要
 * (`Dockerfile` の COPY 対象、Phase 5 で runbook に手順記録予定)。
 */
const FUGUE_ASK_SYSTEM_PROMPT_PATH = 'container/agent-runner/src/system-prompts/fugue-ask.md';

export interface Args {
  agentName: string;
}

export function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--agent-name') {
      out.agentName = val;
      i++;
    }
  }
  return {
    agentName: (out.agentName ?? '').trim() || FUGUE_ASK_DEFAULT_NAME,
  };
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Fugue synthetic messaging_group を idempotent に upsert し、Fugue ask agent group に wire する。
 *
 * **fan-out 二重発火防止** (`init-adk-agent.ts:wireCliChannel` / `init-hybrid-agent.ts:wireSlackDm`
 * と対称、Fugue 経路へ転写):
 *
 * router.ts:routeInbound は 1 メッセージにつき、その messaging_group に紐づく全 agent
 * (fan-out 全件) に対して engage 判定する。`channel_type='fugue'` + `platform_id='fugue-ask-mg'`
 * の synthetic mg が既に別 agent group に wire されていると、handleAsk 経路の inbound が
 * **2 agent への fan-out 発火** = 応答二重 + Vertex API rate limit 消費倍増 + `<ask-response>`
 * が 2 message 分になり handleAsk の regex 抽出が定まらない。
 *
 * 既存 mg に他 agent への wire を検出したら **fail-fast + 手動対応 prompt** を出す。
 *
 * `createMessagingGroupAgent` は `agent_destinations` に `target_type='channel'` の row を
 * 自動作成する (`db/messaging-groups.ts:148-190`)。これにより agent が
 * `<message to="fugue-ask-synthetic">` を書けるようになる。
 */
function wireFugueChannel(ag: AgentGroup, now: string): void {
  let fugueMg: MessagingGroup | undefined = getMessagingGroupByPlatform(FUGUE_CHANNEL, FUGUE_PLATFORM_ID);
  if (!fugueMg) {
    fugueMg = {
      id: generateId('mg'),
      channel_type: FUGUE_CHANNEL,
      platform_id: FUGUE_PLATFORM_ID,
      name: 'Fugue ask (synthetic)',
      is_group: 0, // 1:1 like a DM (Fugue Director が唯一の counterpart)
      // Fugue Cloud Run は identity 未管理 (Bearer auth のみ)、synthetic sender で
      // routeInbound に流れるため public にしないと router が unknown sender ゲートで drop する
      unknown_sender_policy: 'public',
      denied_at: null,
      created_at: now,
    };
    createMessagingGroup(fugueMg);
    console.log(`Created Fugue messaging group: ${fugueMg.id} (${FUGUE_CHANNEL}/${FUGUE_PLATFORM_ID})`);
  } else {
    console.log(`Reusing Fugue messaging group: ${fugueMg.id} (${FUGUE_CHANNEL}/${FUGUE_PLATFORM_ID})`);
    const existingWirings = getMessagingGroupAgents(fugueMg.id);
    const otherWirings = existingWirings.filter((w) => w.agent_group_id !== ag.id);
    if (otherWirings.length > 0) {
      const wiringList = otherWirings
        .map((w) => `  - agent_group_id=${w.agent_group_id} (mga.id=${w.id}, engage_mode=${w.engage_mode})`)
        .join('\n');
      console.error(
        `
ERROR: Fugue mg ${FUGUE_CHANNEL}/${FUGUE_PLATFORM_ID} is already wired to ${otherWirings.length} other agent group(s):
${wiringList}

router.ts:routeInbound is fan-out (all wired agents engage), so a single Fugue ask
inbound would double-invoke both the existing agent(s) and the fugue-ask agent group.
The <ask-response> extraction in handleAsk depends on exactly 1 message reaching outbound.db,
so multiple wires cause silent parse failures.

Resolve either by:
  (a) Removing existing wire(s) with \`ncl wirings remove --id <mga.id>\` before re-running
      (recommended — Fugue ask is a channel-scoped, single-agent design)
  (b) Retiring the existing wire manually via SQL (advanced) after backing up the DB
`.trim(),
      );
      process.exit(1);
    }
  }

  const existing = getMessagingGroupAgentByPair(fugueMg.id, ag.id);
  if (existing) {
    console.log(`Fugue wiring already exists: ${existing.id}`);
    return;
  }
  // Fugue 経路: engage_mode='pattern' + engage_pattern='.' = 常時応答 (handleAsk 経由の
  // inbound は必ず engage、gate は handleAsk 側 = Layer 4 で通過済み)。
  // session_mode='per-thread' で 1 request = 1 session (handleAsk が resolveSession の
  // thread_id 引数に request_id を渡し、新規 session を都度作る)。
  createMessagingGroupAgent({
    id: generateId('mga'),
    messaging_group_id: fugueMg.id,
    agent_group_id: ag.id,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    created_at: now,
  });
  console.log(`Wired Fugue channel: ${fugueMg.id} -> ${ag.id}`);
}

/**
 * fugue-ask group の container_configs.mcp_servers を hybrid と同一 desired state に
 * upsert する (M4-F Phase 3 資産の再利用)。
 *
 * env は空 object。tavily-mcp v0.2.20 の keyless mode + OneCLI Bearer 注入経路で
 * 認証する (init-hybrid-agent.ts:seedMcpServers の JSDoc 参照、Bash 経由の
 * /proc/[pid]/environ 漏洩を防ぎつつ実 API key は wire 上でだけ実体を持つ)。
 *
 * Drive も同流儀で OneCLI が Bearer placeholder を SA 2 段 impersonation で
 * 取得した ADC token に置換する (drive-token-rotator sidecar が 40min 周期で更新)。
 */
function seedMcpServers(agentGroupId: string): void {
  const desired: Record<string, McpServerConfig> = {
    tavily: {
      command: 'tavily-mcp',
      args: [],
      env: {},
      instructions:
        'Web 検索は tavily の `tavily_search` を使え。'
        + '無料枠は月 1,000 credits なので、同義クエリの連打は避け、'
        + '複雑な調査は 1 リクエストで済ませる形に整えろ。'
        + '結果は多くとも 3-5 件に絞り、Fugue Director LLM が判断できる形に整形して返せ。'
        + '生の JSON をそのまま貼らない。',
    },
    drive: {
      command: 'node',
      args: ['/opt/mcp-servers/drive/index.mjs'],
      env: {},
      instructions:
        'Google Drive は `drive_list_files` (フォルダ内一覧) / '
        + '`drive_get_file` (ファイル内容取得) を使え。'
        + `メンテナが GSA \`biblio-google-drive-user@${process.env.GCP_PROJECT_ID ?? '<your-gcp-project>'}.iam.gserviceaccount.com\` に`
        + '「閲覧者」として共有した Drive フォルダのみアクセス可能。'
        + 'それ以外は 403 が返るため、その旨を Fugue Director LLM に明示し、共有依頼を促せ。'
        + 'Google Docs は自動的に text 化される、Binary ファイルは 5 MiB まで。',
    },
  };
  updateContainerConfigJson(agentGroupId, 'mcp_servers', desired);
  console.log(`Ensured container_config.mcp_servers: tavily (Web 検索) + drive (Google Drive)`);
}

export interface SeedResult {
  agent_group_id: string;
  folder: string;
  is_new_group: boolean;
  messaging_group_id: string;
  messaging_group_platform_id: string;
}

/**
 * DB seed 本体 (test から直接呼べる純粋関数)。DB は呼び出し側で
 * `initDb + runMigrations` 済の前提。
 */
export function seedFugueAskAgent(args: Args, now: string): SeedResult {
  // 1. Agent group + filesystem (idempotent by folder)。
  //    owner user + addMember は呼ばない (Fugue に人間の owner は存在しない設計)。
  let ag: AgentGroup | undefined = getAgentGroupByFolder(FUGUE_ASK_AGENT_FOLDER);
  const isNewGroup = !ag;
  if (!ag) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: args.agentName,
      folder: FUGUE_ASK_AGENT_FOLDER,
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(FUGUE_ASK_AGENT_FOLDER)!;
    console.log(`Created Fugue-ask agent group: ${ag.id} (${FUGUE_ASK_AGENT_FOLDER})`);
  } else {
    console.log(`Reusing Fugue-ask agent group: ${ag.id} (${FUGUE_ASK_AGENT_FOLDER})`);
  }

  // initGroupFilesystem が `ensureContainerConfig` を内部で呼ぶため、
  // updateContainerConfigScalars の前に必ず通す (行不在なら UPDATE が silent no-op)。
  //
  // **M4-H Phase 3.5 の設計変更 (2026-07-08、meta response 対処)**:
  // Phase 3 hotfix (Option 1) では `initGroupFilesystem({instructions: <2 段包み契約>})` で
  // groups/<folder>/CLAUDE.local.md に指示を書き込み、SDK の `settingSources: ['project',
  // 'user', 'local']` 経路で auto-load させていた。しかし preset の内蔵 chatbot pattern
  // (`.claude-shared.md` = `container/CLAUDE.md`) が優先度で勝ち、agent LLM が meta response
  // (「起動しました」) を返す構造が残っていた。
  //
  // Phase 3.5 は `container_configs.system_prompt_override` (migration 020) 経由で SDK に
  // custom system prompt 直渡し + `settingSources: []` (SDK isolation) で auto-load 停止。
  // CLAUDE.md / CLAUDE.local.md は SDK に届かないため、ここで instructions を積む意味がない。
  // ただし `initGroupFilesystem` は agent group folder scaffolding (`.claude-fragments/` /
  // `.claude-shared.md` symlink / container.json のディレクトリ) を作る役割は残るため、
  // instructions は空文字を渡して呼び出しは維持する (副作用の scaffolding は保持)。
  initGroupFilesystem(ag, { instructions: '' });

  // provider=null が本 script の中核設定 (init-hybrid-agent.ts と同じ選択)。
  // router.ts:deliverToAgent で provider === 'adk' 分岐が偽になり、既存 agent-container
  // 経路 (spawn / K8s Job) に素通りする。resolveProviderName の "claude" fallback が
  // 実際の provider 名を返す。model は Vertex publisher ID を明示 (M1 で発生した
  // Vertex 404 の再発防止、init-hybrid-agent.ts:431-435 と同流儀)。
  //
  // **isNewGroup gate から外して毎回 assert** (init-adk-agent.ts / init-hybrid-agent.ts
  // の PR review 教訓、self-healing):
  // initGroupFilesystem 途中の fs 書込み failure 等で agent_group 行だけ残り
  // updateContainerConfigScalars が飛ばされた場合、次回実行時に isNewGroup=false と
  // 判定されて provider 設定が永久に反映されない (silent 破綻)。毎回 assert する
  // 方が真の意味での冪等・自己修復に近い。
  //
  // M4-H Phase 3.5: fugue-ask.md (~300 行) を read + `system_prompt_override` に投入。
  // readFileSync throw (ENOENT 等) は init script の fatal error として扱い、fail-fast する
  // (silent skip すると agent-runner が preset fallback で meta response を再発する)。
  const fugueAskSystemPrompt = readFileSync(resolvePath(process.cwd(), FUGUE_ASK_SYSTEM_PROMPT_PATH), 'utf-8');
  updateContainerConfigScalars(ag.id, {
    provider: null,
    model: 'claude-sonnet-4-6',
    system_prompt_override: fugueAskSystemPrompt,
  });
  console.log(
    `Ensured container_config: provider=null (claude fallback), model='claude-sonnet-4-6', ` +
      `system_prompt_override=${fugueAskSystemPrompt.length} chars from ${FUGUE_ASK_SYSTEM_PROMPT_PATH}`,
  );

  // Tavily + Drive を hybrid と完全同一 seed (M4-F Phase 3 資産の再利用)。
  seedMcpServers(ag.id);

  // 2. Fugue synthetic messaging_group + wire (createMessagingGroupAgent 経由で
  // agent_destinations も自動作成、agent が <message to> で書ける状態にする)。
  wireFugueChannel(ag, now);

  const fugueMg = getMessagingGroupByPlatform(FUGUE_CHANNEL, FUGUE_PLATFORM_ID)!;

  return {
    agent_group_id: ag.id,
    folder: FUGUE_ASK_AGENT_FOLDER,
    is_new_group: isNewGroup,
    messaging_group_id: fugueMg.id,
    messaging_group_platform_id: FUGUE_PLATFORM_ID,
  };
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const now = new Date().toISOString();
  const summary = seedFugueAskAgent(args, now);

  console.log('');
  console.log('Init complete.');
  console.log(`  agent:      [${summary.agent_group_id}] @ groups/${FUGUE_ASK_AGENT_FOLDER}`);
  console.log(`  provider:   null (routes via container-runner spawn, K8s Job on GKE)`);
  console.log(
    `  channel:    fugue/${summary.messaging_group_platform_id} (messaging_group_id=${summary.messaging_group_id})`,
  );
  console.log(`  CLI wire:   none (fan-out 排除、Fugue 経路のみ)`);
  console.log(`  Slack wire: none (fan-out 排除、Fugue 経路のみ)`);
  console.log('');
  console.log('Set the following env vars for orchestrator (fugue-http.ts:handleAsk):');
  console.log(`  FUGUE_ASK_AGENT_GROUP_ID=${summary.agent_group_id}`);
  console.log(`  FUGUE_ASK_MESSAGING_GROUP_ID=${summary.messaging_group_id}`);
  console.log('');
  console.log('SEED_RESULT=' + JSON.stringify(summary));
}

// script として直接起動時のみ main() を実行 (unit test では import のみ)。
// init-hybrid-agent.ts:504-513 と同流儀の ESM idiom。
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
