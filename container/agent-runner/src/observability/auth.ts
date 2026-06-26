// NOTE: src/observability/auth.ts (host) と対になるファイル。
// ロジックは同一に保つ。ただし setInterval の unref 呼び出しは Bun と Node で型が
// 異なる (Bun の戻り値は NodeJS.Timeout 互換でないため二段キャストが必要) ため
// 意図的に実装が異なる。それ以外の振る舞いは host と一致させること。
import { GoogleAuth } from 'google-auth-library';
import { log } from '../log.js';

const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];
const REFRESH_INTERVAL_MS = 45 * 60 * 1000;

let auth: GoogleAuth | null = null;
let cachedToken: string | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export async function fetchAccessToken(): Promise<string> {
  if (!auth) auth = new GoogleAuth({ scopes: SCOPES });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  if (!tokenResponse.token) throw new Error('GoogleAuth returned no token');
  return tokenResponse.token;
}

export async function initTokenRefresh(): Promise<string> {
  cachedToken = await fetchAccessToken();
  refreshTimer = setInterval(async () => {
    try {
      cachedToken = await fetchAccessToken();
      log.debug('OTel Bearer token refreshed');
    } catch (err) {
      log.warn('OTel token refresh failed', { error: String(err) });
    }
  }, REFRESH_INTERVAL_MS);
  // Bun の setInterval 戻り値は NodeJS.Timeout 型を持たないため .unref() を型安全に
  // 呼べない。unref() は daemon 化防止 (= プロセス終了を妨げない) のためだけなので、
  // 存在しない場合は no-op で問題ない。
  (refreshTimer as unknown as { unref?: () => void }).unref?.();
  return cachedToken;
}

export function getCachedToken(): string | null {
  return cachedToken;
}

export function stopTokenRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  cachedToken = null;
  auth = null;
}
