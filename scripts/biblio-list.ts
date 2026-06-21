/**
 * scripts/biblio-list.ts — 蔵書一覧取得 (list_biblio) の CLI ハーネス。
 *
 * Phase 5 で追加予定の verify-m3.sh から呼ばれる想定で、host proxy bootstrap +
 * ProxyAgent インストール → listBiblio() を実行し、結果を `RESULT=<json>` 行で
 * stdout に出す (host のログ類は stderr)。listBiblio は GitHub Git Data API を
 * OneCLI MITM 経由で叩くため、host proxy + ProxyAgent (= undici global dispatcher)
 * を起動時に必ず登録する (= `setupVertexProxy()` は名前に反して Vertex 専用ではなく
 * undici fetch 全般の経路を設定するため、GitHub fetch にも必須)。
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
import { setupVertexProxy } from '../src/biblio/vertex-client.js';

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

  // host proxy + ProxyAgent (undici global dispatcher) 登録 (= GitHub fetch を OneCLI MITM
  // 経由にして installation token 注入)。これが無いと fetchMarketplace の ghFetch が直接
  // GitHub に出て authenticated rate limit (5000/h) を享受できず unauthenticated (60 req/hr)
  // に倒れる。biblio-shelf は public なので 401 にはならないが、rate limit が効くと
  // verify-m3.sh の繰り返し実行で再現性が壊れる。
  await initHostProxy();
  setupVertexProxy();

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
