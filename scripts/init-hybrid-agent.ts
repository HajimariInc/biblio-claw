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
import { addMember } from '../src/modules/permissions/db/agent-group-members.js';
import { getUser, upsertUser } from '../src/modules/permissions/db/users.js';
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

export function parseArgs(argv: string[]): Args {
  // 既存 init-first-agent.ts:72-108 の `Partial<Args>` object 集約 pattern に統一。
  // let で 5 変数を並べる旧実装との一貫性を回復し、宣言変数を 1 個に削減する。
  const out: Partial<Args> = {};

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    switch (key) {
      case '--user-id':
        out.userId = val;
        i++;
        break;
      case '--slack-dm-channel-id':
        out.slackDmChannelId = val;
        i++;
        break;
      case '--display-name':
        out.displayName = val;
        i++;
        break;
      case '--agent-name':
        out.agentName = val;
        i++;
        break;
      case '--skip-slack-dm':
        out.skipSlackDm = true;
        break;
    }
  }

  // env fallback は test 直接起動 or 他 script からの override 経路を有効化
  // (GKE wrapper `init-hybrid-agent-gke.sh` は明示 `--flag` に変換して渡すので
  // この経路を通らないが、直接 `HYBRID_USER_ID=... tsx scripts/...` で叩く
  // デバッグ用途を残す)。boolean は `||` 一発で env の "1" / "true" を評価する
  // (no-op guard = 「skipSlackDm が既に true なら true を再代入」の冗長を撲滅)。
  const userId = out.userId ?? process.env.HYBRID_USER_ID;
  const slackDmChannelId = out.slackDmChannelId ?? process.env.HYBRID_SLACK_DM_CHANNEL_ID;
  const skipSlackDm =
    out.skipSlackDm === true
    || process.env.HYBRID_SKIP_SLACK_DM === '1'
    || process.env.HYBRID_SKIP_SLACK_DM === 'true';

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
    displayName: (out.displayName ?? '').trim() || HYBRID_DEFAULT_DISPLAY,
    agentName: (out.agentName ?? '').trim() || HYBRID_DEFAULT_NAME,
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
  allowFanout: boolean = false,
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
    // **Phase 2 (M4-F gate + routing) で拡張**: `allowFanout=true` (env `GATE_ENABLED` 有効時
    // にのみ true) は「gate の classification-provider mismatch skip で構造的に二重発火を防ぐ」
    // 前提で既存 wire (= ADK) の隣に hybrid wire を追加する。gate 無効時は従来通り fail-fast。
    const existingWirings = getMessagingGroupAgents(dmMg.id);
    const otherWirings = existingWirings.filter((w) => w.agent_group_id !== ag.id);
    if (otherWirings.length > 0) {
      if (allowFanout) {
        console.log(
          `Phase 2 (gate + routing) allowFanout=true: proceeding to add hybrid wire alongside ${otherWirings.length} existing wire(s).`,
        );
        console.log(
          `  existing wires: ${otherWirings.map((w) => w.agent_group_id).join(', ')}`,
        );
        console.log(
          '  gate (router.ts:evaluateGate + deliverToAgent mismatch skip) will route on classifier output.',
        );
        // ここで return せず後段の createMessagingGroupAgent (追加 wire) へ流す
      } else {
        // 14 個の個別 console.error 呼出 → 単一 template literal 1 回に集約 (S5)。
        // 出力内容 (空行 + 順序) は完全等価、test 側 `errSpy.mock.calls.flat().join('\n')`
        // の substring assert (case 7 の `already wired to 1 other agent group` /
        // `ag-adk-existing` を含む) も維持される。
        const wiringList = otherWirings
          .map((w) => `  - agent_group_id=${w.agent_group_id} (mga.id=${w.id}, engage_mode=${w.engage_mode})`)
          .join('\n');
        console.error(
          `
ERROR: Slack DM ${encodedPlatformId} is already wired to ${otherWirings.length} other agent group(s):
${wiringList}

router.ts:routeInbound is fan-out (all wired agents engage), so a single DEN Slack DM
would double-invoke both the existing agent(s) and the hybrid agent group.

Resolve either by:
  (a) Removing existing wire(s) with \`ncl wirings remove --id <mga.id>\` before re-running
      (recommended if you intend to migrate the DEN DM to hybrid = agent-container path)
  (b) Retiring the existing wire manually via SQL (advanced) after backing up the DB
  (c) Set GATE_ENABLED=true before running (Phase 2 gate + routing lifts this constraint by
      routing on classifier output; both wires will coexist and fan-out is suppressed by the
      classification-provider mismatch skip in router.ts:deliverToAgent).
`.trim(),
        );
        process.exit(1);
      }
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

/**
 * hybrid group の container_configs.mcp_servers を desired state に upsert する
 * (M4-F Phase 3)。
 *
 * 契約 3 点:
 *   1. 副作用は updateContainerConfigJson の 1 回のみ。scalar assert 直後に
 *      置き、provider/model と同流儀で isNewGroup gate 外の self-healing に載せる。
 *   2. env は空 object (Tavily も Drive も同じ)。実 API key と ADC token は OneCLI
 *      vault が MITM で wire 上の Authorization header に注入する。Bash 復活後の
 *      agent-container 内で env 参照しても TAVILY_API_KEY / DRIVE token は見えない。
 *   3. instructions は日本語で書き、spawn 時に claude-md-compose 経由で CLAUDE.md
 *      にインライン合成される (patron JTBD 言語と一致させて対応品質を上げる)。
 *
 * ## env が空 object の理由 (Tavily keyless mode 発見の経緯、2026-07-05 実測)
 * tavily-mcp v0.2.20 の src/index.ts:103 は `Authorization: Bearer ${API_KEY}` を
 * header に送るが、同時に line 612 以降で request body にも `api_key: API_KEY` を
 * 埋める (search/extract/crawl/map/research 全て)。OneCLI proxy は Authorization
 * header 置換のみで body は書き換えられないため、env=`{TAVILY_API_KEY:'placeholder'}`
 * だと body に `api_key: "placeholder"` が入って Tavily API が 401 を返す。
 *
 * 一方 tavily-mcp は `process.env.TAVILY_API_KEY` が未設定なら keyless mode で
 * 起動 (src/index.ts:110 のログ「no TAVILY_API_KEY set; running in keyless mode.
 * Search and extract are available」)。keyless mode では body に api_key を追加
 * しない (`...(IS_KEYLESS ? {} : { api_key: API_KEY })`)。したがって env を空に
 * すれば OneCLI Bearer 注入だけで search + extract が成立、命題 2 (secret は
 * wire 上でだけ実体を持つ) を完全遵守できる。
 *
 * Drive も同流儀で env なし = Drive MCP server が Authorization: Bearer placeholder
 * を送り OneCLI が実 ADC token に置換。ADC token は drive-token-rotator sidecar
 * が 40min 周期で onecli-drive-secret.sh 経由で更新する。
 */
function seedMcpServers(agentGroupId: string): void {
  const desired: Record<string, McpServerConfig> = {
    tavily: {
      command: 'tavily-mcp',
      args: [],
      // env は空 object。tavily-mcp v0.2.20 の keyless mode を利用して body に
      // api_key が入るのを避け、OneCLI が Bearer header に SM 由来の実 key を
      // 注入する経路のみで認証する (詳細は本関数の JSDoc §env が空 object の理由)。
      env: {},
      instructions:
        'Web 検索は tavily の `tavily_search` を使え。'
        + '無料枠は月 1,000 credits なので、同義クエリの連打は避け、'
        + '複雑な調査は 1 リクエストで済ませる形に整えろ。'
        + '結果は多くとも 3-5 件に絞り、要約して patron に返せ。'
        + '生の JSON をそのまま貼らない。',
    },
    drive: {
      command: 'node',
      args: ['/opt/mcp-servers/drive/index.mjs'],
      env: {},
      instructions:
        'Google Drive は `drive_list_files` (フォルダ内一覧) / '
        + '`drive_get_file` (ファイル内容取得) を使え。'
        + `patron が GSA \`biblio-orchestrator@${process.env.GCP_PROJECT_ID ?? '<gcp-project-id>'}.iam.gserviceaccount.com\` に`
        + '「閲覧者」として共有した Drive フォルダのみアクセス可能。'
        + 'それ以外は 403 が返るため、その旨を patron に明示し、共有依頼を促せ。'
        + 'Google Docs は自動的に text 化される、Binary ファイルは 5 MiB まで。',
    },
  };
  updateContainerConfigJson(agentGroupId, 'mcp_servers', desired);
  console.log(
    `Ensured container_config.mcp_servers: tavily (Web 検索) + drive (Google Drive、env=placeholder)`,
  );
}

export interface SeedResult {
  agent_group_id: string;
  folder: string;
  is_new_group: boolean;
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
  // Args 相互依存 assert (I5、fail-closed): parseArgs は CLI 境界で
  // slackDmChannelId 必須を強制するが、seedHybridAgent は export され直接
  // 呼び出し経路 (test / 将来の script) が存在するため、契約違反を silent skip
  // せず fail-fast。plan の「silent failure 撲滅」流儀と整合。
  if (!args.skipSlackDm && !args.slackDmChannelId) {
    throw new Error(
      'seedHybridAgent: slackDmChannelId is required unless skipSlackDm=true '
        + '(parseArgs should have caught this at the CLI boundary)',
    );
  }

  // 1. Owner user assert (`INSERT OR IGNORE` 相当、既存 owner は無傷保護)。
  //    upsertUser の SQL は `ON CONFLICT DO UPDATE SET display_name = COALESCE(
  //    excluded.display_name, users.display_name)` = 渡した値が non-null なら
  //    常に上書き。args.displayName は parseArgs 経路で default 'Patron' が入り
  //    非 null 化するため、既存 owner (init-first-agent.ts で登録済の DEN さん)
  //    の display_name が毎回 'Patron' に silent 上書きされる問題を getUser
  //    guard で回避する (既存 row を触らない)。
  if (!getUser(args.userId)) {
    upsertUser({
      id: args.userId,
      kind: SLACK_CHANNEL,
      display_name: args.displayName,
      created_at: now,
    });
  }

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
      '自己拡張は `/self-customize` skill で本 CLAUDE.local.md を追記する。\n\n' +
      // 以下の biblio workspace 関連 instruction は PR #145 実機で発現した silent success 罠
      // (agent が /data/quarantine/ /data/shelf/ への rm -rf を実行して exit 0 で「削除成功」
      // と誤認識、実際は agent container の mount 対象外で空振り) への恒久対策。案 1 + 案 2 統合、
      // 詳細は issue #149 (`cleanup_biblio_workspace` MCP tool 新設)。既存 agent group の
      // PVC 上 CLAUDE.local.md には kubectl cp で別途反映 (`initGroupFilesystem` は初回作成時
      // のみ seed するため、既存 group は自動更新されない、docs/operations-runbook.md §M4-F 参照)。
      '## biblio 業務経路 (`/data/quarantine/` `/data/shelf/`) の扱い\n\n' +
      'biblio 業務の作業ディレクトリ (`/data/quarantine/` `/data/shelf/`) は host TS 実装のみが扱う ' +
      '(M2 PRD B 集約設計、CLAUDE.md 明記)。**agent container 内には mount されておらず、' +
      '`ls /data` は exit 2 で "No such file or directory" を返す**。\n\n' +
      '**絶対禁止**: `Bash rm -rf /data/quarantine/*` や `rm -rf /data/shelf/*` 等の直接操作。' +
      'path 不在で silent success (`rm -f` / `rm -rf` は exit 0 を返す) する経路が実在し、' +
      '「削除成功」と誤認識する (PR #145 実機で発現、DEN さん HITL 手動対処 2026-07-06)。\n\n' +
      '**cleanup が必要になった場合の正規経路**:\n' +
      '- 棚上 skill (陳列成功済) の削除: `mcp__nanoclaw__shokyaku_biblio` ' +
      '(HITL 承認 + GitHub PR + fs.rmSync + DB clean を atomic に実行)\n' +
      '- shelve 失敗の retry のため未陳列の quarantine / shelf 準備区の残骸を cleanup: ' +
      '**現状は正規経路なし** = DEN さんに手動 cleanup 依頼 (kubectl exec) が必要。' +
      '将来的に `mcp__nanoclaw__cleanup_biblio_workspace` MCP tool が追加される予定 (issue #149)\n\n' +
      '**rm 全般の silent success 防御**: `Bash rm` 実行後は必ず `ls` or `stat` で削除確認する。' +
      '`-f` / `-rf` オプションは path 不在でも exit 0 を返すため、「rm 成功 = 削除完了」と早合点しない。' +
      'path 不在で success した場合は「そもそも path が見えていない = mount 対象外の可能性」を疑い、' +
      'host TS の MCP tool 経路への切替を検討する。\n',
  });

  // provider=null が本 script の中核設定。router.ts:deliverToAgent で
  // provider === 'adk' 分岐が偽になり、既存 agent-container 経路 (spawn / K8s Job) に
  // 素通りする。resolveProviderName (`src/container-runner.ts:275-280`) の
  // `|| 'claude'` fallback が実際の provider 名を返す。
  //
  // model は必ず Vertex publisher ID を明示する。null で残すと container.json 経由で
  // agent-runner container の `--model` フラグが unset になり、claude-code SDK 内蔵
  // デフォルトが Anthropic API alias (Vertex 未解決) を返して Vertex rawPredict が
  // 404 化する既知障害 (M1 で実際に踏み修正済、init-first-agent.ts / init-cli-agent.ts
  // が明示 'claude-sonnet-4-6' で回避している経路を継承)。
  //
  // **isNewGroup gate から外して毎回 assert** (I2 = PR #101 review 指摘、
  // init-adk-agent.ts:256-266 の pattern を継承):
  // initGroupFilesystem 途中の fs 書込み failure 等で agent_group 行だけ残り
  // updateContainerConfigScalars が飛ばされた場合、次回実行時に isNewGroup=false と
  // 判定されて provider 設定が永久に反映されない (silent 破綻)。毎回 assert する
  // 方が真の意味での冪等・自己修復に近い。
  updateContainerConfigScalars(ag.id, {
    provider: null,
    model: 'claude-sonnet-4-6',
  });
  console.log(`Ensured container_config: provider=null (claude fallback), model='claude-sonnet-4-6'`);

  // M4-F Phase 3: mcp_servers を Tavily + Drive で idempotent assert。
  // provider/model scalar と同流儀で isNewGroup gate 外 = self-healing。
  // 実 API key / ADC token は OneCLI vault が MITM 経由で wire 上に置換するため、
  // env は placeholder のみを持たせる (Bash 復活後の /proc/*/environ 読み取り漏洩を撲滅)。
  seedMcpServers(ag.id);

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
  //    **Phase 2 (M4-F gate + routing)**: `GATE_ENABLED=true` の環境下では既存 ADK wire に
  //    hybrid を並置する両 wire を許容 (fan-out 二重発火は router.ts の gate
  //    classification-provider mismatch skip で構造的に抑止される)。
  const gateEnabled =
    process.env.GATE_ENABLED === '1' || process.env.GATE_ENABLED === 'true';
  if (!args.skipSlackDm && args.slackDmChannelId) {
    wireSlackDm(ag, args.slackDmChannelId, args.displayName, now, gateEnabled);
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
// Node 24 + tsx の両方で `process.argv[1]` は絶対パスに解決される (実機検証済)、
// ESM idiom の `import.meta.url === pathToFileURL(argv[1]).href` 比較で
// ファイル名 hardcode + Windows path 手動置換の脆弱性を除去 (S4)。
const invokedDirectly =
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
