/**
 * scripts/fake-fugue-client.ts — Fugue channel adapter (M4-E Phase 1) 疎通確認用の
 * Fake Fugue クライアント CLI。
 *
 * Fugue Cloud Run 実結線前の local dev 検証用に、biblio-claw 側の HTTP endpoint に
 * Bearer 付き POST を打って RESULT=<json> を stdout に吐く。verify script 呼び出し
 * (Phase 6 = 任意予定) にも耐えるよう exit code は 0 (成功) / 2 (usage error) /
 * 3 (harness crash) の 3 分岐。
 *
 * Usage:
 *   pnpm exec tsx scripts/fake-fugue-client.ts consult
 *   pnpm exec tsx scripts/fake-fugue-client.ts equip
 *   pnpm exec tsx scripts/fake-fugue-client.ts consult --bad-token
 */
import { readEnvFile } from '../src/env.js';

type Subcommand = 'consult' | 'equip';

interface Result {
  subcommand: Subcommand;
  url: string;
  status: number;
  duration_ms: number;
  response_body: unknown;
  response_body_parse_error: boolean;
  used_token_kind: 'valid' | 'bad' | 'missing';
}

function isSubcommand(v: string | undefined): v is Subcommand {
  return v === 'consult' || v === 'equip';
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];
  const badToken = argv.includes('--bad-token');

  if (!isSubcommand(subcommand)) {
    process.stderr.write('usage: fake-fugue-client.ts <consult|equip> [--bad-token]\n');
    return 2;
  }

  const env = readEnvFile(['FUGUE_SHARED_TOKEN', 'FUGUE_HTTP_PORT', 'FUGUE_HTTP_HOST']);
  // --bad-token 指定時は auth 分岐 `bad_token` を発火させるため、意図的に不正 token を送る
  // (`no_header` は別の CLI パスで扱う想定 — 今は `--bad-token` の 1 パターンだけ提供)。
  const realToken = env.FUGUE_SHARED_TOKEN ?? '';
  const token = badToken ? 'wrong-token' : realToken;
  const port = parseInt(env.FUGUE_HTTP_PORT || '8080', 10);
  const host = env.FUGUE_HTTP_HOST || '127.0.0.1';
  const url = `http://${host}:${port}/v1/channels/fugue/${subcommand}`;

  const startedAt = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ schema_version: '1', request_id: `fake-${startedAt}` }),
  });
  const duration_ms = Date.now() - startedAt;
  // I2 対応: 疎通確認用ツールが疎通異常時に沈黙するのを防ぐ。実際に parse に失敗するのは
  // 「想定外の応答が来た」ことを意味する (proxy のエラーページ / port 違い / 接続途中切断)。
  // stderr に warn を出し、`parse_error: true` marker を返して `{}` と区別できるようにする
  // (将来 verify script が RESULT= を assert 消費するときの誤グリーン判定を防ぐ)。
  let response_body_parse_error = false;
  const response_body = await res.json().catch((err: unknown) => {
    response_body_parse_error = true;
    process.stderr.write(
      `warn: response body is not valid JSON: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { parse_error: true };
  });

  const used_token_kind: Result['used_token_kind'] = badToken ? 'bad' : realToken ? 'valid' : 'missing';
  const result: Result = {
    subcommand,
    url,
    status: res.status,
    duration_ms,
    response_body,
    response_body_parse_error,
    used_token_kind,
  };
  process.stdout.write(`RESULT=${JSON.stringify(result)}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`harness crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(3);
  });
