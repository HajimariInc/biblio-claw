import { describe, it, expect } from 'bun:test';
import { upperCaseEnvSetter, upperCaseEnvGetter } from './env-propagation.js';

describe('upperCaseEnvSetter (agent)', () => {
  it('uppercases the key when setting', () => {
    const carrier: Record<string, string> = {};
    upperCaseEnvSetter.set(carrier, 'traceparent', '00-abc-xyz-01');
    expect(carrier).toEqual({ TRACEPARENT: '00-abc-xyz-01' });
  });
});

describe('upperCaseEnvGetter (agent)', () => {
  it('reads a value by uppercasing the requested key', () => {
    const carrier = { TRACEPARENT: '00-abc-xyz-01' };
    expect(upperCaseEnvGetter.get(carrier, 'traceparent')).toBe('00-abc-xyz-01');
  });

  it('returns undefined when the uppercased key is absent', () => {
    expect(upperCaseEnvGetter.get({}, 'traceparent')).toBeUndefined();
  });

  it('does NOT match lowercase keys', () => {
    const carrier = { traceparent: '00-abc-xyz-01' };
    expect(upperCaseEnvGetter.get(carrier, 'traceparent')).toBeUndefined();
  });
});
