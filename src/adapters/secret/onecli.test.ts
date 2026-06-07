import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock fns so the (hoisted) vi.mock factory can close over them.
const mocks = vi.hoisted(() => ({
  ensureAgent: vi.fn(),
  applyContainerConfig: vi.fn(),
  configureManualApproval: vi.fn(),
}));

vi.mock('@onecli-sh/sdk', () => ({
  // Regular function (not arrow) so it is constructable via `new OneCLI(...)`.
  OneCLI: vi.fn().mockImplementation(function () {
    return {
      ensureAgent: mocks.ensureAgent,
      applyContainerConfig: mocks.applyContainerConfig,
      configureManualApproval: mocks.configureManualApproval,
    };
  }),
}));

import { _resetSecretProviderForTesting, getSecretProvider } from './index.js';
import { OneCLISecretProvider } from './onecli.js';

describe('OneCLISecretProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    _resetSecretProviderForTesting();
  });

  it('delegates ensureAgent to the OneCLI client', async () => {
    mocks.ensureAgent.mockResolvedValue({ name: 'g1', identifier: 'id1', created: true });
    const p = new OneCLISecretProvider();
    const res = await p.ensureAgent({ name: 'g1', identifier: 'id1' });
    expect(mocks.ensureAgent).toHaveBeenCalledWith({ name: 'g1', identifier: 'id1' });
    expect(res).toEqual({ name: 'g1', identifier: 'id1', created: true });
  });

  it('delegates applyContainerSecrets to applyContainerConfig (passing the same mutable args array)', async () => {
    mocks.applyContainerConfig.mockResolvedValue(true);
    const p = new OneCLISecretProvider();
    const args = ['run', '--rm'];
    const ok = await p.applyContainerSecrets(args, { addHostMapping: false, agent: 'id1' });
    expect(ok).toBe(true);
    expect(mocks.applyContainerConfig).toHaveBeenCalledWith(args, { addHostMapping: false, agent: 'id1' });
    // Same array reference is forwarded (the mutate-in-place contract).
    expect(mocks.applyContainerConfig.mock.calls[0]![0]).toBe(args);
  });

  it('returns false through applyContainerSecrets when the gateway is not applied', async () => {
    mocks.applyContainerConfig.mockResolvedValue(false);
    const p = new OneCLISecretProvider();
    expect(await p.applyContainerSecrets([])).toBe(false);
  });

  it('delegates configureManualApproval and returns the handle', () => {
    const handle = { stop: vi.fn() };
    mocks.configureManualApproval.mockReturnValue(handle);
    const p = new OneCLISecretProvider();
    const cb = async () => 'approve' as const;
    expect(p.configureManualApproval(cb)).toBe(handle);
    expect(mocks.configureManualApproval).toHaveBeenCalledWith(cb);
  });
});

describe('getSecretProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    _resetSecretProviderForTesting();
  });

  it('returns an onecli provider by default and shares one singleton', () => {
    const a = getSecretProvider();
    expect(a.name).toBe('onecli');
    // Singleton is load-bearing: container-runner + onecli-approvals must share it.
    expect(getSecretProvider()).toBe(a);
  });

  it('throws on an unknown SECRET_PROVIDER value', () => {
    _resetSecretProviderForTesting();
    vi.stubEnv('SECRET_PROVIDER', 'bogus');
    expect(() => getSecretProvider()).toThrow(/Unknown SECRET_PROVIDER: bogus/);
  });
});
