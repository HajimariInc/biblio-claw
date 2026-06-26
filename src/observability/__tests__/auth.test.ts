import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const { getAccessTokenMock, getClientMock } = vi.hoisted(() => {
  const getAccessTokenMock = vi.fn();
  const getClientMock = vi.fn(async () => ({ getAccessToken: getAccessTokenMock }));
  return { getAccessTokenMock, getClientMock };
});

vi.mock('google-auth-library', () => {
  function GoogleAuth() {
    return { getClient: getClientMock };
  }
  return { GoogleAuth };
});

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { fetchAccessToken, initTokenRefresh, getCachedToken, stopTokenRefresh } from '../auth.js';

describe('auth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getAccessTokenMock.mockReset();
    getClientMock.mockClear();
    stopTokenRefresh();
  });

  afterEach(() => {
    stopTokenRefresh();
    vi.useRealTimers();
  });

  it('fetchAccessToken returns the token from GoogleAuth', async () => {
    getAccessTokenMock.mockResolvedValue({ token: 'tok-1' });
    expect(await fetchAccessToken()).toBe('tok-1');
  });

  it('fetchAccessToken throws when GoogleAuth returns no token', async () => {
    getAccessTokenMock.mockResolvedValue({ token: null });
    await expect(fetchAccessToken()).rejects.toThrow(/no token/);
  });

  it('initTokenRefresh caches the initial token and refreshes every 45 minutes', async () => {
    getAccessTokenMock
      .mockResolvedValueOnce({ token: 'tok-initial' })
      .mockResolvedValueOnce({ token: 'tok-refresh-1' });

    const initial = await initTokenRefresh();
    expect(initial).toBe('tok-initial');
    expect(getCachedToken()).toBe('tok-initial');

    await vi.advanceTimersByTimeAsync(45 * 60 * 1000);
    expect(getCachedToken()).toBe('tok-refresh-1');
  });

  it('initTokenRefresh continues with stale token if refresh throws', async () => {
    getAccessTokenMock.mockResolvedValueOnce({ token: 'tok-initial' }).mockRejectedValueOnce(new Error('network'));

    await initTokenRefresh();
    await vi.advanceTimersByTimeAsync(45 * 60 * 1000);
    expect(getCachedToken()).toBe('tok-initial');
  });

  it('stopTokenRefresh clears cached token', async () => {
    getAccessTokenMock.mockResolvedValue({ token: 'tok-x' });
    await initTokenRefresh();
    expect(getCachedToken()).toBe('tok-x');
    stopTokenRefresh();
    expect(getCachedToken()).toBeNull();
  });
});
