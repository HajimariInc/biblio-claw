/**
 * scripts/fake-fugue-client.ts — Fugue channel adapter (M4-E Phase 1-2) 疎通確認用の
 * Fake Fugue クライアント CLI。
 *
 * Fugue Cloud Run 実結線前の local dev 検証用に、biblio-claw 側の HTTP endpoint に
 * Bearer 付き POST を打って RESULT=<json> を stdout に吐く。verify script 呼び出し
 * (Phase 6 = 任意予定) にも耐えるよう exit code は 0 (成功) / 2 (usage error) /
 * 3 (harness crash) の 3 分岐。
 *
 * Phase 2 で consult subcommand に `--query <str>` / `--mode <literal>` オプションを
 * 追加。Phase 3 で equip subcommand を full spec 化 (`--skill-id <str>` 必須 + `channel:'fugue'`
 * 自動付与)。
 *
 * Usage:
 *   pnpm exec tsx scripts/fake-fugue-client.ts consult --query "Figma" --mode "review-with-ad"
 *   pnpm exec tsx scripts/fake-fugue-client.ts consult --query "test"
 *   pnpm exec tsx scripts/fake-fugue-client.ts equip --skill-id "HajimariInc--figma-reviewer"
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
  /**
   * `--traceparent <hex>` を指定した際に実際に送出した W3C `traceparent` header 値
   * (未指定時は `null`、Phase 4 review S2 対応で `undefined` → `null` に変更 =
   * `JSON.stringify` は値が `undefined` のキーを **出力から drop** するため、`RESULT=<json>`
   * の中身が「未指定時にキー自体が消える」/「指定時にキー + string 値」の 2 形になり、
   * `'used_traceparent' in result` 判定が false negative を起こす。`null` なら常にキー保持)。
   * Phase 4 で追加、dev 検証で trace 継承を biblio-claw 側 log から追跡するための marker。
   * grammar validation は biblio 側 propagator の silent-ignore 挙動を尊重して行わない
   * (client は raw 値を forward するのみ、malformed の可視化は biblio 側 log
   * `fugue.traceparent.malformed` event で担う)。
   */
  used_traceparent: string | null;
}

function isSubcommand(v: string | undefined): v is Subcommand {
  return v === 'consult' || v === 'equip';
}

/**
 * `--foo <value>` 形式の option を取り出す。option 名が存在しても値が続かない場合は
 * undefined を返す (usage error にはしない = server 側の Zod で reject させる)。
 */
function parseOption(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];
  const badToken = argv.includes('--bad-token');

  if (!isSubcommand(subcommand)) {
    process.stderr.write(
      'usage: fake-fugue-client.ts <consult|equip> [--bad-token] [--query <str>] [--mode <brainstorm-with-ad|review-with-ad|ask-ad|coaching-with-ad>] [--skill-id <str>] [--traceparent <00-32hex-16hex-flags>]\n',
    );
    return 2;
  }
  const traceparent = parseOption(argv, 'traceparent');

  const env = readEnvFile(['FUGUE_SHARED_TOKEN', 'FUGUE_HTTP_PORT', 'FUGUE_HTTP_HOST']);
  // --bad-token 指定時は auth 分岐 `bad_token` を発火させるため、意図的に不正 token を送る
  // (`no_header` は別の CLI パスで扱う想定 — 今は `--bad-token` の 1 パターンだけ提供)。
  const realToken = env.FUGUE_SHARED_TOKEN ?? '';
  const token = badToken ? 'wrong-token' : realToken;
  const port = parseInt(env.FUGUE_HTTP_PORT || '8080', 10);
  const host = env.FUGUE_HTTP_HOST || '127.0.0.1';
  const url = `http://${host}:${port}/v1/channels/fugue/${subcommand}`;

  const startedAt = Date.now();

  // Phase 2: consult は full spec (`query` / `mode`)、Phase 3: equip も full spec (`skill_id` +
  // `channel:'fugue'`)。`context_hint` は Phase 2 では検索ロジックに反映されないため、options 化しない
  // (over-thinking-avoidance: 使わない可変性は入れない、必要になったら追加)。
  let body: Record<string, unknown>;
  if (subcommand === 'consult') {
    body = {
      schema_version: '1',
      request_id: `fake-${startedAt}`,
      query: parseOption(argv, 'query') ?? 'default consult query',
      // --mode 未指定時は 'ask-ad'。server 側 Zod が invalid literal を reject するため
      // ここでは client 側 validate せず、意図的に不正値を送る verify テストにも耐える。
      mode: parseOption(argv, 'mode') ?? 'ask-ad',
    };
  } else {
    // equip 経路 (Phase 3)。`--skill-id` は状態変更対象を指定するため default 値なし = 未指定は usage error。
    // channel は Fugue 契約 §5.3 の HITL 簡略化 discriminator (literal 'fugue')。
    const skillId = parseOption(argv, 'skill-id');
    if (!skillId) {
      process.stderr.write(
        'usage: fake-fugue-client.ts equip --skill-id <str> [--bad-token]\n' +
          '  --skill-id is required (a biblio name from consult SkillRef.id, e.g. "HajimariInc--figma-reviewer").\n',
      );
      return 2;
    }
    body = {
      schema_version: '1',
      request_id: `fake-${startedAt}`,
      skill_id: skillId,
      channel: 'fugue',
    };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      // Phase 4: `--traceparent` 指定時のみ W3C header を送出する。未指定時は biblio 側
      // `extractTraceContextFromHttpHeaders` が active context (Phase 4 時点は effectively
      // ROOT_CONTEXT) を返し、`fugue.consult` / `fugue.equip` span がそれを親として新規
      // trace_id を発行する (Phase 5 で auto HttpInstrumentation が ESM で機能するようになった
      // 場合は、SERVER span が active に乗り、fugue span はその子として nest される)。
      ...(traceparent ? { traceparent } : {}),
    },
    body: JSON.stringify(body),
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
    used_traceparent: traceparent ?? null,
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
