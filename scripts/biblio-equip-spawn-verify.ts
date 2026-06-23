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
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../src/config.js';
import { getContainerRuntimeProvider } from '../src/adapters/container/index.js';
import { getDsnProvider } from '../src/adapters/dsn/index.js';
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
  // model も明示指定: 未指定だと claude CLI のデフォルト (= claude-sonnet-4-5@20250929) が
  // 使われ、Vertex deployment に enable されていない project では「model is not available」
  // で agent-runner が無限 retry する (= 2026-06-22 M3 verify Manual run で発覚)。.env の
  // CATEGORIZE_MODEL と同じ値を default にし、BIBLIO_VERIFY_MODEL で override 可能。
  const model = process.env.BIBLIO_VERIFY_MODEL || process.env.CATEGORIZE_MODEL || 'claude-sonnet-4-6';
  updateContainerConfigScalars(AG_ID, { provider: 'claude', model });
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

  // 1. central DB init (= src/index.ts:97-99 と同じ DSN adapter 経由で path 解決、local/GKE 透過)
  const db = initDb(getDsnProvider().centralDbPath());
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

  // 本ハーネスは 1-shot プロセスのため、常駐 orchestrator が起動時に呼ぶ `ensureRuntime()`
  // が自動では実行されない。K8s 経路では未呼出のまま `spawn()` を呼ぶと throw するため、
  // ここで明示的に初期化する。`cleanupOrphans()` は不要 (= sweep は常駐 orchestrator の責務)。
  // Docker 経路では `ensureRuntime()` は接続確認のみで副作用なし。
  const containerRuntime = getContainerRuntimeProvider();
  await containerRuntime.ensureRuntime();
  process.stderr.write(`[spawn-verify] container runtime ready: ${containerRuntime.name}\n`);

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

  // 8. marker を poll
  //
  // 2 経路を並列確認:
  //   (a) outbound.db の messages_out (= 正規経路、destination 経由で agent が返答した場合)
  //   (b) docker logs の container 標準エラー出力 (= scratchpad 経路、agent が
  //       `<message to="...">` で wrap しなかった場合でも poll-loop が scratchpad として
  //       stderr に出力するため、`docker logs ... 2>&1` で stdout+stderr 両取得して grep
  //       すれば marker を確実に捕捉できる。agent-runner は IPC を持たない設計で
  //       `console.error()` で log するため scratchpad / WARNING は全て stderr に出る)
  //
  // 旧実装は (a) のみで、verify session には agent_destinations が登録されていないため
  // agent が `<message to="...">` で wrap できず poll-loop が `WARNING: agent output had
  // no <message to="..."> blocks — nothing was sent` で drop して outbound 空、永遠に
  // marker not found に倒れていた (= 2026-06-22 M3 verify Manual run で発覚)。本実装の
  // (b) は SKILL 自体の発火確認には十分 (= MARKER の決定的検出が目的)。destination 経路
  // 自体の verify は将来の Phase で別途。
  const outDbPath = path.join(DATA_DIR, 'v2-sessions', AG_ID, session.id, 'outbound.db');
  const MARKER_RE = /BIBLIO_EQUIP_M3_P2_MARKER_[A-Za-z0-9_]+/;
  const start = Date.now();
  let foundMarker: string | undefined;
  let foundSource: 'outbound.db' | 'docker-logs' | undefined;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    // (a) outbound.db (= 正規経路)
    try {
      if (fs.existsSync(outDbPath)) {
        const outDb = new Database(outDbPath, { readonly: true });
        const rows = outDb.prepare('SELECT content FROM messages_out').all() as Array<{ content: string }>;
        outDb.close();
        for (const row of rows) {
          const match = row.content.match(MARKER_RE);
          if (match) {
            foundMarker = match[0];
            foundSource = 'outbound.db';
            break;
          }
        }
      }
    } catch (err) {
      // SQLITE_LOCKED / SQLITE_BUSY は writer (agent-runner) との競合で expected
      // = silent retry。それ以外 (SQLITE_CORRUPT / NOTADB / テーブル欠落 等) は
      // 永続的なので stderr に出して可視化。
      const code = (err as NodeJS.ErrnoException & { code?: string })?.code ?? '';
      if (code !== 'SQLITE_LOCKED' && code !== 'SQLITE_BUSY') {
        process.stderr.write(`[spawn-verify] outbound.db read error (code=${code || 'unknown'}): ${String(err)}\n`);
      }
    }
    if (foundMarker) break;

    // (b) scratchpad fallback 経路 — agent が `<message to="...">` で wrap しなかった出力を
    // container log から拾う。Docker 経路は `docker logs`、K8s 経路は in-cluster Kubernetes
    // API で `readNamespacedPodLog` を呼ぶ (= orchestrator Pod 内には kubectl / docker
    // バイナリが無いため、@kubernetes/client-node で SA token + CA bundle ベースの API 直叩き)。
    try {
      let logs = '';
      if (process.env.CONTAINER_PROVIDER === 'k8s') {
        // K8s 経路: agent label の Running Pod のうち creationTimestamp 最新の log を tail。
        const k8s = await import('@kubernetes/client-node');
        const kc = new k8s.KubeConfig();
        kc.loadFromCluster();
        const coreApi = kc.makeApiClient(k8s.CoreV1Api);
        const namespace = process.env.BIBLIO_NAMESPACE || 'biblio-claw';
        const list = await coreApi.listNamespacedPod({
          namespace,
          labelSelector: 'app.kubernetes.io/component=agent',
        });
        const running = (list.items ?? []).filter((p) => p.status?.phase === 'Running');
        running.sort((a, b) => {
          const ta = a.metadata?.creationTimestamp ? new Date(a.metadata.creationTimestamp).getTime() : 0;
          const tb = b.metadata?.creationTimestamp ? new Date(b.metadata.creationTimestamp).getTime() : 0;
          return tb - ta;
        });
        const target = running[0];
        if (target?.metadata?.name) {
          // readNamespacedPodLog は string (= log 本体) を返す。失敗時は throw して下の catch へ。
          logs = (await coreApi.readNamespacedPodLog({
            name: target.metadata.name,
            namespace,
            container: 'agent',
            tailLines: 500,
          })) as unknown as string;
        }
      } else {
        // Docker 経路: 既存実装 (container 名は spawn 時点で `nanoclaw-v2-biblio-equip-verify-<ts>`)。
        const namesRaw = execSync(
          'docker ps -a --filter name=nanoclaw-v2-biblio-equip-verify --format {{.Names}}',
          { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
        ).trim();
        const names = namesRaw ? namesRaw.split('\n').filter(Boolean) : [];
        if (names.length > 0) {
          const containerName = names[0] as string;
          // 防御として JSON.stringify で escape (= sh -c 経由の補間で空白 / 特殊文字を持つ
          // name が混入した場合の injection 経路を塞ぐ)。
          logs = execSync(`docker logs ${JSON.stringify(containerName)} 2>&1`, {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        }
      }
      const match = logs.match(MARKER_RE);
      if (match) {
        foundMarker = match[0];
        foundSource = process.env.CONTAINER_PROVIDER === 'k8s' ? 'k8s-pod-log' : 'docker-logs';
      }
    } catch (err) {
      // polling 序盤の「container がまだない」「Pod が見つからない」ケースは expected noise として抑制。
      // 想定外のエラー (daemon 不到達、RBAC 不足、API 接続不能 等) は出力する。
      const msg = err instanceof Error ? err.message : String(err);
      const isExpectedPollingNoise = /no such container|No such image|cannot connect|not found|404/i.test(msg);
      if (!isExpectedPollingNoise) {
        process.stderr.write(`[spawn-verify] container log fetch error: ${msg}\n`);
      }
    }
    if (foundMarker) break;

    const elapsedSec = Math.floor((Date.now() - start) / 1000);
    if (elapsedSec > 0 && elapsedSec % 10 === 0) {
      process.stderr.write(`[spawn-verify] polling ${elapsedSec}s...\n`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  if (foundMarker) {
    process.stderr.write(`[spawn-verify] marker detected via ${foundSource}: ${foundMarker}\n`);
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
