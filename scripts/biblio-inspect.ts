/**
 * scripts/biblio-inspect.ts — 検品 (inspect) の CLI ハーネス。
 *
 * verify-m2-b-phase-2.sh から呼ばれ、host proxy bootstrap + Vertex ProxyAgent インストール
 * → inspect() を実行し、結果を `RESULT=<json>` 行で stdout に出す (host のログ類は stderr)。
 * 判定が ACCEPT でも HOLD でも REJECT でも結果が生成できたら exit 0、引数不正は exit 2、
 * ハーネス自体のクラッシュは exit 3。verdict 判定は呼び出し側 (shell) が行う。
 *
 * Usage:
 *   pnpm exec tsx scripts/biblio-inspect.ts <biblio-name> [<quarantine-root>]
 *
 *   `quarantine-root` を渡すと検品対象の親ディレクトリを上書きする (verify が
 *   fixture をコピーした一時ディレクトリを指す)。省略時は `${DATA_DIR}/quarantine`。
 */
import { initHostProxy } from '../src/biblio/host-proxy.js';
import { inspect } from '../src/biblio/inspect.js';
import { setupVertexProxy } from '../src/biblio/vertex-client.js';

async function main(): Promise<number> {
  const biblioName = process.argv[2];
  const quarantineRoot = process.argv[3];

  if (!biblioName) {
    process.stderr.write('usage: biblio-inspect.ts <biblio-name> [<quarantine-root>]\n');
    return 2;
  }

  // host agent 登録 + proxy 解決 (mode=all 昇格を効かせるため inspect 前に必須)。
  await initHostProxy();
  // Vertex 用 ProxyAgent (undici) を global dispatcher に登録 (dangerous 軸 fetch 用)。
  setupVertexProxy();

  const result = await inspect({ biblioName }, quarantineRoot ? { quarantineRoot } : {});
  process.stdout.write(`RESULT=${JSON.stringify(result)}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`harness crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(3);
  });
