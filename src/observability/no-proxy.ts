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
