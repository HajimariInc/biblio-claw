/**
 * scripts/biblio-shelve.ts — 陳列 (shelve) の CLI ハーネス。
 *
 * verify-m2.sh から呼ばれ、host proxy bootstrap + ProxyAgent インストール
 * → shelve() を実行し、結果を `RESULT=<json>` 行で stdout に出す (host のログ類は stderr)。
 * shelve は GitHub Git Data API を OneCLI MITM 経由で叩くため、host proxy + Vertex proxy
 * 用に設定する ProxyAgent (= global dispatcher) を共用する。
 *
 * exit code:
 *   0 = 結果が組み立てられた (ok でも fail でも JSON が出る)
 *   2 = 引数不正
 *   3 = ハーネス自体のクラッシュ
 *
 * Usage:
 *   pnpm exec tsx scripts/biblio-shelve.ts <biblio-name> <category> [<reason>] [<quarantine-root>] [<shelf-root>]
 *
 *   `biblio-name`: `<owner>--<name>` 形式 (Phase 3 統一)
 *   `category`: biblio-dev | biblio-art | biblio-bf | biblio-ai
 *   `reason`: カテゴライズ判定理由 (= commit/PR body に埋め込まれる)。verify からは categorize 結果を渡す
 *   `quarantine-root` / `shelf-root`: テスト/verify 用の親 dir 上書き (省略時は `${DATA_DIR}/{quarantine,shelf}`)
 *
 * biblio-inspect.ts / biblio-categorize.ts と同形。
 */
import { initHostProxy } from '../src/biblio/host-proxy.js';
import { shelve } from '../src/biblio/shelve.js';
import { setupVertexProxy } from '../src/biblio/vertex-client.js';
import type { BiblioCategory } from '../src/biblio/types.js';

const VALID_CATEGORIES: readonly BiblioCategory[] = ['biblio-dev', 'biblio-art', 'biblio-bf', 'biblio-ai'];

async function main(): Promise<number> {
  const biblioName = process.argv[2];
  const category = process.argv[3];
  const reason = process.argv[4] ?? '';
  const quarantineRoot = process.argv[5];
  const shelfRoot = process.argv[6];

  if (!biblioName || !category) {
    process.stderr.write(
      'usage: biblio-shelve.ts <biblio-name> <category> [<reason>] [<quarantine-root>] [<shelf-root>]\n' +
        '  category: biblio-dev | biblio-art | biblio-bf | biblio-ai\n',
    );
    return 2;
  }
  if (!VALID_CATEGORIES.includes(category as BiblioCategory)) {
    process.stderr.write(`invalid category: "${category}" (must be one of ${VALID_CATEGORIES.join('|')})\n`);
    return 2;
  }

  // host proxy + Vertex ProxyAgent 登録 (= GitHub fetch も OneCLI MITM 経由で Authorization 注入)。
  await initHostProxy();
  setupVertexProxy();

  const opts: { quarantineRoot?: string; shelfRoot?: string } = {};
  if (quarantineRoot) opts.quarantineRoot = quarantineRoot;
  if (shelfRoot) opts.shelfRoot = shelfRoot;

  const result = await shelve(
    { biblioName, category: category as BiblioCategory, reason: reason || '(理由未指定)' },
    opts,
  );
  process.stdout.write(`RESULT=${JSON.stringify(result)}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`harness crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(3);
  });
