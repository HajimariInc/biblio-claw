/**
 * scripts/biblio-equip-spawn-verify.ts — 装備 → spawn → SKILL 発火 → marker 検出 の E2E (M3 Phase 2)。
 *
 * 流れ:
 *   1. central DB を init + migration
 *   2. host proxy bootstrap (= OneCLI agent ensure + secret injection)
 *   3. test agent group `ag-biblio-equip-verify` を ensure (= 既存ならそのまま)
 *      + groups/biblio-equip-verify/ ディレクトリを ensure (= CLAUDE.md 最小投入)
 *      + container_config を ensure (provider=claude)
 *   4. test session (agent-shared) を ensure
 *   5. session_equipped_biblios に [<biblio-name>] を upsert
 *   6. inbound.db に `/biblio-hello:fire-marker を実行して、出力された MARKER を verbatim で返答に含めて`
 *      メッセージを trigger=1 で直書き
 *   7. wakeContainer(session) で container 起動 → /app/install-biblios.sh →
 *      claude plugin install --scope user → enable → agent-runner が SKILL を発見 →
 *      patron 依頼で fire-marker 発火 → outbound.db に書き戻し
 *   8. outbound.db を 120s timeout / 1s 間隔で poll → marker (= "BIBLIO_EQUIP_M3_P2_MARKER_") を grep
 *   9. RESULT={marker_found, marker, session_id, biblio_name, ...} を吐く
 *
 * verify-m2.sh 流儀: stdout は RESULT 行のみ、その他は stderr。
 *
 * Usage:
 *   pnpm exec tsx scripts/biblio-equip-spawn-verify.ts <biblio-name>
 *
 * 前提:
 *   - <DATA_DIR>/biblio-equipped/<biblio-name>/ に PoC-11 同形 marketplace fixture が
 *     既に投入されている (verify-m3-phase-2.sh が事前に投入する)
 *   - OneCLI gateway 到達可能 + vertex secret が injection 設定済
 *   - container image (nanoclaw-agent:latest) が build 済 = jq + install-biblios.sh 入り
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { DB_PATH, DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { createAgentGroup, getAgentGroup } from '../src/db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../src/db/container-configs.js';
import { upsertEquippedBiblios } from '../src/db/session-equipped-biblios.js';
import { resolveSession, writeSessionMessage, writeSessionRouting } from '../src/session-manager.js';
import { wakeContainer } from '../src/container-runner.js';
import { initHostProxy } from '../src/biblio/host-proxy.js';
import { BIBLIO_NAME_RE } from '../src/biblio/action-helpers.js';

interface SpawnVerifyResult {
  marker_found: boolean;
  marker?: string;
  session_id: string;
  biblio_name: string;
  agent_group_id: string;
  poll_seconds?: number;
  detail?: string;
}

const AG_ID = 'ag-biblio-equip-verify';
const AG_FOLDER = 'biblio-equip-verify';
const MARKER_PREFIX = 'BIBLIO_EQUIP_M3_P2_MARKER_';
const POLL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

function emit(result: SpawnVerifyResult, code: number): never {
  process.stdout.write(`RESULT=${JSON.stringify(result)}\n`);
  process.exit(code);
}

/** test agent group + groups/<folder>/ + container_config を ensure (idempotent)。 */
function ensureTestAgentGroup(): void {
  if (!getAgentGroup(AG_ID)) {
    createAgentGroup({
      id: AG_ID,
      name: 'biblio-equip-verify',
      folder: AG_FOLDER,
      agent_provider: 'claude',
      created_at: new Date().toISOString(),
    });
    process.stderr.write(`[spawn-verify] created agent group: ${AG_ID}\n`);
  }

  const groupsDir = path.resolve(process.cwd(), 'groups');
  const folderDir = path.join(groupsDir, AG_FOLDER);
  fs.mkdirSync(folderDir, { recursive: true });
  const claudeMd = path.join(folderDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) {
    fs.writeFileSync(
      claudeMd,
      [
        '# biblio-equip-verify (M3 Phase 2 E2E test agent)',
        '',
        'You are a test agent for verifying biblio equip spawn-time install + SKILL fire.',
        'When asked to run a biblio skill, execute it exactly as instructed in its SKILL.md',
        'and return the script stdout verbatim. Be brief — do not narrate.',
        '',
      ].join('\n'),
    );
  }

  ensureContainerConfig(AG_ID);
  // provider=claude を明示 (= test-v2-host と同じ)。既存 row があれば idempotent に上書き。
  updateContainerConfigScalars(AG_ID, { provider: 'claude' });
}

