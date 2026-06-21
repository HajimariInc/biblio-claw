/**
 * scripts/biblio-equip-set.ts — session の装備リストを upsert する CLI (M3 Phase 2)。
 *
 * `session_equipped_biblios` を全置換 semantics で更新する。本番経路 (= host TS)
 * では agent / 司書 (orchestrator) からの操作経路を Phase 3 で MCP tool として
 * 整備する予定だが、Phase 2 では host 側 CLI 経路 (= 本ハーネス) のみを公開する。
 *
 * verify-m2.sh 流儀: `RESULT=<json>` を stdout に吐く。assertion は呼び出し側
 * (shell) が JSON フィールド (`count`, `names`) を見て判定する。
 *
 * Usage:
 *   pnpm exec tsx scripts/biblio-equip-set.ts <session-id> [<name1,name2,...>]
 *
 *   引数 2 を省略 or 空文字 → 装備リスト全解除 (= clear)。
 */
import { DB_PATH } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { BIBLIO_NAME_RE } from '../src/biblio/action-helpers.js';
import { upsertEquippedBiblios, getEquippedBibliosBySession } from '../src/db/session-equipped-biblios.js';

interface EquipSetResult {
  ok: boolean;
  session_id: string;
  count: number;
  names: string[];
  detail?: string;
}

function emit(result: EquipSetResult, code: number): never {
  process.stdout.write(`RESULT=${JSON.stringify(result)}\n`);
  process.exit(code);
}

async function main(): Promise<number> {
  const sessionId = process.argv[2];
  const namesCsv = process.argv[3] ?? '';
  if (!sessionId) {
    process.stderr.write('usage: tsx scripts/biblio-equip-set.ts <session-id> [<name1,name2,...>]\n');
    return 2;
  }

  const names = namesCsv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // 各 biblio name を BIBLIO_NAME_RE で事前 validation (= equip.ts の warn skip
  // を待たずに弾く = CLI 越しの取り扱いを厳格化)。
  for (const n of names) {
    if (!BIBLIO_NAME_RE.test(n)) {
      emit(
        { ok: false, session_id: sessionId, count: 0, names: [], detail: `invalid biblio name: ${n}` },
        2,
      );
    }
  }

  // central DB の初期化 (host TS と同じ)。test-v2-agent パターンと違い、ここでは
  // central DB が必要 (= session_equipped_biblios は v2.db に住む)。
  const db = initDb(DB_PATH);
  runMigrations(db);

  upsertEquippedBiblios(sessionId, names);

  // 書き込んだ内容を読み返して、応答に含める (= caller が DB 状態を再確認しやすい)。
  const rows = getEquippedBibliosBySession(sessionId);
  emit(
    {
      ok: true,
      session_id: sessionId,
      count: rows.length,
      names: rows.map((r) => r.biblio_name),
    },
    0,
  );
}

main().catch((err) => {
  process.stderr.write(`harness crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(3);
});
