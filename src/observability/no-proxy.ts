/**
 * NO_PROXY マージ: 既存 NO_PROXY に telemetry.googleapis.com を確実に含めた
 * 文字列を返す。Bun の node:https.Agent partial 実装で HTTPS_PROXY (= OneCLI
 * proxy) が効かない可能性があるため、OTLP 経路だけは proxy をバイパスする
 * (OTLP は自前 Bearer なので OneCLI MITM 認証注入は不要)。
 *
 * 優先順位: providerOverride > processFallback > 空文字列
 * (providerContribution の env を process.env より優先する既存挙動を踏襲)
 */
const TELEMETRY_HOST = 'telemetry.googleapis.com';

export function buildNoProxyWithTelemetry(
  providerOverride: string | undefined,
  processFallback: string | undefined,
): string {
  const source = providerOverride ?? processFallback ?? '';
  const entries = source
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!entries.includes(TELEMETRY_HOST)) {
    entries.push(TELEMETRY_HOST);
  }
  return entries.join(',');
}

/**
 * host プロセス自身の `process.env.NO_PROXY` に telemetry.googleapis.com を確実に含める。
 *
 * GKE 環境では orchestrator Pod に `HTTPS_PROXY=http://biblio-onecli:10254` が設定される。
 * Node.js undici/fetch はこれを尊重するため、`OTLPTraceExporter` の send 経路も OneCLI proxy
 * を通過する。telemetry.googleapis.com には OneCLI 側に `hostPattern` が無く tunnel 素通し
 * になるが、tunnel 経路では CA trust / 接続拒否が起き OTel export が silent drop する
 * (= `BatchSpanProcessor` の export 失敗は内部で握りつぶされる = OTel 仕様)。
 *
 * `buildNoProxyWithTelemetry` は agent コンテナの env 配列構築用 (= `container-runner.ts`
 * で agent Pod 起動時に注入) だが、本関数は host プロセス自身の `process.env.NO_PROXY` を
 * `startOtel()` 前に書き換えることで、host 自身の OTLP export が proxy 経路で silent drop
 * するのを防ぐ。`instrumentation.ts` から `startOtel()` の前に呼ぶこと (= NodeSDK が
 * OTLPTraceExporter を作るより前に env が固定される必要がある)。
 */
export function ensureHostNoProxy(): void {
  const current = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  process.env.NO_PROXY = buildNoProxyWithTelemetry(undefined, current);
}
