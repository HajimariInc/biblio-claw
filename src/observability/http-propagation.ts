// HTTP header 経由での W3C Trace Context 伝搬用の TextMapGetter + extract helper。
//
// 対象: Fugue channel adapter (`src/channels/fugue-http.ts`) が Fugue Cloud Run 側から
// 受け取る `traceparent` / `tracestate` HTTP header。
//
// **Phase 4 review C1 対応** (2 段構造は Phase 5 で正式化として確定):
//
//   確定形 (Phase 5): fugue.consult / fugue.equip → biblio.list / biblio.equip
//     (auto server span 層は本 repo の ESM + `--import` 起動構成では未発火 =
//      `@opentelemetry/instrumentation-http` の core module patch が
//      `require-in-the-middle` 依存で、ESM で機能させるには `module.register()`
//      が別途必要。Phase 5 の ESM フック判断で **2 段構造を正式仕様として採用** = Node 24.15.0
//      `module.register()` DEP0205 documentation-only 非推奨化 + Node 26.0.0 runtime
//      deprecation 予定を根拠に 3 段化投資を見送り、詳細は
//      `docs/operations-runbook.md` §M4-E Phase 4 §ESM フック判断 参照)
//
// 経路の非破壊性を保つ二重の保険:
//   1. **extract の base を `context.active()` にデフォルト引数化**
//      (将来 auto server span 層が発火するようになった際に、`context.with()`
//      で active context を丸ごと置換せず、既存 SERVER span 上に extract を適用できる。
//      W3C propagator は traceparent 不在時に `return context;` を返すため、
//      header 不在の現状経路でも active context を破壊しない = 2 段構造の可逆性を保つ
//      設計と対)
//   2. propagator の副作用のなさ (`propagation.extract` は純粋関数、複数回呼んでも
//      同じ結果 = idempotent)
//
// **重要**: idempotency と非破壊性は別軸。extract 関数自体は idempotent だが、
// 呼び出し元の `context.with(extractedCtx, fn)` は AsyncLocalStorage の `run()` で
// active context を **完全置換** する (マージしない)。そのため base を `ROOT_CONTEXT`
// にしてしまうと、header 不在時に extractedCtx = ROOT_CONTEXT となり、context.with で
// auto SERVER span (仮に発火していれば) が失われる。デフォルト引数の `context.active()`
// はこの落とし穴を撲滅する。
//
// host↔container 間 env carrier 用の `env-propagation.ts` と対で、その HTTP 版という位置付け
// (= agent-runner との同期義務はない、Fugue HTTP は host 側でのみ受ける)。
import type { IncomingHttpHeaders } from 'node:http';
import { context, propagation, type Context, type TextMapGetter } from '@opentelemetry/api';

/**
 * `IncomingHttpHeaders` を carrier とする `TextMapGetter`。
 *
 * Node.js の `IncomingHttpHeaders` はキーを lowercase で保持するが、propagator は
 * lowercase (`traceparent` / `tracestate`) で問い合わせてくるため `key.toLowerCase()` は
 * 実際には no-op になる。それでも明示することで将来の HTTP/2 header (RFC 9113 で大文字 header
 * が禁止されているが破って送るクライアントに備え) や、mock オブジェクト経由の test で
 * 大文字キーを直接入れられたケースにも対応する契約 (= 意図的な defensive coding)。
 *
 * 値が `string[]` (同一 header 名で複数値を受け取った場合、Node.js は先着順の配列で保持)
 * のときは W3C spec に従い先頭を採用 (traceparent は複数値許容していないが、送信側の bug で
 * 複数来たときに silently drop するのではなく first-hit で救う)。
 */
export const httpHeadersGetter: TextMapGetter<IncomingHttpHeaders> = {
  get(carrier, key) {
    const value = carrier[key.toLowerCase()];
    if (Array.isArray(value)) return value[0];
    return value;
  },
  keys(carrier) {
    return Object.keys(carrier);
  },
};

/**
 * HTTP request headers から W3C Trace Context (`traceparent` / `tracestate`) を extract し、
 * その context を返す。
 *
 * **base 引数の重要性 (Phase 4 review C1 対応、Phase 5 で 2 段構造確定後も継続的に有効)**:
 * base はデフォルトで `context.active()` を採用する。理由:
 *   - 将来 auto HttpInstrumentation が機能するようになった際に、既に active 化された
 *     SERVER span を保持したまま extract を適用できる (呼び出し元の `context.with(extractedCtx, fn)`
 *     が active context を置換しても SERVER span が失われない = 2 段構造の可逆性を保つ設計)
 *   - traceparent header 不在時: W3C propagator は `return context;` を返すため、`context.active()`
 *     をそのまま返す = 現状の header 不在経路でも active context を破壊しない
 *   - traceparent header 有時: base の SpanContext が上書きされ、header 由来の trace_id が active になる
 *
 * base に `ROOT_CONTEXT` を明示的に渡す用法は、test 環境で auto instrumentation を無視して
 * pure な extract 挙動 (header からのみ context を作る) を検証したい場合に限る。
 *
 * - header 不在 or malformed の場合: propagator は silently base をそのまま返す (W3C spec §3.2 準拠)
 * - propagator は idempotent (副作用なし) だが、これは呼び出し元の `context.with()` の非破壊性を
 *   意味しない (`context.with()` は AsyncLocalStorage の `run()` で active context を **完全置換**
 *   する = マージしない)。base をどう選ぶかが非破壊性を左右する
 */
export function extractTraceContextFromHttpHeaders(
  headers: IncomingHttpHeaders,
  baseContext: Context = context.active(),
): Context {
  return propagation.extract(baseContext, headers, httpHeadersGetter);
}
