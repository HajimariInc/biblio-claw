/**
 * `cost-calculator.ts` のユニットテスト。
 *
 * pure fn の分岐カバレッジ:
 *  - Anthropic 4 モデル (× Vertex regional 1.10)
 *  - Gemini 2 モデル (単価に premium 組込済 = 二重乗算しない)
 *  - cache_read 加算
 *  - cache_creation 欠落 → warnings 返却
 *  - 未知 model → cost_usd: 0 + warnings (throw しない、silent failure 撲滅)
 *  - aggregateCosts の provider 別集計
 */
import { describe, expect, it } from 'vitest';

import { aggregateCosts, computeCost } from '../cost-calculator.js';
import { VERTEX_REGIONAL_PREMIUM } from '../pricing-table.js';

describe('computeCost (Anthropic 経路)', () => {
  it('sonnet-4-6 の生 cost は base × 1.10 (Vertex regional premium)', () => {
    // 1M input × $3 + 1M output × $15 = $18 base、× 1.10 = $19.8
    const result = computeCost({
      model: 'claude-sonnet-4-6',
      tokens_in: 1_000_000,
      tokens_out: 1_000_000,
    });
    expect(result.provider).toBe('anthropic');
    expect(result.cost_usd).toBeCloseTo(18 * VERTEX_REGIONAL_PREMIUM, 6);
    // cache_creation undefined = warning が付く
    expect(result.warnings).toContain('cache_creation.input_tokens not captured, cost is underestimated');
  });

  it('cache_read が非 0 なら加算される (× premium)', () => {
    // 0 in + 0 out + 1M cache_read × $0.3 = $0.3 base、× 1.10 = $0.33
    const result = computeCost({
      model: 'claude-sonnet-4-6',
      tokens_in: 0,
      tokens_out: 0,
      cache_read: 1_000_000,
      // cache_creation 明示 0 で warning を消す (undefined と 0 の分岐確認)
      cache_creation: 0,
    });
    expect(result.cost_usd).toBeCloseTo(0.3 * VERTEX_REGIONAL_PREMIUM, 6);
    expect(result.warnings).toEqual([]); // cache_creation: 0 (明示) なら warning は付かない
  });

  it('cache_creation が明示 0 なら warnings に cache_creation 警告が付かない', () => {
    const result = computeCost({
      model: 'claude-haiku-4-5',
      tokens_in: 1000,
      tokens_out: 1000,
      cache_creation: 0,
    });
    expect(result.warnings).toEqual([]);
  });

  it('cache_creation が指定されていれば cost に反映される', () => {
    // 0 in + 0 out + 0 cache_read + 1M cache_write × $3.75 = $3.75 base、× 1.10 = $4.125
    const result = computeCost({
      model: 'claude-sonnet-4-6',
      tokens_in: 0,
      tokens_out: 0,
      cache_creation: 1_000_000,
    });
    expect(result.cost_usd).toBeCloseTo(3.75 * VERTEX_REGIONAL_PREMIUM, 6);
  });

  it('opus-4-8 の cost は sonnet-4-6 の約 1.667 倍 (基本料金比 $5:$3 / $25:$15)', () => {
    const sonnet = computeCost({ model: 'claude-sonnet-4-6', tokens_in: 1_000_000, tokens_out: 0, cache_creation: 0 });
    const opus = computeCost({ model: 'claude-opus-4-8', tokens_in: 1_000_000, tokens_out: 0, cache_creation: 0 });
    expect(opus.cost_usd / sonnet.cost_usd).toBeCloseTo(5 / 3, 5);
  });

  it('haiku-4-5 の cost は sonnet-4-6 の約 1/3 倍 (基本料金比 $1:$3)', () => {
    const sonnet = computeCost({ model: 'claude-sonnet-4-6', tokens_in: 1_000_000, tokens_out: 0, cache_creation: 0 });
    const haiku = computeCost({ model: 'claude-haiku-4-5', tokens_in: 1_000_000, tokens_out: 0, cache_creation: 0 });
    expect(haiku.cost_usd / sonnet.cost_usd).toBeCloseTo(1 / 3, 5);
  });
});

describe('computeCost (Gemini 経路)', () => {
  it('gemini-2.5-flash の cost は単価表通り (Vertex premium 二重乗算しない)', () => {
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

  it('gemini-3.1-flash-lite の cost は non-global +10% 反映済単価で計算', () => {
    // 1M in × $0.275 + 1M out × $1.65 = $1.925
    const result = computeCost({
      model: 'gemini-3.1-flash-lite',
      tokens_in: 1_000_000,
      tokens_out: 1_000_000,
    });
    expect(result.cost_usd).toBeCloseTo(1.925, 6);
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
  it('provider 別に集計され total_usd = 各 provider の合算', () => {
    const agg = aggregateCosts([
      { model: 'claude-sonnet-4-6', tokens_in: 1_000_000, tokens_out: 0, cache_creation: 0 },
      { model: 'gemini-2.5-flash', tokens_in: 1_000_000, tokens_out: 1_000_000 },
      { model: 'unknown-model', tokens_in: 100, tokens_out: 100 },
    ]);
    expect(agg.anthropic_usd).toBeCloseTo(3 * VERTEX_REGIONAL_PREMIUM, 6); // sonnet 1M in
    expect(agg.gemini_usd).toBeCloseTo(2.8, 6); // 2.5 flash
    expect(agg.unknown_usd).toBe(0);
    expect(agg.total_usd).toBeCloseTo(3 * VERTEX_REGIONAL_PREMIUM + 2.8, 6);
    expect(agg.warnings).toContain('unknown_model: unknown-model');
  });

  it('空 rows は total_usd 0 + warnings 空', () => {
    const agg = aggregateCosts([]);
    expect(agg.total_usd).toBe(0);
    expect(agg.anthropic_usd).toBe(0);
    expect(agg.gemini_usd).toBe(0);
    expect(agg.warnings).toEqual([]);
  });

  it('同じ warning が複数 rows で発生しても Set で重複排除', () => {
    const agg = aggregateCosts([
      { model: 'claude-sonnet-4-6', tokens_in: 100, tokens_out: 100 }, // cache_creation undefined
      { model: 'claude-haiku-4-5', tokens_in: 100, tokens_out: 100 }, // 同じ warning が付く
    ]);
    const cacheWarnings = agg.warnings.filter((w) => w.includes('cache_creation'));
    expect(cacheWarnings.length).toBe(1);
  });
});
