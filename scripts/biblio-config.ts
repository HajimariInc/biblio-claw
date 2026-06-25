/**
 * scripts/biblio-config.ts — `biblio_settings` 設定値 CLI ハーネス (個別 PRD Phase 5)。
 *
 * verify-phase-5-dynamic-config.sh から呼ばれ、central DB を直接操作して
 * 結果を `RESULT=<json>` 行で stdout に出す (host のログ類は stderr)。
 * agent / Slack 経路 (= delivery action handler 経由) とは独立した運用 CLI で、allowlist
 * チェックは行わない (= verify script で allowlist 外 key の挙動を確認するため必要)。
 *
 * exit code:
 *   0 = 結果が組み立てられた (get でも set でも delete でも JSON が出る)
 *   2 = 引数不正
 *   3 = ハーネス自体のクラッシュ
 *
 * Usage:
 *   pnpm exec tsx scripts/biblio-config.ts get <KEY>
 *   pnpm exec tsx scripts/biblio-config.ts set <KEY> <VALUE>
 *   pnpm exec tsx scripts/biblio-config.ts delete <KEY>
 *   pnpm exec tsx scripts/biblio-config.ts list
 *
 * DB path:
 *   `DB_PATH` env で上書き可 (= verify script で `/tmp` 配下の専用 fixture DB を指定可能)。
 *   省略時は `data/v2.db` (= 既定の central DB)。
 *
 * biblio-acquire.ts と同流儀の薄ラッパ。
 */
import { getDb, initDb, runMigrations } from '../src/db/index.js';
import {
  deleteBiblioSetting,
  getAllBiblioSettings,
  getBiblioSetting,
  setBiblioSetting,
} from '../src/db/biblio-settings.js';

function usage(): void {
  process.stderr.write(
    'usage:\n' +
      '  biblio-config.ts get <KEY>\n' +
      '  biblio-config.ts set <KEY> <VALUE>\n' +
      '  biblio-config.ts delete <KEY>\n' +
      '  biblio-config.ts list\n' +
      'env:\n' +
      '  DB_PATH (default: data/v2.db)\n',
  );
}

async function main(): Promise<number> {
  const verb = process.argv[2];
  if (!verb) {
    usage();
    return 2;
  }

  const dbPath = process.env.DB_PATH || 'data/v2.db';
  initDb(dbPath);
  runMigrations(getDb());

  if (verb === 'get') {
    const key = process.argv[3];
    if (!key) {
      usage();
      return 2;
    }
    const value = getBiblioSetting(key);
    process.stdout.write(`RESULT=${JSON.stringify({ ok: true, verb, key, value: value ?? null })}\n`);
    return 0;
  }

  if (verb === 'set') {
    const key = process.argv[3];
    const value = process.argv[4];
    if (!key || value === undefined) {
      usage();
      return 2;
    }
    setBiblioSetting(key, value);
    process.stdout.write(`RESULT=${JSON.stringify({ ok: true, verb, key, value })}\n`);
    return 0;
  }

  if (verb === 'delete') {
    const key = process.argv[3];
    if (!key) {
      usage();
      return 2;
    }
    deleteBiblioSetting(key);
    process.stdout.write(`RESULT=${JSON.stringify({ ok: true, verb, key })}\n`);
    return 0;
  }

  if (verb === 'list') {
    const rows = getAllBiblioSettings();
    process.stdout.write(`RESULT=${JSON.stringify({ ok: true, verb, rows })}\n`);
    return 0;
  }

  usage();
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`harness crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(3);
  });
