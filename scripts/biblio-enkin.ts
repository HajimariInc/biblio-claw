/**
 * scripts/biblio-enkin.ts — 禁書 (enkin) の CLI ハーネス。
 *
 * `verify-m3-phase-3.sh` から呼ばれ、host proxy bootstrap + ProxyAgent インストール
 * → enkin() を直接呼び (= HITL 承認 bypass)、結果を `RESULT=<json>` 行で stdout に出す。
 * GitHub Git Data API を OneCLI MITM 経由で叩くため biblio-shelve.ts と同じ proxy setup を踏襲。
 *
 * exit code:
 *   0 = 結果が組み立てられた (ok でも fail でも JSON が出る)
 *   2 = 引数不正
 *   3 = ハーネス自体のクラッシュ
 *
 * Usage:
 *   pnpm exec tsx scripts/biblio-enkin.ts <biblio-name> <category>
 *
 *   `biblio-name`: `<owner>--<name>` 形式
 *   `category`: biblio-dev | biblio-art | biblio-bf | biblio-ai
 *
 * biblio-shelve.ts と同形 (= reason は不要、quarantine/shelf root も不要)。
 */
import { enkin } from '../src/biblio/enkin.js';
import { initHostProxy } from '../src/biblio/host-proxy.js';
import { BIBLIO_CATEGORIES, type BiblioCategory } from '../src/biblio/types.js';
import { setupVertexProxy } from '../src/biblio/vertex-client.js';

const VALID_CATEGORIES: readonly BiblioCategory[] = BIBLIO_CATEGORIES;

async function main(): Promise<number> {
  const biblioName = process.argv[2];
  const category = process.argv[3];

  if (!biblioName || !category) {
    process.stderr.write(
      'usage: biblio-enkin.ts <biblio-name> <category>\n' +
        '  category: biblio-dev | biblio-art | biblio-bf | biblio-ai\n',
    );
    return 2;
  }
  if (!VALID_CATEGORIES.includes(category as BiblioCategory)) {
    process.stderr.write(`invalid category: "${category}" (must be one of ${VALID_CATEGORIES.join('|')})\n`);
    return 2;
  }

  await initHostProxy();
  setupVertexProxy();

  const result = await enkin({ biblioName, category: category as BiblioCategory });
  process.stdout.write(`RESULT=${JSON.stringify(result)}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`harness crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(3);
  });
