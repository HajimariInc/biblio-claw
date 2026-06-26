import { GoogleAuth } from 'google-auth-library';
import { log } from '../log.js';

const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];
const REFRESH_INTERVAL_MS = 45 * 60 * 1000;

let auth: GoogleAuth | null = null;
let cachedToken: string | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

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
  if (refreshTimer.unref) refreshTimer.unref();
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
