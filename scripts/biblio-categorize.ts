/**
 * scripts/biblio-categorize.ts — カテゴライズ (categorize) の CLI ハーネス。
 *
 * verify-m2.sh から呼ばれ、host proxy bootstrap + Vertex ProxyAgent インストール
 * → categorize() を実行し、結果を `RESULT=<json>` 行で stdout に出す (host のログ類は stderr)。
 * 判定が ok でも fail でも結果が生成できたら exit 0、引数不正は exit 2、
 * ハーネス自体のクラッシュは exit 3。判定の真偽は呼び出し側 (shell) が行う。
 *
 * Usage:
 *   pnpm exec tsx scripts/biblio-categorize.ts <biblio-name> [<quarantine-root>]
 *
 *   `quarantine-root` を渡すと対象の親ディレクトリを上書きする (verify が
 *   fixture をコピーした一時ディレクトリを指す)。省略時は `${DATA_DIR}/quarantine`。
 *
 * biblio-inspect.ts と同形 (host proxy → vertex proxy → harness 本体 → RESULT 出力)。
 */
import { categorize } from '../src/biblio/categorize.js';
import { initHostProxy } from '../src/biblio/host-proxy.js';
import { setupVertexProxy } from '../src/biblio/vertex-client.js';

async function main(): Promise<number> {
  const biblioName = process.argv[2];
  const quarantineRoot = process.argv[3];

  if (!biblioName) {
    process.stderr.write('usage: biblio-categorize.ts <biblio-name> [<quarantine-root>]\n');
    return 2;
  }

  // host agent 登録 + proxy 解決 (mode=all 昇格を効かせるため categorize 前に必須)。
  await initHostProxy();
  // Vertex 用 ProxyAgent (undici) を global dispatcher に登録 (Vertex Anthropic fetch 用)。
  setupVertexProxy();

  const result = await categorize({ biblioName }, quarantineRoot ? { quarantineRoot } : {});
  process.stdout.write(`RESULT=${JSON.stringify(result)}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`harness crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(3);
  });
