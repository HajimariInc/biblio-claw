import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { log } from '../../log.js';
import { _resetSecretProviderForTesting, getSecretProvider } from './index.js';
import { OneCLISecretProvider } from './onecli.js';

/**
 * fetch を Response-shaped オブジェクトで stub するためのヘルパ。
 * `ok` / `status` / `json()` を持つ最小実装で `Response` 互換を装う。
 */
function fakeFetchResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('OneCLISecretProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    _resetSecretProviderForTesting();
    // `promoteAgentToModeAll` が常に GET → PATCH を呼ぶため、default は両方 success で stub。
    // 個別テストで `mockImplementationOnce` で差し替える。
    fetchMock = vi.fn().mockImplementation(async (url: string | URL, init?: { method?: string }) => {
      const u = url.toString();
      if (init?.method === 'PATCH') return fakeFetchResponse(200, { ok: true });
      if (u.endsWith('/v1/agents')) return fakeFetchResponse(200, [{ id: 'agt-id', identifier: 'id1' }]);
      return fakeFetchResponse(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('delegates ensureAgent to the OneCLI client', async () => {
    mocks.ensureAgent.mockResolvedValue({ name: 'g1', identifier: 'id1', created: true });
    const p = new OneCLISecretProvider();
    const res = await p.ensureAgent({ name: 'g1', identifier: 'id1' });
    expect(mocks.ensureAgent).toHaveBeenCalledWith({ name: 'g1', identifier: 'id1' });
    expect(res).toEqual({ name: 'g1', identifier: 'id1', created: true });
  });

  it('promotes agent to secret-mode=all after ensureAgent (= bug 5 fix)', async () => {
    mocks.ensureAgent.mockResolvedValue({ name: 'g1', identifier: 'id1', created: true });
    const p = new OneCLISecretProvider();
    await p.ensureAgent({ name: 'g1', identifier: 'id1' });

    // GET /v1/agents で identifier 一致 lookup 後、PATCH /v1/agents/<id>/secret-mode を呼ぶ。
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, patchCall] = fetchMock.mock.calls;
    const [patchUrl, patchInit] = patchCall as [string, { method: string; body: string }];
    expect(patchUrl).toMatch(/\/v1\/agents\/agt-id\/secret-mode$/);
    expect(patchInit.method).toBe('PATCH');
    expect(JSON.parse(patchInit.body)).toEqual({ mode: 'all' });
  });

  it('does not throw when GET /v1/agents fails (= safety net by rotator)', async () => {
    mocks.ensureAgent.mockResolvedValue({ name: 'g1', identifier: 'id1', created: true });
    fetchMock.mockImplementationOnce(async () => fakeFetchResponse(500, { error: 'boom' }));
    const p = new OneCLISecretProvider();
    const res = await p.ensureAgent({ name: 'g1', identifier: 'id1' });
    expect(res).toEqual({ name: 'g1', identifier: 'id1', created: true });
    expect(log.warn).toHaveBeenCalledWith(
      'onecli.promote_mode_all: GET /v1/agents failed',
      expect.objectContaining({ outcome: 'failure', status: 500 }),
    );
  });

  it('does not throw when agent not found in /v1/agents (= rotator picks up later)', async () => {
    mocks.ensureAgent.mockResolvedValue({ name: 'g1', identifier: 'id-missing', created: true });
    fetchMock.mockImplementationOnce(async () => fakeFetchResponse(200, [{ id: 'other', identifier: 'someone-else' }]));
    const p = new OneCLISecretProvider();
    await expect(p.ensureAgent({ name: 'g1', identifier: 'id-missing' })).resolves.toBeDefined();
    expect(log.warn).toHaveBeenCalledWith(
      'onecli.promote_mode_all: agent not found after ensure',
      expect.objectContaining({ outcome: 'failure', identifier: 'id-missing' }),
    );
  });

  it('does not throw when PATCH secret-mode fails (= ensure still succeeds)', async () => {
    mocks.ensureAgent.mockResolvedValue({ name: 'g1', identifier: 'id1', created: true });
    // 1 回目 (GET) は default の success、2 回目 (PATCH) を 403 に差し替え。
    fetchMock.mockImplementationOnce(async () => fakeFetchResponse(200, [{ id: 'agt-id', identifier: 'id1' }]));
    fetchMock.mockImplementationOnce(async () => fakeFetchResponse(403, { error: 'forbidden' }));
    const p = new OneCLISecretProvider();
    await expect(p.ensureAgent({ name: 'g1', identifier: 'id1' })).resolves.toBeDefined();
    expect(log.warn).toHaveBeenCalledWith(
      'onecli.promote_mode_all: PATCH secret-mode failed',
      expect.objectContaining({ outcome: 'failure', status: 403 }),
    );
  });

  it('swallows fetch network errors (= rotator picks up later)', async () => {
    mocks.ensureAgent.mockResolvedValue({ name: 'g1', identifier: 'id1', created: true });
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('ECONNREFUSED');
    });
    const p = new OneCLISecretProvider();
    await expect(p.ensureAgent({ name: 'g1', identifier: 'id1' })).resolves.toBeDefined();
    expect(log.warn).toHaveBeenCalledWith(
      'onecli.promote_mode_all: unexpected error',
      expect.objectContaining({ outcome: 'failure', identifier: 'id1' }),
    );
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
