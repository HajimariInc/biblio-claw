/**
 * `formatter.ts` のユニットテスト。
 *
 * カバレッジ:
 *  - empty result (全 4 種空) → 各セクションが「活動なし」or「呼出記録なし」
 *  - normal case (biblio + llmCost あり)
 *  - BigQueryInt shape ({value: string}) の coerce
 *  - unknown model warning が Slack DM 本文に「※」で注記される
 *  - inspect-distribution / error-trend は雛形固定文言 (Phase 2 実装予定)
 */
import { describe, expect, it } from 'vitest';

import { formatBiblioUsageSummary } from '../formatter.js';

describe('formatBiblioUsageSummary — empty result', () => {
  it('全 4 種空 → 「活動なし」+「呼出記録なし」+ 雛形メッセージ', () => {
    const text = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: [],
      inspect: [],
      errorTrend: [],
      llmCost: [],
    });
    expect(text).toContain('直近 7 日');
    expect(text).toContain('biblio 利用: 活動なし');
    expect(text).toContain('検品分布: Phase 2 で実装');
    expect(text).toContain('エラー傾向: Phase 2 で実装');
    expect(text).toContain('LLM コスト: 呼出記録なし');
  });
});

describe('formatBiblioUsageSummary — normal case', () => {
  it('biblio rows は action ごとに outcome 別 cnt を集計する', () => {
    const text = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: [
        { action: 'acquire', outcome: 'success', cnt: 5 },
        { action: 'acquire', outcome: 'failure', cnt: 2 },
        { action: 'inspect', outcome: 'success', cnt: 10 },
      ],
      inspect: [],
      errorTrend: [],
      llmCost: [],
    });
    expect(text).toContain('acquire 7 件');
    expect(text).toContain('success 5');
    expect(text).toContain('failure 2');
    expect(text).toContain('inspect 10 件');
  });

  it('llmCost rows は合算 cost + provider 別 breakdown を表示する', () => {
    const text = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: [],
      inspect: [],
      errorTrend: [],
      llmCost: [
        {
          model: 'gemini-2.5-flash',
          call_count: 100,
          total_tokens_in: 1_000_000,
          total_tokens_out: 500_000,
        },
      ],
    });
    // 1M in × 0.3 + 0.5M out × 2.5 = 0.3 + 1.25 = $1.55
    expect(text).toContain('LLM コスト: $1.55'); // toFixed(4) の先頭一致で最小 assert
    expect(text).toContain('Anthropic $0.0000');
    expect(text).toContain('Gemini $1.5500');
    expect(text).toContain('呼出 100 回');
    expect(text).toContain('1 model');
  });

  it('複数 model の場合 model count は set 集計で正しく数える', () => {
    const text = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: [],
      inspect: [],
      errorTrend: [],
      llmCost: [
        { model: 'gemini-2.5-flash', call_count: 10, total_tokens_in: 1000, total_tokens_out: 1000 },
        { model: 'claude-sonnet-4-6', call_count: 20, total_tokens_in: 2000, total_tokens_out: 2000 },
      ],
    });
    expect(text).toContain('呼出 30 回');
    expect(text).toContain('2 model');
  });
});

describe('formatBiblioUsageSummary — BigQueryInt shape の coerce', () => {
  it('cnt が {value: string} 形式で来ても Number 化される', () => {
    const text = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: [
        // BQ v8 client は SUM(INT64) を BigQueryInt (`{value: string}`) で返すケースあり
        { action: 'acquire', outcome: 'success', cnt: { value: '42' } },
      ] as unknown[],
      inspect: [],
      errorTrend: [],
      llmCost: [],
    });
    expect(text).toContain('acquire 42 件');
    expect(text).toContain('success 42');
  });

  it('numeric string ("100" 等) も Number 化される', () => {
    const text = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: [{ action: 'inspect', outcome: 'success', cnt: '100' }] as unknown[],
      inspect: [],
      errorTrend: [],
      llmCost: [],
    });
    expect(text).toContain('inspect 100 件');
  });
});

describe('formatBiblioUsageSummary — unknown model warning', () => {
  it('unknown model が含まれる場合、Slack 本文に「※ unknown_model」注記される', () => {
    const text = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: [],
      inspect: [],
      errorTrend: [],
      llmCost: [{ model: 'gpt-4o-mini', call_count: 1, total_tokens_in: 100, total_tokens_out: 100 }],
    });
    expect(text).toContain('unknown_model');
    expect(text).toContain('gpt-4o-mini');
    expect(text).toContain('未知 model 検知');
  });

  it('Anthropic の場合、cache_creation 欠落 warning が本文に注記される', () => {
    const text = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: [],
      inspect: [],
      errorTrend: [],
      llmCost: [
        {
          model: 'claude-sonnet-4-6',
          call_count: 1,
          total_tokens_in: 100,
          total_tokens_out: 100,
          // total_cache_creation を含めない = undefined = warning が付く
        },
      ],
    });
    expect(text).toContain('cache_creation');
    expect(text).toContain('underestimated');
  });
});

describe('formatBiblioUsageSummary — action sort', () => {
  it('action は alphabetical 順に並ぶ (呼出順に依存しない)', () => {
    const text = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: [
        { action: 'shelve', outcome: 'success', cnt: 1 },
        { action: 'acquire', outcome: 'success', cnt: 2 },
        { action: 'list', outcome: 'success', cnt: 3 },
      ],
      inspect: [],
      errorTrend: [],
      llmCost: [],
    });
    const acquireIdx = text.indexOf('acquire');
    const listIdx = text.indexOf('list');
    const shelveIdx = text.indexOf('shelve');
    expect(acquireIdx).toBeGreaterThan(0);
    expect(acquireIdx).toBeLessThan(listIdx);
    expect(listIdx).toBeLessThan(shelveIdx);
  });
});
