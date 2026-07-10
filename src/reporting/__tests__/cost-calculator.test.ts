/**
 * `cost-calculator.ts` のユニットテスト。
 *
 * pure fn の分岐カバレッジ:
 *  - Anthropic 4 モデル (× Vertex regional 1.10、`CLOUD_ML_REGION` 依存)
 *  - Anthropic global 経路 (`CLOUD_ML_REGION=global` = premium 1.0)
 *  - Gemini 2 モデル (`PROVIDER_APPLIES_VERTEX_PREMIUM` map で常に 1.0、二重乗算しない)
 *  - cache_read / cache_creation 欠落 → 対称の warnings 返却
 *  - 未知 model → cost_usd: 0 + warnings (throw しない、silent failure 撲滅)
 *  - aggregateCosts の provider 別集計 + premiumOverride 注入
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { aggregateCosts, computeCost } from '../cost-calculator.js';
import { VERTEX_GLOBAL_PREMIUM, VERTEX_REGIONAL_PREMIUM } from '../pricing-table.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('computeCost (Anthropic 経路 × regional premium)', () => {
  it('CLOUD_ML_REGION 未指定なら sonnet-4-6 の生 cost は base × 1.10 (regional 経路)', () => {
    vi.stubEnv('CLOUD_ML_REGION', '');
    // 1M input × $3 + 1M output × $15 = $18 base、× 1.10 = $19.8
    const result = computeCost({
      model: 'claude-sonnet-4-6',
      tokens_in: 1_000_000,
      tokens_out: 1_000_000,
    });
    expect(result.provider).toBe('anthropic');
    expect(result.cost_usd).toBeCloseTo(18 * VERTEX_REGIONAL_PREMIUM, 6);
    // cache_read + cache_creation 両方 undefined = 両方 warning が付く (対称化)
    expect(result.warnings).toContain('cache_read.input_tokens not captured, cost is underestimated');
    expect(result.warnings).toContain('cache_creation.input_tokens not captured, cost is underestimated');
  });

  it('CLOUD_ML_REGION=global なら premium は 1.0 (Global endpoint 経路)', () => {
    vi.stubEnv('CLOUD_ML_REGION', 'global');
    const result = computeCost({
      model: 'claude-sonnet-4-6',
      tokens_in: 1_000_000,
      tokens_out: 1_000_000,
      cache_read: 0,
      cache_creation: 0,
    });
    expect(result.cost_usd).toBeCloseTo(18 * VERTEX_GLOBAL_PREMIUM, 6);
    expect(result.warnings).toEqual([]);
  });

  it('premiumOverride は env より優先される (DI)', () => {
    vi.stubEnv('CLOUD_ML_REGION', 'asia-northeast1'); // regional 相当
    const result = computeCost(
      { model: 'claude-sonnet-4-6', tokens_in: 1_000_000, tokens_out: 0, cache_read: 0, cache_creation: 0 },
      { premiumOverride: 1.0 },
    );
    expect(result.cost_usd).toBeCloseTo(3 * 1.0, 6); // 1M in × $3 × 1.0
  });

  it('cache_read が非 0 なら加算される (× premium)', () => {
    vi.stubEnv('CLOUD_ML_REGION', 'asia-northeast1');
    // 0 in + 0 out + 1M cache_read × $0.3 = $0.3 base、× 1.10 = $0.33
    const result = computeCost({
      model: 'claude-sonnet-4-6',
      tokens_in: 0,
      tokens_out: 0,
      cache_read: 1_000_000,
      cache_creation: 0,
    });
    expect(result.cost_usd).toBeCloseTo(0.3 * VERTEX_REGIONAL_PREMIUM, 6);
    expect(result.warnings).toEqual([]); // 両方明示 0 なら warning は付かない
  });

  it('cache_read/cache_creation が明示 0 なら warnings に cache 系警告が付かない', () => {
    vi.stubEnv('CLOUD_ML_REGION', 'asia-northeast1');
    const result = computeCost({
      model: 'claude-haiku-4-5',
      tokens_in: 1000,
      tokens_out: 1000,
      cache_read: 0,
      cache_creation: 0,
    });
    expect(result.warnings).toEqual([]);
  });

  it('cache_creation が指定されていれば cost に反映される', () => {
    vi.stubEnv('CLOUD_ML_REGION', 'asia-northeast1');
    // 0 in + 0 out + 0 cache_read + 1M cache_write × $3.75 = $3.75 base、× 1.10 = $4.125
    const result = computeCost({
      model: 'claude-sonnet-4-6',
      tokens_in: 0,
      tokens_out: 0,
      cache_read: 0,
      cache_creation: 1_000_000,
    });
    expect(result.cost_usd).toBeCloseTo(3.75 * VERTEX_REGIONAL_PREMIUM, 6);
  });

  it('opus-4-8 の cost は sonnet-4-6 の約 1.667 倍 (基本料金比 $5:$3 / $25:$15)', () => {
    vi.stubEnv('CLOUD_ML_REGION', 'asia-northeast1');
    const sonnet = computeCost({
      model: 'claude-sonnet-4-6',
      tokens_in: 1_000_000,
      tokens_out: 0,
      cache_read: 0,
      cache_creation: 0,
    });
    const opus = computeCost({
      model: 'claude-opus-4-8',
      tokens_in: 1_000_000,
      tokens_out: 0,
      cache_read: 0,
      cache_creation: 0,
    });
    expect(opus.cost_usd / sonnet.cost_usd).toBeCloseTo(5 / 3, 5);
  });

  it('haiku-4-5 の cost は sonnet-4-6 の約 1/3 倍 (基本料金比 $1:$3)', () => {
    vi.stubEnv('CLOUD_ML_REGION', 'asia-northeast1');
    const sonnet = computeCost({
      model: 'claude-sonnet-4-6',
      tokens_in: 1_000_000,
      tokens_out: 0,
      cache_read: 0,
      cache_creation: 0,
    });
    const haiku = computeCost({
      model: 'claude-haiku-4-5',
      tokens_in: 1_000_000,
      tokens_out: 0,
      cache_read: 0,
      cache_creation: 0,
    });
    expect(haiku.cost_usd / sonnet.cost_usd).toBeCloseTo(1 / 3, 5);
  });
});

describe('computeCost (Gemini 経路、常に premium 1.0)', () => {
  it('CLOUD_ML_REGION に関わらず Gemini 単価表通り (二重乗算しない)', () => {
    vi.stubEnv('CLOUD_ML_REGION', 'asia-northeast1'); // regional でも premium 非適用
    // 1M in × $0.30 + 1M out × $2.50 = $2.80 (× 1.10 しない)
    const result = computeCost({
      model: 'gemini-2.5-flash',
      tokens_in: 1_000_000,
      tokens_out: 1_000_000,
    });
    expect(result.provider).toBe('gemini');
    expect(result.cost_usd).toBeCloseTo(2.8, 6);
    expect(result.warnings).toEqual([]); // cache 概念なし、warning なし
  });

  it('CLOUD_ML_REGION=global でも Gemini 単価は不変', () => {
    vi.stubEnv('CLOUD_ML_REGION', 'global');
    const result = computeCost({
      model: 'gemini-2.5-flash',
      tokens_in: 1_000_000,
      tokens_out: 1_000_000,
    });
    expect(result.cost_usd).toBeCloseTo(2.8, 6);
  });

  it('gemini-3.1-flash-lite の cost は Vertex Global 単価で計算 (M4-C Phase 2 修正)', () => {
    vi.stubEnv('CLOUD_ML_REGION', 'global');
    // 1M in × $0.25 + 1M out × $1.5 = $1.75
    // Gemini は PROVIDER_APPLIES_VERTEX_PREMIUM.gemini = false のため region に依らず premium 非適用。
    // pricing-table 側で Global 単価を hardcode するようになった (2026-07-09)。
    const result = computeCost({
      model: 'gemini-3.1-flash-lite',
      tokens_in: 1_000_000,
      tokens_out: 1_000_000,
    });
    expect(result.cost_usd).toBeCloseTo(1.75, 6);
  });

  it('Gemini の breakdown は cache_read / cache_write が常に 0', () => {
    const result = computeCost({
      model: 'gemini-2.5-flash',
      tokens_in: 100,
      tokens_out: 100,
      cache_read: 999, // Gemini では無視される
      cache_creation: 999,
    });
    expect(result.breakdown.cache_read).toBe(0);
    expect(result.breakdown.cache_write).toBe(0);
  });
});

describe('computeCost (未知 model)', () => {
  it('cost_usd: 0 + warnings に unknown_model を含める (throw しない)', () => {
    const result = computeCost({
      model: 'gpt-999-turbo-preview-legacy',
      tokens_in: 1_000_000,
      tokens_out: 1_000_000,
    });
    expect(result.cost_usd).toBe(0);
    expect(result.provider).toBe('unknown');
    expect(result.warnings).toEqual(['unknown_model: gpt-999-turbo-preview-legacy']);
  });
});

describe('aggregateCosts', () => {
  it('provider 別に集計され total_usd = 各 provider の合算 (regional premium 適用)', () => {
    vi.stubEnv('CLOUD_ML_REGION', 'asia-northeast1');
    const agg = aggregateCosts([
      { model: 'claude-sonnet-4-6', tokens_in: 1_000_000, tokens_out: 0, cache_read: 0, cache_creation: 0 },
      { model: 'gemini-2.5-flash', tokens_in: 1_000_000, tokens_out: 1_000_000 },
      { model: 'unknown-model', tokens_in: 100, tokens_out: 100 },
    ]);
    expect(agg.anthropic_usd).toBeCloseTo(3 * VERTEX_REGIONAL_PREMIUM, 6); // sonnet 1M in
    expect(agg.gemini_usd).toBeCloseTo(2.8, 6); // 2.5 flash
    expect(agg.unknown_usd).toBe(0);
    expect(agg.total_usd).toBeCloseTo(3 * VERTEX_REGIONAL_PREMIUM + 2.8, 6);
    expect(agg.warnings).toContain('unknown_model: unknown-model');
  });

  it('CLOUD_ML_REGION=global なら Anthropic 側は premium 非適用', () => {
    vi.stubEnv('CLOUD_ML_REGION', 'global');
    const agg = aggregateCosts([
      { model: 'claude-sonnet-4-6', tokens_in: 1_000_000, tokens_out: 0, cache_read: 0, cache_creation: 0 },
    ]);
    expect(agg.anthropic_usd).toBeCloseTo(3, 6); // 1M in × $3 × 1.0
  });

  it('premiumOverride は aggregate 経由でも尊重される', () => {
    vi.stubEnv('CLOUD_ML_REGION', 'asia-northeast1');
    const agg = aggregateCosts(
      [{ model: 'claude-sonnet-4-6', tokens_in: 1_000_000, tokens_out: 0, cache_read: 0, cache_creation: 0 }],
      { premiumOverride: 1.0 },
    );
    expect(agg.anthropic_usd).toBeCloseTo(3, 6);
  });

  it('空 rows は total_usd 0 + warnings 空', () => {
    const agg = aggregateCosts([]);
    expect(agg.total_usd).toBe(0);
    expect(agg.anthropic_usd).toBe(0);
    expect(agg.gemini_usd).toBe(0);
    expect(agg.warnings).toEqual([]);
  });

  it('同じ warning が複数 rows で発生しても Set で重複排除', () => {
    vi.stubEnv('CLOUD_ML_REGION', 'asia-northeast1');
    const agg = aggregateCosts([
      { model: 'claude-sonnet-4-6', tokens_in: 100, tokens_out: 100 }, // cache_read/creation undefined
      { model: 'claude-haiku-4-5', tokens_in: 100, tokens_out: 100 }, // 同じ warning が付く
    ]);
    const cacheReadWarnings = agg.warnings.filter((w) => w.includes('cache_read'));
    const cacheCreationWarnings = agg.warnings.filter((w) => w.includes('cache_creation'));
    expect(cacheReadWarnings.length).toBe(1);
    expect(cacheCreationWarnings.length).toBe(1);
  });
});
