import { describe, expect, it } from 'vitest';
import { upperCaseEnvSetter, upperCaseEnvGetter } from '../env-propagation.js';

describe('upperCaseEnvSetter', () => {
  it('uppercases the key when setting', () => {
    const carrier: Record<string, string> = {};
    upperCaseEnvSetter.set(carrier, 'traceparent', '00-abc-xyz-01');
    expect(carrier).toEqual({ TRACEPARENT: '00-abc-xyz-01' });
  });

  it('uppercases mixed-case keys', () => {
    const carrier: Record<string, string> = {};
    upperCaseEnvSetter.set(carrier, 'TraceState', 'foo=1');
    expect(carrier).toEqual({ TRACESTATE: 'foo=1' });
  });
});

describe('upperCaseEnvGetter', () => {
  it('reads a value by uppercasing the requested key', () => {
    const carrier = { TRACEPARENT: '00-abc-xyz-01' };
    expect(upperCaseEnvGetter.get(carrier, 'traceparent')).toBe('00-abc-xyz-01');
  });

  it('returns undefined when the uppercased key is absent', () => {
    expect(upperCaseEnvGetter.get({}, 'traceparent')).toBeUndefined();
  });

  it('does NOT match lowercase keys (UPPERCASE spec strict)', () => {
    const carrier = { traceparent: '00-abc-xyz-01' };
    expect(upperCaseEnvGetter.get(carrier, 'traceparent')).toBeUndefined();
  });

  it('enumerates all keys via keys()', () => {
    const carrier = { TRACEPARENT: 'a', TRACESTATE: 'b', UNRELATED: 'c' };
    expect(upperCaseEnvGetter.keys(carrier).sort()).toEqual(['TRACEPARENT', 'TRACESTATE', 'UNRELATED']);
  });
});
