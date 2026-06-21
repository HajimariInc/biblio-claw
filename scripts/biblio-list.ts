/**
 * scripts/biblio-list.ts — 蔵書一覧取得 (list_biblio) の CLI ハーネス (M3 Phase 4)。
 *
 * Phase 5 の verify-m3.sh から呼ばれ、host proxy bootstrap → listBiblio() を実行し、
 * 結果を `RESULT=<json>` 行で stdout に出す (host のログ類は stderr)。
 * listBiblio は GitHub Git Data API を OneCLI MITM 経由で叩くため、host proxy
 * 用に設定する ProxyAgent (= global dispatcher) を起動時に必ず登録する。
 *
 * exit code:
 *   0 = 結果が組み立てられた (`RESULT=` 行を 1 行出力)
 *   2 = 引数不正 (= category が biblio-dev|art|bf|ai のいずれでもない)
 *   3 = ハーネス自体のクラッシュ
 *
 * Usage:
 *   pnpm exec tsx scripts/biblio-list.ts                # 全件
 *   pnpm exec tsx scripts/biblio-list.ts biblio-dev     # category filter
 *
 * biblio-shelve.ts / biblio-categorize.ts と同形。
 */
import { initHostProxy } from '../src/biblio/host-proxy.js';
import { listBiblio } from '../src/biblio/list-biblio.js';
import { BIBLIO_CATEGORIES, type BiblioCategory } from '../src/biblio/types.js';

const VALID_CATEGORIES: readonly BiblioCategory[] = BIBLIO_CATEGORIES;

async function main(): Promise<number> {
  const rawCategory = process.argv[2]?.trim() ?? '';
  let category: BiblioCategory | undefined;
  if (rawCategory) {
    if (VALID_CATEGORIES.includes(rawCategory as BiblioCategory)) {
      category = rawCategory as BiblioCategory;
    } else {
      process.stderr.write(
        `usage: biblio-list.ts [<category>]\n` +
          `  category: biblio-dev | biblio-art | biblio-bf | biblio-ai (省略時は全件)\n` +
          `invalid category: "${rawCategory}"\n`,
      );
      return 2;
    }
  }

  // host proxy 登録 (= GitHub fetch を OneCLI MITM 経由にして installation token 注入)。
  // これが無いと fetchMarketplace の ghFetch が直接 GitHub に出て public でも 401/rate limit に当たる。
  await initHostProxy();

  const result = await listBiblio({ category });
  process.stdout.write(`RESULT=${JSON.stringify(result)}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`harness crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(3);
  });
