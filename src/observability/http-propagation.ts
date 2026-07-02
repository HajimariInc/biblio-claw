// HTTP header 経由での W3C Trace Context 伝搬用の TextMapGetter + extract helper。
//
// 対象: Fugue channel adapter (`src/channels/fugue-http.ts`) が Fugue Cloud Run 側から
// 受け取る `traceparent` / `tracestate` HTTP header。auto-instrumentations-node の
// HttpInstrumentation は同時に extract 済 context を active にしてくれる想定だが、
// 明示 extract 経路を用意して:
//   1. auto instrumentation が disable された将来の変更で silent に trace 継承が壊れないよう明示 fallback
//   2. `context.with(extractedCtx, fn)` で child span (`fugue.consult` / `fugue.equip`) の
//      parent を確実に設定
//   3. propagator は idempotent = 既存 active context を破壊しないため二重 extract で不整合を起こさない
//
// host↔container 間 env carrier 用の `env-propagation.ts` と対で、その HTTP 版という位置付け
// (= agent-runner との同期義務はない、Fugue HTTP は host 側でのみ受ける)。
import type { IncomingHttpHeaders } from 'node:http';
import { propagation, ROOT_CONTEXT, type Context, type TextMapGetter } from '@opentelemetry/api';

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
 * その context を返す (auto HttpInstrumentation の extract 経路が動いていない環境でも
 * 明示的に trace 継承を確立するための fallback)。
 *
 * - header 不在 or malformed の場合: propagator は silently `ROOT_CONTEXT` を返す
 *   (= 新規 trace_id で fugue entry span が発火する。W3C spec §3.2 準拠)
 * - propagator は idempotent = 既に auto-instrumentation が active 化した context がある
 *   場合でも上書きしない (呼び出し元は `context.with(extractedCtx, fn)` で明示的に切替)
 */
export function extractTraceContextFromHttpHeaders(headers: IncomingHttpHeaders): Context {
  return propagation.extract(ROOT_CONTEXT, headers, httpHeadersGetter);
}
