/**
 * scripts/biblio-resolve-threshold.ts — `resolveSkillThreshold()` 3 層 fallback の probe CLI。
 *
 * verify-phase-5-dynamic-config.sh から呼ばれ、現在の DB + env 状態で `resolveSkillThreshold()`
 * が返す値を `RESULT={ok, threshold}` で stdout に出す。
 *
 * - DB_PATH env で central DB の path を上書き
 * - ACQUIRE_SKILL_THRESHOLD env も `readEnvFile` 経由で見られる (= verify の env override)
 *
 * exit:
 *   0 = 結果が返った
 *   3 = ハーネスクラッシュ
 */
import { getDb, initDb, runMigrations } from '../src/db/index.js';
import { resolveSkillThreshold } from '../src/biblio/acquire.js';

async function main(): Promise<number> {
  const dbPath = process.env.DB_PATH || 'data/v2.db';
  initDb(dbPath);
  runMigrations(getDb());
  const threshold = resolveSkillThreshold();
  process.stdout.write(`RESULT=${JSON.stringify({ ok: true, threshold })}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`harness crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(3);
  });
