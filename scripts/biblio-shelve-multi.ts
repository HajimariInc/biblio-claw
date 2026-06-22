/**
 * scripts/biblio-shelve-multi.ts — 複数 (biblioName, category) を 1 PR にまとめる
 * 陳列 (shelveMulti) の CLI ハーネス (Phase 4 multi-category-shelve)。
 *
 * verify (= 任意 scripts/verify-phase-4.sh、または手動 smoke) から呼ばれ、host proxy
 * bootstrap + Vertex ProxyAgent インストール → shelveMulti() を実行し、結果を
 * `RESULT=<json>` 行で stdout に出す (host のログ類は stderr)。shelveMulti は GitHub
 * Git Data API を OneCLI MITM 経由で叩くため、host proxy + Vertex proxy 用に設定する
 * ProxyAgent (= global dispatcher) を共用する (biblio-shelve.ts と同パターン)。
 *
 * exit code:
 *   0 = 結果が組み立てられた (ok でも fail でも JSON が出る)
 *   2 = 引数不正 (= 必須 items JSON 引数の parse 失敗 / shape 不正)
 *   3 = ハーネス自体のクラッシュ
 *
 * Usage:
 *   pnpm exec tsx scripts/biblio-shelve-multi.ts '<items-json>' [<quarantine-root>] [<shelf-root>]
 *
 *   `items-json`: `MultiShelveItem[]` の JSON 文字列。
 *     例: '[{"biblioName":"owner--repo--skill-a","category":"biblio-dev","reason":"r1"},
 *          {"biblioName":"owner--repo--skill-c","category":"biblio-art","reason":"r3"}]'
 *   `quarantine-root` / `shelf-root`: テスト/verify 用の親 dir 上書き (省略時は `${DATA_DIR}/{quarantine,shelf}`)
 *
 * biblio-shelve.ts と同形 (= proxy bootstrap → main 関数 → RESULT 出力)。
 */
import { initHostProxy } from '../src/biblio/host-proxy.js';
import { shelveMulti } from '../src/biblio/shelve.js';
import { setupVertexProxy } from '../src/biblio/vertex-client.js';
import { BIBLIO_CATEGORIES, type BiblioCategory, type MultiShelveItem } from '../src/biblio/types.js';

const VALID_CATEGORIES: readonly BiblioCategory[] = BIBLIO_CATEGORIES;

function parseItems(raw: string): MultiShelveItem[] | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return `items-json が JSON として parse 不可: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!Array.isArray(parsed)) {
    return `items-json は配列である必要があります (例: '[{"biblioName":...,"category":...,"reason":...}]')`;
  }
  const items: MultiShelveItem[] = [];
  for (const [i, raw] of parsed.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      return `items[${i}] が object ではありません`;
    }
    const obj = raw as Record<string, unknown>;
    const biblioName = typeof obj.biblioName === 'string' ? obj.biblioName : '';
    const category = typeof obj.category === 'string' ? obj.category : '';
    const reason = typeof obj.reason === 'string' ? obj.reason : '';
    if (!biblioName) return `items[${i}].biblioName が指定されていません`;
    if (!category) return `items[${i}].category が指定されていません`;
    if (!VALID_CATEGORIES.includes(category as BiblioCategory)) {
      return `items[${i}].category が invalid: "${category}" (許容: ${VALID_CATEGORIES.join('|')})`;
    }
    items.push({ biblioName, category: category as BiblioCategory, reason });
  }
  return items;
}

async function main(): Promise<number> {
  const itemsJson = process.argv[2];
  const quarantineRoot = process.argv[3];
  const shelfRoot = process.argv[4];

  if (!itemsJson) {
    process.stderr.write(
      'usage: biblio-shelve-multi.ts <items-json> [<quarantine-root>] [<shelf-root>]\n' +
        '  items-json: MultiShelveItem[] JSON 文字列\n' +
        '    例: \'[{"biblioName":"owner--repo--skill-a","category":"biblio-dev","reason":"r1"}]\'\n',
    );
    return 2;
  }

  const parsedOrError = parseItems(itemsJson);
  if (typeof parsedOrError === 'string') {
    process.stderr.write(`${parsedOrError}\n`);
    return 2;
  }

  // host proxy + Vertex ProxyAgent 登録 (= GitHub fetch も OneCLI MITM 経由で Authorization 注入)。
  await initHostProxy();
  setupVertexProxy();

  const opts: { quarantineRoot?: string; shelfRoot?: string } = {};
  if (quarantineRoot) opts.quarantineRoot = quarantineRoot;
  if (shelfRoot) opts.shelfRoot = shelfRoot;

  const result = await shelveMulti(parsedOrError, opts);
  process.stdout.write(`RESULT=${JSON.stringify(result)}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`harness crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(3);
  });
