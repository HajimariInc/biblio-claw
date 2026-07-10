/**
 * `pricing-table.ts` のユニットテスト。
 *
 * 目的: 単価表の値を pin し、単価改定に気付かず SQL cost 集計が silent に狂うのを防ぐ。
 * 2026-07-09 時点の値を assert で pin する (regression 検出用)。
 *
 * SOURCE:
 *  - Anthropic:  https://platform.claude.com/docs/en/about-claude/pricing#model-pricing
 *  - Vertex premium: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude
 *  - Gemini:    https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-flash-lite/
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ANTHROPIC_PRICING,
  GEMINI_PRICING,
  PROVIDER_APPLIES_VERTEX_PREMIUM,
  VERTEX_GLOBAL_PREMIUM,
  VERTEX_REGIONAL_PREMIUM,
  isAnthropicModel,
  isGeminiModel,
  resolveVertexPremium,
} from '../pricing-table.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ANTHROPIC_PRICING (2026-07-09 単価値 pinning)', () => {
  it('claude-sonnet-4-6 は $3/$15、cache_read $0.3、cache_write $3.75', () => {
    expect(ANTHROPIC_PRICING['claude-sonnet-4-6']).toEqual({
      input: 3,
      output: 15,
      cache_read: 0.3,
      cache_write: 3.75,
    });
  });

  it('claude-opus-4-7 は $5/$25、cache_read $0.5、cache_write $6.25', () => {
    expect(ANTHROPIC_PRICING['claude-opus-4-7']).toEqual({
      input: 5,
      output: 25,
      cache_read: 0.5,
      cache_write: 6.25,
    });
  });

  it('claude-opus-4-8 は $5/$25 (4-7 と同単価)', () => {
    expect(ANTHROPIC_PRICING['claude-opus-4-8']).toEqual({
      input: 5,
      output: 25,
      cache_read: 0.5,
      cache_write: 6.25,
    });
  });

  it('claude-haiku-4-5 は $1/$5、cache_read $0.1、cache_write $1.25', () => {
    expect(ANTHROPIC_PRICING['claude-haiku-4-5']).toEqual({
      input: 1,
      output: 5,
      cache_read: 0.1,
      cache_write: 1.25,
    });
  });

  it('Opus 4.7 Fast mode ($30/$150) を含まない (2026-07-24 廃止予定のため table に載せない)', () => {
    for (const [_model, price] of Object.entries(ANTHROPIC_PRICING)) {
      expect(price.input).toBeLessThanOrEqual(5);
      expect(price.output).toBeLessThanOrEqual(25);
    }
  });
});

describe('VERTEX_REGIONAL_PREMIUM / VERTEX_GLOBAL_PREMIUM', () => {
  it('regional premium = 1.10 (base × 10% 上乗せ)', () => {
    expect(VERTEX_REGIONAL_PREMIUM).toBe(1.1);
  });

  it('global premium = 1.0 (base 価格経路、premium なし)', () => {
    expect(VERTEX_GLOBAL_PREMIUM).toBe(1.0);
  });
});

describe('resolveVertexPremium (CLOUD_ML_REGION env で切替)', () => {
  it('CLOUD_ML_REGION=global → 1.0 (Global endpoint 経路)', () => {
    vi.stubEnv('CLOUD_ML_REGION', 'global');
    expect(resolveVertexPremium()).toBe(VERTEX_GLOBAL_PREMIUM);
  });

  it('CLOUD_ML_REGION 未設定 → 1.10 (regional 経路の保守側 default)', () => {
    vi.stubEnv('CLOUD_ML_REGION', '');
    expect(resolveVertexPremium()).toBe(VERTEX_REGIONAL_PREMIUM);
  });

  it('CLOUD_ML_REGION=asia-northeast1 等の regional は 1.10', () => {
    vi.stubEnv('CLOUD_ML_REGION', 'asia-northeast1');
    expect(resolveVertexPremium()).toBe(VERTEX_REGIONAL_PREMIUM);
  });

  it('大文字 GLOBAL でも正しく判定 (trim + lowercase 正規化)', () => {
    vi.stubEnv('CLOUD_ML_REGION', ' GLOBAL ');
    expect(resolveVertexPremium()).toBe(VERTEX_GLOBAL_PREMIUM);
  });
});

describe('PROVIDER_APPLIES_VERTEX_PREMIUM (不変条件を型で強制)', () => {
  it('Anthropic は premium 適用対象 (true)', () => {
    expect(PROVIDER_APPLIES_VERTEX_PREMIUM.anthropic).toBe(true);
  });

  it('Gemini は premium 非適用 (false、単価表に組込済のため二重乗算しない)', () => {
    expect(PROVIDER_APPLIES_VERTEX_PREMIUM.gemini).toBe(false);
  });
});

describe('GEMINI_PRICING (M4-C Phase 2: Vertex Global 単価、2026-07-09 pinning)', () => {
  it('gemini-2.5-flash は $0.30/$2.50 (Vertex Global 単価)', () => {
    expect(GEMINI_PRICING['gemini-2.5-flash']).toEqual({ input: 0.3, output: 2.5 });
  });

  it('gemini-3.1-flash-lite は $0.25/$1.50 (Vertex Global 単価、biblio-claw は CLOUD_ML_REGION=global)', () => {
    expect(GEMINI_PRICING['gemini-3.1-flash-lite']).toEqual({ input: 0.25, output: 1.5 });
  });

  it('preview サフィックス model を含まない (`-preview` は 2026-07-09 廃止)', () => {
    for (const model of Object.keys(GEMINI_PRICING)) {
      expect(model).not.toContain('-preview');
    }
  });
});

describe('isAnthropicModel / isGeminiModel type guards', () => {
  it('isAnthropicModel は Anthropic model 名を true に判定', () => {
    expect(isAnthropicModel('claude-sonnet-4-6')).toBe(true);
    expect(isAnthropicModel('claude-opus-4-7')).toBe(true);
    expect(isAnthropicModel('gemini-2.5-flash')).toBe(false);
    expect(isAnthropicModel('unknown-model')).toBe(false);
  });

  it('isGeminiModel は Gemini model 名を true に判定', () => {
    expect(isGeminiModel('gemini-2.5-flash')).toBe(true);
    expect(isGeminiModel('gemini-3.1-flash-lite')).toBe(true);
    expect(isGeminiModel('claude-sonnet-4-6')).toBe(false);
    expect(isGeminiModel('unknown-model')).toBe(false);
  });
});
