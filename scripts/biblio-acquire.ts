/**
 * scripts/biblio-acquire.ts — 仕入れ (acquire) の CLI ハーネス。
 *
 * verify-m2-b-phase-1.sh から呼ばれ、host proxy bootstrap → acquire() を実行し、
 * 結果を `RESULT=<json>` 行で stdout に出す (host のログ類は stderr)。
 * 取得が成功でも失敗でも結果を生成できたら exit 0、引数不正は exit 2、
 * ハーネス自体のクラッシュは exit 3。reason 判定は呼び出し側 (shell) が行う。
 *
 * Usage:
 *   pnpm exec tsx scripts/biblio-acquire.ts <owner/repo|url>
 *   pnpm exec tsx scripts/biblio-acquire.ts --register-only   # host agent 登録のみ
 */
import { acquire } from '../src/biblio/acquire.js';
import { initHostProxy } from '../src/biblio/host-proxy.js';

async function main(): Promise<number> {
  const arg = process.argv[2];

  // 引数チェックを先に行い、無効な呼び出しで OneCLI 接続を試みない。
  if (!arg) {
    process.stderr.write('usage: biblio-acquire.ts <owner/repo|url> | --register-only\n');
    return 2;
  }

  // host agent 登録 + proxy 解決 (mode=all 昇格を効かせるため acquire 前に必須)。
  // --register-only もこの ensureAgent を踏む。
  await initHostProxy();

  if (arg === '--register-only') {
    process.stdout.write(`RESULT=${JSON.stringify({ ok: true, registered: true })}\n`);
    return 0;
  }

  const result = await acquire({ repo: arg });
  process.stdout.write(`RESULT=${JSON.stringify(result)}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`harness crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(3);
  });
