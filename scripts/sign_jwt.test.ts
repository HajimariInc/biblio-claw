/**
 * Tests for scripts/sign_jwt.cjs — the GitHub App RS256 JWT signer used by
 * scripts/onecli-gh-secret.sh.
 *
 * Why these specific assertions (PR #6 review P3):
 * - GH_APP_ID missing → exit 1: settings drift mustn't fall through.
 * - PEM stdin invalid → exit 1: the script must reject non-PEM before crypto.sign.
 * - iat = now - 60: the 60-second clock-skew compensation is GitHub-recommended;
 *   a future refactor that drops it would expire JWTs prematurely on machines
 *   with skewed clocks. The test pins the contract.
 * - exp - iat = JWT_EXP_SECONDS + 60: the TOTAL window. Defaults to 600s = 10min
 *   = GitHub's hard maximum. Past comments documented this incorrectly as
 *   "iat からの有効秒数 540 = 9 分" — both wrong. The test ensures the math
 *   stays right.
 * - header.alg = RS256: GitHub Apps only accept RS256. Pin it.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, 'sign_jwt.cjs');

function runSignJwt(opts: {
  env?: Record<string, string | undefined>;
  input?: string;
}): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
  // Removing a key from env requires deletion, not setting undefined.
  for (const k of Object.keys(opts.env ?? {})) {
    if (opts.env![k] === undefined) delete env[k];
  }
  return spawnSync('node', [SCRIPT], {
    input: opts.input ?? '',
    encoding: 'utf8',
    env,
  });
}

function generateTestPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString());
}

describe('sign_jwt.cjs (PR #6 review P3)', () => {
  it('exits 1 with informative stderr when GH_APP_ID is missing', () => {
    const result = runSignJwt({ env: { GH_APP_ID: undefined } });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/GH_APP_ID/);
    expect(result.stdout).toBe('');
  });

  it('exits 1 when stdin is empty (no PEM)', () => {
    const result = runSignJwt({ env: { GH_APP_ID: '12345' }, input: '' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/PEM/);
  });

  it('exits 1 when stdin contains garbage instead of a PEM block', () => {
    const result = runSignJwt({
      env: { GH_APP_ID: '12345' },
      input: 'this is definitely not a PEM\n',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/PEM/);
  });

  it('produces a 3-part JWT with header.alg=RS256 and iss=GH_APP_ID', () => {
    const pem = generateTestPem();
    const result = runSignJwt({ env: { GH_APP_ID: '54321' }, input: pem });
    expect(result.status).toBe(0);
    const jwt = result.stdout.trim();
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    const header = decodeJwtPart(parts[0]!);
    const payload = decodeJwtPart(parts[1]!);
    expect(header.alg).toBe('RS256');
    expect(header.typ).toBe('JWT');
    expect(payload.iss).toBe('54321');
  });

  it('sets iat 60 seconds in the past (clock-skew compensation contract)', () => {
    const pem = generateTestPem();
    const before = Math.floor(Date.now() / 1000);
    const result = runSignJwt({ env: { GH_APP_ID: '12345' }, input: pem });
    expect(result.status).toBe(0);
    const payload = decodeJwtPart(result.stdout.trim().split('.')[1]!) as {
      iat: number;
      exp: number;
    };
    // iat = now - 60, so it must be at least 59s before our "before" timestamp
    // (allowing 1s tolerance for spawn overhead in either direction).
    expect(payload.iat).toBeLessThanOrEqual(before - 59);
    expect(payload.iat).toBeGreaterThanOrEqual(before - 61);
  });

  it('default exp - iat = 600s (= JWT_EXP_SECONDS default 540 + 60 iat skew = GitHub 10min max)', () => {
    const pem = generateTestPem();
    const result = runSignJwt({ env: { GH_APP_ID: '12345' }, input: pem });
    expect(result.status).toBe(0);
    const payload = decodeJwtPart(result.stdout.trim().split('.')[1]!) as {
      iat: number;
      exp: number;
    };
    expect(payload.exp - payload.iat).toBe(600);
  });

  it('honors JWT_EXP_SECONDS env to shorten the window (exp - iat = JWT_EXP_SECONDS + 60)', () => {
    const pem = generateTestPem();
    const result = runSignJwt({
      env: { GH_APP_ID: '12345', JWT_EXP_SECONDS: '120' },
      input: pem,
    });
    expect(result.status).toBe(0);
    const payload = decodeJwtPart(result.stdout.trim().split('.')[1]!) as {
      iat: number;
      exp: number;
    };
    expect(payload.exp - payload.iat).toBe(180);
  });
});