async function main(): Promise<number> {
  const biblioName = process.argv[2];
  if (!biblioName) {
    process.stderr.write('usage: tsx scripts/biblio-equip-spawn-verify.ts <biblio-name>\n');
    process.exit(2);
  }
  if (!BIBLIO_NAME_RE.test(biblioName)) {
    emit(
      {
        marker_found: false,
        session_id: '',
        biblio_name: biblioName,
        agent_group_id: AG_ID,
        detail: 'invalid biblio name (BIBLIO_NAME_RE 不通過)',
      },
      2,
    );
  }

  // 装備源 dir が前提 (= verify-m3-phase-2.sh が事前投入)。なければ早期 fail。
  const equipSourceDir = path.join(DATA_DIR, 'biblio-equipped', biblioName);
  if (!fs.existsSync(equipSourceDir)) {
    emit(
      {
        marker_found: false,
        session_id: '',
        biblio_name: biblioName,
        agent_group_id: AG_ID,
        detail: `equipped biblio source dir not found: ${equipSourceDir}`,
      },
      1,
    );
  }

  // 1. central DB init
  const db = initDb(DB_PATH);
  runMigrations(db);
  process.stderr.write('[spawn-verify] central DB initialized\n');

  // 2. host proxy + OneCLI agent ensure (= secret mode=all 昇格)
  await initHostProxy();
  process.stderr.write('[spawn-verify] host proxy initialized\n');

  // 3. test agent group + container config を ensure
  ensureTestAgentGroup();

  // 4. test session を ensure (agent-shared = agent group 単位の唯一 session)
  const { session } = resolveSession(AG_ID, null, null, 'agent-shared');
  process.stderr.write(`[spawn-verify] session resolved: ${session.id}\n`);

  // routing 情報を書く (= messaging_group なしでも空 routing を投入して container を warm 起動)
  writeSessionRouting(AG_ID, session.id);

  // 5. session_equipped_biblios upsert (= 1 biblio 装備)
  upsertEquippedBiblios(session.id, [biblioName]);
  process.stderr.write(`[spawn-verify] equipped biblio: ${biblioName}\n`);

  // 6. inbound.db に「fire-marker を実行して、出力 verbatim 返答」を直書き
  const msgId = `equip-verify-${Date.now()}`;
  writeSessionMessage(AG_ID, session.id, {
    id: msgId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({
      sender: 'biblio-equip-verify',
      text:
        '/biblio-hello:fire-marker を実行して、emit-marker.sh の stdout (= "MARKER=BIBLIO_EQUIP_M3_P2_MARKER_..." を含む行) を verbatim で返答に含めてください。',
    }),
    trigger: 1,
  });
  process.stderr.write(`[spawn-verify] inbound message written: ${msgId}\n`);

  // 7. wakeContainer → spawn → install-biblios.sh → SKILL 発火
  const woke = await wakeContainer(session);
  process.stderr.write(`[spawn-verify] wakeContainer returned: ${woke}\n`);
  if (!woke) {
    emit(
      {
        marker_found: false,
        session_id: session.id,
        biblio_name: biblioName,
        agent_group_id: AG_ID,
        detail: 'wakeContainer returned false (transient spawn failure — see logs/nanoclaw.error.log)',
      },
      1,
    );
  }

  // 8. outbound.db を poll
  const outDbPath = path.join(DATA_DIR, 'v2-sessions', AG_ID, session.id, 'outbound.db');
  const start = Date.now();
  let foundMarker: string | undefined;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    try {
      if (fs.existsSync(outDbPath)) {
        const outDb = new Database(outDbPath, { readonly: true });
        const rows = outDb.prepare('SELECT content FROM messages_out').all() as Array<{ content: string }>;
        outDb.close();
        for (const row of rows) {
          const idx = row.content.indexOf(MARKER_PREFIX);
          if (idx >= 0) {
            // marker prefix から alphanumeric が続く範囲を切り出す
            const tail = row.content.slice(idx);
            const match = tail.match(/BIBLIO_EQUIP_M3_P2_MARKER_[A-Za-z0-9_]+/);
            foundMarker = match ? match[0] : tail.slice(0, MARKER_PREFIX.length + 8);
            break;
          }
        }
      }
    } catch {
      // DB lock 等は無視して retry
    }
    if (foundMarker) break;
    const elapsedSec = Math.floor((Date.now() - start) / 1000);
    if (elapsedSec > 0 && elapsedSec % 10 === 0) {
      process.stderr.write(`[spawn-verify] polling ${elapsedSec}s...\n`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  const pollSec = Math.floor((Date.now() - start) / 1000);
  if (!foundMarker) {
    emit(
      {
        marker_found: false,
        session_id: session.id,
        biblio_name: biblioName,
        agent_group_id: AG_ID,
        poll_seconds: pollSec,
        detail: `marker not found in outbound.db within ${POLL_TIMEOUT_MS / 1000}s`,
      },
      1,
    );
  }

  emit(
    {
      marker_found: true,
      marker: foundMarker,
      session_id: session.id,
      biblio_name: biblioName,
      agent_group_id: AG_ID,
      poll_seconds: pollSec,
    },
    0,
  );
}

main().catch((err) => {
  process.stderr.write(`harness crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(3);
});
