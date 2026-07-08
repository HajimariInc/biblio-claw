/**
 * Fugue ask rate limit helper の unit test。
 *
 * sliding window boundary / GC / retryAfterSec / disable escape hatch / Map key 分離 /
 * env override / tokenDigest / isFugueAskRateLimitDisabled の 10 case を assert。
 *
 * fake timers を使わない (helper が `nowMs` 引数を受け取る同期関数のため、明示指定で
 * 決定性を確保できる)。beforeEach で必ず `_resetFugueRateLimitForTest()` + env 3 種の
 * delete を実施 (test 間の状態隔離、globals 汚染防止)。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetFugueRateLimitForTest,
  checkFugueAskRateLimit,
  FUGUE_ASK_RATE_DEFAULT_POINTS,
  FUGUE_ASK_RATE_DEFAULT_WINDOW_MS,
  isFugueAskRateLimitDisabled,
  resolveFugueAskRatePoints,
  resolveFugueAskRateWindowMs,
  tokenDigest,
} from './fugue-rate-limit.js';

beforeEach(() => {
  _resetFugueRateLimitForTest();
  delete process.env.FUGUE_ASK_RATE_DISABLE;
  delete process.env.FUGUE_ASK_RATE_POINTS;
  delete process.env.FUGUE_ASK_RATE_WINDOW_MS;
});

describe('checkFugueAskRateLimit', () => {
  const DIGEST_A = 'a'.repeat(32);
  const DIGEST_B = 'b'.repeat(32);

  it('allows first 60 requests within 1 min window', () => {
    for (let i = 0; i < 60; i++) {
      const r = checkFugueAskRateLimit(DIGEST_A, 1_000_000);
      expect(r.allowed).toBe(true);
    }
  });

  it('rejects 61st request with retryAfterSec >= 1', () => {
    for (let i = 0; i < 60; i++) {
      checkFugueAskRateLimit(DIGEST_A, 1_000_000);
    }
    const r = checkFugueAskRateLimit(DIGEST_A, 1_000_000);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.retryAfterSec).toBeGreaterThanOrEqual(1);
      expect(r.retryAfterSec).toBeLessThanOrEqual(60);
    }
  });

  it('GC: after window expiration, old timestamps are pruned and new req allowed', () => {
    for (let i = 0; i < 60; i++) {
      checkFugueAskRateLimit(DIGEST_A, 1_000_000);
    }
    // 60_001ms 経過 = window (60_000ms) を超えた
    const r = checkFugueAskRateLimit(DIGEST_A, 1_060_001);
    expect(r.allowed).toBe(true);
  });

  it('key separation: different digests have independent windows', () => {
    for (let i = 0; i < 60; i++) {
      const rA = checkFugueAskRateLimit(DIGEST_A, 1_000_000);
      expect(rA.allowed).toBe(true);
    }
    // DIGEST_A は 60/60 使い切ったが、DIGEST_B は独立で 60 まで allow
    for (let i = 0; i < 60; i++) {
      const rB = checkFugueAskRateLimit(DIGEST_B, 1_000_000);
      expect(rB.allowed).toBe(true);
    }
  });

  it('retryAfterSec: computed from oldest timestamp + windowMs - now (30s past → ~30s)', () => {
    for (let i = 0; i < 60; i++) {
      checkFugueAskRateLimit(DIGEST_A, 1_000_000);
    }
    // 30 秒経過 = 最古 timestamp + windowMs - now = 1_000_000 + 60_000 - 1_030_000 = 30_000ms = 30s
    const r = checkFugueAskRateLimit(DIGEST_A, 1_030_000);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.retryAfterSec).toBe(30);
    }
  });

  it('disable escape hatch: FUGUE_ASK_RATE_DISABLE=1 skips all check', () => {
    process.env.FUGUE_ASK_RATE_DISABLE = '1';
    for (let i = 0; i < 100; i++) {
      const r = checkFugueAskRateLimit(DIGEST_A, 1_000_000);
      expect(r.allowed).toBe(true);
    }
  });

  it('env override: FUGUE_ASK_RATE_POINTS=10 limits at 10 req', () => {
    process.env.FUGUE_ASK_RATE_POINTS = '10';
    for (let i = 0; i < 10; i++) {
      const r = checkFugueAskRateLimit(DIGEST_A, 1_000_000);
      expect(r.allowed).toBe(true);
    }
    const r = checkFugueAskRateLimit(DIGEST_A, 1_000_000);
    expect(r.allowed).toBe(false);
  });

  it('env override: FUGUE_ASK_RATE_WINDOW_MS=1000 rejects with retryAfterSec ~1', () => {
    process.env.FUGUE_ASK_RATE_POINTS = '10';
    process.env.FUGUE_ASK_RATE_WINDOW_MS = '1000';
    // 1 秒 window で 10 req、11 req 目 reject
    for (let i = 0; i < 10; i++) {
      checkFugueAskRateLimit(DIGEST_A, 1_000_000);
    }
    const r = checkFugueAskRateLimit(DIGEST_A, 1_000_000);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      // 全 req が同時刻 (1_000_000) なら retryAfterSec = ceil((1_000_000 + 1000 - 1_000_000) / 1000) = 1
      expect(r.retryAfterSec).toBe(1);
    }
  });

  it('defensive: points=0 override は NaN 汚染せず 1 秒 backoff で fail-closed (review 提案 1 対応)', () => {
    // 明示 points=0 は resolveFugueAskRatePoints が到達させない (>0 フィルタ) が、直接
    // 引数で渡すと以前は `filtered.length < 0 === false` → 拒否経路の `filtered[0]=undefined` →
    // retryAfterSec=NaN の silent 汚染が発生していた。修正後は `limit <= 0` guard で 1 秒
    // backoff を返す (0 point = 永久拒否の意図と一致、client の即時再送ループも防ぐ)。
    const r = checkFugueAskRateLimit(DIGEST_A, 1_000_000, 0);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.retryAfterSec).toBe(1);
      expect(Number.isNaN(r.retryAfterSec)).toBe(false);
    }
  });

  it('defensive: points=-5 override も同じく NaN 汚染せず fail-closed', () => {
    const r = checkFugueAskRateLimit(DIGEST_A, 1_000_000, -5);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.retryAfterSec).toBe(1);
    }
  });
});

describe('tokenDigest', () => {
  it('returns 32 hex char sha256 truncation', () => {
    const d = tokenDigest('test-token');
    expect(d.length).toBe(32);
    expect(/^[0-9a-f]{32}$/.test(d)).toBe(true);
  });

  it('different tokens produce different digests', () => {
    expect(tokenDigest('a')).not.toBe(tokenDigest('b'));
  });

  it('same token produces same digest (idempotent)', () => {
    expect(tokenDigest('same-input')).toBe(tokenDigest('same-input'));
  });
});

describe('isFugueAskRateLimitDisabled', () => {
  it('returns true for "1"', () => {
    process.env.FUGUE_ASK_RATE_DISABLE = '1';
    expect(isFugueAskRateLimitDisabled()).toBe(true);
  });

  it('returns true for "true"', () => {
    process.env.FUGUE_ASK_RATE_DISABLE = 'true';
    expect(isFugueAskRateLimitDisabled()).toBe(true);
  });

  it('returns false for "0"', () => {
    process.env.FUGUE_ASK_RATE_DISABLE = '0';
    expect(isFugueAskRateLimitDisabled()).toBe(false);
  });

  it('returns false for "" (empty) and undefined', () => {
    process.env.FUGUE_ASK_RATE_DISABLE = '';
    expect(isFugueAskRateLimitDisabled()).toBe(false);
    delete process.env.FUGUE_ASK_RATE_DISABLE;
    expect(isFugueAskRateLimitDisabled()).toBe(false);
  });
});

describe('resolveFugueAskRatePoints', () => {
  it('returns default when env unset', () => {
    expect(resolveFugueAskRatePoints()).toBe(FUGUE_ASK_RATE_DEFAULT_POINTS);
  });

  it('returns env value when finite positive', () => {
    process.env.FUGUE_ASK_RATE_POINTS = '30';
    expect(resolveFugueAskRatePoints()).toBe(30);
  });

  it('falls back to default for invalid values (NaN / negative / zero / empty)', () => {
    process.env.FUGUE_ASK_RATE_POINTS = '1a';
    expect(resolveFugueAskRatePoints()).toBe(FUGUE_ASK_RATE_DEFAULT_POINTS);
    process.env.FUGUE_ASK_RATE_POINTS = '-5';
    expect(resolveFugueAskRatePoints()).toBe(FUGUE_ASK_RATE_DEFAULT_POINTS);
    process.env.FUGUE_ASK_RATE_POINTS = '0';
    expect(resolveFugueAskRatePoints()).toBe(FUGUE_ASK_RATE_DEFAULT_POINTS);
    process.env.FUGUE_ASK_RATE_POINTS = '';
    expect(resolveFugueAskRatePoints()).toBe(FUGUE_ASK_RATE_DEFAULT_POINTS);
  });
});

describe('resolveFugueAskRateWindowMs', () => {
  it('returns default when env unset', () => {
    expect(resolveFugueAskRateWindowMs()).toBe(FUGUE_ASK_RATE_DEFAULT_WINDOW_MS);
  });

  it('returns env value when finite positive', () => {
    process.env.FUGUE_ASK_RATE_WINDOW_MS = '5000';
    expect(resolveFugueAskRateWindowMs()).toBe(5000);
  });

  it('falls back to default for invalid values', () => {
    process.env.FUGUE_ASK_RATE_WINDOW_MS = 'abc';
    expect(resolveFugueAskRateWindowMs()).toBe(FUGUE_ASK_RATE_DEFAULT_WINDOW_MS);
    process.env.FUGUE_ASK_RATE_WINDOW_MS = '-100';
    expect(resolveFugueAskRateWindowMs()).toBe(FUGUE_ASK_RATE_DEFAULT_WINDOW_MS);
  });
});
