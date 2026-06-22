/**
 * scripts/biblio-shokyaku.ts — 焼却 (shokyaku) の CLI ハーネス。
 *
 * `verify-m3-phase-3.sh` から呼ばれ、host proxy bootstrap + ProxyAgent インストール
 * → shokyaku() を直接呼び (= HITL 承認 bypass)、結果を `RESULT=<json>` 行で stdout に出す。
 *
 * 焼却は shelf PR 作成に加えて `<DATA_DIR>/biblio-equipped/<name>/` を物理削除するため、
 * verify 側は (a) 削除前に fixture を投入し、(b) 削除後に該当 dir が消えていることを assert する。
 *
 * exit code:
 *   0 = 結果が組み立てられた (ok でも fail でも JSON が出る)
 *   2 = 引数不正
 *   3 = ハーネス自体のクラッシュ
 *
 * Usage:
 *   pnpm exec tsx scripts/biblio-shokyaku.ts <biblio-name> <category> [<equipment-root>]
 *
 *   `biblio-name`: `<owner>--<name>` 形式
 *   `category`: biblio-dev | biblio-art | biblio-bf | biblio-ai
 *   `equipment-root`: テスト/verify 用の親 dir 上書き (省略時は `${DATA_DIR}/biblio-equipped`)
 */
import { initHostProxy } from '../src/biblio/host-proxy.js';
import { shokyaku } from '../src/biblio/shokyaku.js';
import { BIBLIO_CATEGORIES, type BiblioCategory } from '../src/biblio/types.js';
import { setupVertexProxy } from '../src/biblio/vertex-client.js';

const VALID_CATEGORIES: readonly BiblioCategory[] = BIBLIO_CATEGORIES;

async function main(): Promise<number> {
  const biblioName = process.argv[2];
  const category = process.argv[3];
  const equipmentRoot = process.argv[4];

  if (!biblioName || !category) {
    process.stderr.write(
      'usage: biblio-shokyaku.ts <biblio-name> <category> [<equipment-root>]\n' +
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

  const opts: { equipmentRoot?: string } = {};
  if (equipmentRoot) opts.equipmentRoot = equipmentRoot;

  const result = await shokyaku({ biblioName, category: category as BiblioCategory }, opts);
  process.stdout.write(`RESULT=${JSON.stringify(result)}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`harness crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(3);
  });
