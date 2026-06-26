import { describe, expect, it } from 'vitest';
import { buildNoProxyWithTelemetry } from '../no-proxy.js';

describe('buildNoProxyWithTelemetry', () => {
  it('telemetry.googleapis.com を空入力にも追加する', () => {
    expect(buildNoProxyWithTelemetry(undefined, undefined)).toBe('telemetry.googleapis.com');
  });

  it('process.env.NO_PROXY を fallback として使い、telemetry を末尾追加', () => {
    expect(buildNoProxyWithTelemetry(undefined, 'localhost,10.0.0.1')).toBe(
      'localhost,10.0.0.1,telemetry.googleapis.com',
    );
  });

  it('providerOverride が process.env より優先される', () => {
    expect(buildNoProxyWithTelemetry('from-provider', 'from-process')).toBe('from-provider,telemetry.googleapis.com');
  });

  it('既に telemetry.googleapis.com を含む場合は重複追加しない', () => {
    expect(buildNoProxyWithTelemetry(undefined, 'telemetry.googleapis.com,localhost')).toBe(
      'telemetry.googleapis.com,localhost',
    );
  });

  it('空白と空エントリを除去する', () => {
    expect(buildNoProxyWithTelemetry(undefined, ' localhost , , 10.0.0.1 ,')).toBe(
      'localhost,10.0.0.1,telemetry.googleapis.com',
    );
  });

  it('providerOverride 空文字列も "値あり" として扱う (= process fallback しない)', () => {
    expect(buildNoProxyWithTelemetry('', 'from-process')).toBe('telemetry.googleapis.com');
  });
});
