/**
 * `formatter.ts` のユニットテスト。
 *
 * カバレッジ:
 *  - QueryOutcome.ok=true empty rows → 各セクションが「活動なし」or「呼出記録なし」
 *  - QueryOutcome.ok=false → 各セクションが「⚠️ 取得失敗」を出す (SQL 失敗と empty 区別)
 *  - normal case (biblio + llmCost あり)
 *  - BigQueryInt coerce
 *  - unknown model warning が Slack DM 本文に「※」で注記される
 *  - inspect-distribution / error-trend は雛形固定文言 (Phase 2 実装予定)
 *  - formatter 内 warnings (silent 0 丸め検知) が本文末尾に「⚠️ データ整形 warning: ...」で追記
 */
import { describe, expect, it } from 'vitest';

import { formatBiblioUsageSummary, type QueryOutcome } from '../formatter.js';

// テスト用 helper: 成功 rows を QueryOutcome で包む
const ok = <T>(rows: T[]): QueryOutcome<T> => ({ ok: true, rows });
const emptyOk = (): QueryOutcome => ok<unknown>([]);
const fail = (): QueryOutcome => ({ ok: false });

describe('formatBiblioUsageSummary — 全 4 種 empty (ok:true, rows:[])', () => {
  it('全 4 種空 → 「活動なし」+「呼出記録なし」+ 検品/エラー empty 文言 (M4-C Phase 2 で確定)', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: emptyOk(),
      inspect: emptyOk(),
      errorTrend: emptyOk(),
      llmCost: emptyOk(),
    });
    expect(text).toContain('直近 7 日');
    expect(text).toContain('biblio 利用: 活動なし');
    expect(text).toContain('検品分布: 検品実行なし');
    expect(text).toContain('エラー傾向: ERROR / CRITICAL なし (順調)');
    expect(text).toContain('LLM コスト: 呼出記録なし');
  });
});

describe('formatBiblioUsageSummary — QueryOutcome.ok=false (SQL 失敗)', () => {
  it('biblio 失敗時は「⚠️ 取得失敗」を biblio セクションに表示 (empty と区別)', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: fail(),
      inspect: emptyOk(),
      errorTrend: emptyOk(),
      llmCost: emptyOk(),
    });
    expect(text).toContain('biblio 利用: ⚠️ 取得失敗');
    expect(text).toContain('Cloud Logging の reporting.biblio-usage_failed を確認');
    expect(text).not.toContain('biblio 利用: 活動なし');
  });

  it('llmCost 失敗時は「⚠️ 取得失敗」を LLM セクションに表示', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: emptyOk(),
      inspect: emptyOk(),
      errorTrend: emptyOk(),
      llmCost: fail(),
    });
    expect(text).toContain('LLM コスト: ⚠️ 取得失敗');
    expect(text).toContain('Cloud Logging の reporting.llm-cost_failed を確認');
    expect(text).not.toContain('LLM コスト: 呼出記録なし');
  });

  it('inspect / errorTrend 失敗時は empty 文言ではなく「⚠️ 取得失敗」を表示', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: emptyOk(),
      inspect: fail(),
      errorTrend: fail(),
      llmCost: emptyOk(),
    });
    expect(text).toContain('検品分布: ⚠️ 取得失敗');
    expect(text).toContain('エラー傾向: ⚠️ 取得失敗');
    expect(text).not.toContain('検品分布: 検品実行なし');
    expect(text).not.toContain('エラー傾向: ERROR なし');
  });

  it('全 4 種失敗 → 全セクションが取得失敗', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: fail(),
      inspect: fail(),
      errorTrend: fail(),
      llmCost: fail(),
    });
    const failures = text.match(/⚠️ 取得失敗/g);
    expect(failures?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});

describe('formatBiblioUsageSummary — normal case', () => {
  it('biblio rows は action ごとに outcome 別 cnt を集計する', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: ok([
        { action: 'acquire', outcome: 'success', cnt: 5 },
        { action: 'acquire', outcome: 'failure', cnt: 2 },
        { action: 'inspect', outcome: 'success', cnt: 10 },
      ]),
      inspect: emptyOk(),
      errorTrend: emptyOk(),
      llmCost: emptyOk(),
    });
    expect(text).toContain('acquire 7 件');
    expect(text).toContain('success 5');
    expect(text).toContain('failure 2');
    expect(text).toContain('inspect 10 件');
  });

  it('llmCost rows は合算 cost + provider 別 breakdown を表示する (Gemini 経路)', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: emptyOk(),
      inspect: emptyOk(),
      errorTrend: emptyOk(),
      llmCost: ok([
        {
          model: 'gemini-2.5-flash',
          call_count: 100,
          total_tokens_in: 1_000_000,
          total_tokens_out: 500_000,
        },
      ]),
    });
    // 1M in × 0.3 + 0.5M out × 2.5 = 0.3 + 1.25 = $1.55
    expect(text).toContain('LLM コスト: $1.55');
    expect(text).toContain('Anthropic $0.0000');
    expect(text).toContain('Gemini $1.5500');
    expect(text).toContain('呼出 100 回');
    expect(text).toContain('1 model');
  });

  it('複数 model の場合 model count は set 集計で正しく数える', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: emptyOk(),
      inspect: emptyOk(),
      errorTrend: emptyOk(),
      llmCost: ok([
        { model: 'gemini-2.5-flash', call_count: 10, total_tokens_in: 1000, total_tokens_out: 1000 },
        { model: 'claude-sonnet-4-6', call_count: 20, total_tokens_in: 2000, total_tokens_out: 2000 },
      ]),
    });
    expect(text).toContain('呼出 30 回');
    expect(text).toContain('2 model');
  });
});

describe('formatBiblioUsageSummary — BigQueryInt shape の coerce', () => {
  it('cnt が {value: string} 形式で来ても Number 化される (silent、warnings 出さず)', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: ok([{ action: 'acquire', outcome: 'success', cnt: { value: '42' } }]),
      inspect: emptyOk(),
      errorTrend: emptyOk(),
      llmCost: emptyOk(),
    });
    expect(text).toContain('acquire 42 件');
    expect(text).toContain('success 42');
    // wrapIntegers=false default で発生しない防御コード、正常経路では warning 出さない
    expect(text).not.toContain('データ整形 warning');
  });

  it('numeric string ("100" 等) も Number 化される', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: ok([{ action: 'inspect', outcome: 'success', cnt: '100' }]),
      inspect: emptyOk(),
      errorTrend: emptyOk(),
      llmCost: emptyOk(),
    });
    expect(text).toContain('inspect 100 件');
  });

  it('非数値 string ("abc") は silent 0 + warnings 経由で本文末尾に注記', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: ok([{ action: 'acquire', outcome: 'success', cnt: 'not-a-number' }]),
      inspect: emptyOk(),
      errorTrend: emptyOk(),
      llmCost: emptyOk(),
    });
    expect(text).toContain('acquire 0 件');
    expect(text).toContain('データ整形 warning');
    expect(text).toContain('non-numeric string coerced to 0');
  });

  it('outcome が null なら silent (unknown) + warnings 注記', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: ok([{ action: 'acquire', outcome: null, cnt: 5 }] as unknown[]),
      inspect: emptyOk(),
      errorTrend: emptyOk(),
      llmCost: emptyOk(),
    });
    expect(text).toContain('(unknown)');
    expect(text).toContain('null/undefined string coerced');
  });

  it('cnt が null なら silent 0、warnings は出さず (BQ NULL 正当)', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: ok([{ action: 'acquire', outcome: 'success', cnt: null }] as unknown[]),
      inspect: emptyOk(),
      errorTrend: emptyOk(),
      llmCost: emptyOk(),
    });
    expect(text).toContain('acquire 0 件');
    expect(text).not.toContain('データ整形 warning');
  });
});

describe('formatBiblioUsageSummary — unknown model warning', () => {
  it('unknown model が含まれる場合、Slack 本文に「※ unknown_model」注記される', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: emptyOk(),
      inspect: emptyOk(),
      errorTrend: emptyOk(),
      llmCost: ok([{ model: 'gpt-4o-mini', call_count: 1, total_tokens_in: 100, total_tokens_out: 100 }]),
    });
    expect(text).toContain('unknown_model');
    expect(text).toContain('gpt-4o-mini');
    expect(text).toContain('未知 model 検知');
  });

  it('Anthropic の場合、cache_read + cache_creation 欠落 warning が本文に注記される', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: emptyOk(),
      inspect: emptyOk(),
      errorTrend: emptyOk(),
      llmCost: ok([
        {
          model: 'claude-sonnet-4-6',
          call_count: 1,
          total_tokens_in: 100,
          total_tokens_out: 100,
        },
      ]),
    });
    expect(text).toContain('cache_read');
    expect(text).toContain('cache_creation');
    expect(text).toContain('underestimated');
  });

  // BQ row が SQL NULL を返す場合 (key present + value null) も
  // undefined と等価に扱われて cost-calculator の warning 経路が発火することを検証。
  // 旧実装 (formatter.ts:129-139 の `'x' in row ? toNumber(...) : undefined`) は BQ NULL を
  // silent 0 化していたため warning が発火せず、cost 過小推定が patron に一切可視化されない silent
  // failure だった。normalizeErrorTrendRow と対称化した null ガードで解消。
  it('BQ NULL 経路 (total_cache_read: null / total_cache_creation: null) でも欠落 warning が発火する (C2 regression)', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: emptyOk(),
      inspect: emptyOk(),
      errorTrend: emptyOk(),
      llmCost: ok([
        {
          model: 'claude-sonnet-4-6',
          call_count: 1,
          total_tokens_in: 100,
          total_tokens_out: 100,
          total_cache_read: null,
          total_cache_creation: null,
        },
      ]),
    });
    expect(text).toContain('cache_read');
    expect(text).toContain('cache_creation');
    expect(text).toContain('underestimated');
  });

  // `uncaptured_cache_calls > 0` は emit 側の `cache_captured=false` 件数を SQL 集計した独立指標。
  // formatter がこれを本文に「N 件は usage 未捕捉」warning 行として反映するのを pin。
  // regression 回避 (formatter.ts:245-254 が silent に消えても既存 test は緑になる盲点への対応)。
  it('uncaptured_cache_calls > 0 → 「usage 未捕捉」warning 行が本文に出る', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: emptyOk(),
      inspect: emptyOk(),
      errorTrend: emptyOk(),
      llmCost: ok([
        {
          model: 'claude-sonnet-4-6',
          call_count: 10,
          total_tokens_in: 1000,
          total_tokens_out: 500,
          total_cache_read: 0,
          total_cache_creation: 0,
          uncaptured_cache_calls: 3,
        },
      ]),
    });
    expect(text).toContain('3 件は usage 未捕捉');
  });

  it('uncaptured_cache_calls == 0 → warning 行は出ない (silent 0 表示の抑止)', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: emptyOk(),
      inspect: emptyOk(),
      errorTrend: emptyOk(),
      llmCost: ok([
        {
          model: 'claude-sonnet-4-6',
          call_count: 10,
          total_tokens_in: 1000,
          total_tokens_out: 500,
          total_cache_read: 100,
          total_cache_creation: 50,
          uncaptured_cache_calls: 0,
        },
      ]),
    });
    expect(text).not.toContain('usage 未捕捉');
  });
});

describe('formatBiblioUsageSummary — action sort', () => {
  it('action は alphabetical 順に並ぶ (呼出順に依存しない)', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: ok([
        { action: 'shelve', outcome: 'success', cnt: 1 },
        { action: 'acquire', outcome: 'success', cnt: 2 },
        { action: 'list', outcome: 'success', cnt: 3 },
      ]),
      inspect: emptyOk(),
      errorTrend: emptyOk(),
      llmCost: emptyOk(),
    });
    const acquireIdx = text.indexOf('acquire');
    const listIdx = text.indexOf('list');
    const shelveIdx = text.indexOf('shelve');
    expect(acquireIdx).toBeGreaterThan(0);
    expect(acquireIdx).toBeLessThan(listIdx);
    expect(listIdx).toBeLessThan(shelveIdx);
  });
});

describe('formatBiblioUsageSummary — {text, blocks} shape (M4-C Phase 2)', () => {
  it('返り値は text (string) と blocks (SlackBlock[]) の 2 field を持つ', () => {
    const result = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: emptyOk(),
      inspect: emptyOk(),
      errorTrend: emptyOk(),
      llmCost: emptyOk(),
    });
    expect(typeof result.text).toBe('string');
    expect(Array.isArray(result.blocks)).toBe(true);
    // header + 4 card 分の少なくとも 1 block ずつ → 空 rows の card でも section text block が出る
    expect(result.blocks.length).toBeGreaterThanOrEqual(5);
    // 先頭 block は header type
    expect(result.blocks[0]).toMatchObject({ type: 'header' });
  });
});

describe('formatBiblioUsageSummary — inspect-distribution (rows / empty / fail)', () => {
  it('rows あり: verdict/dangerous ごとの cnt を text に集約する', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: emptyOk(),
      inspect: ok([
        { verdict: 'ACCEPT', reason: 'none', dangerous: 'false', cnt: 4 },
        { verdict: 'HOLD', reason: 'license_unknown', dangerous: 'false', cnt: 2 },
        { verdict: 'HOLD', reason: 'inspect_error', dangerous: 'false', cnt: 3 },
        { verdict: 'REJECT', reason: 'dangerous_code', dangerous: 'true', cnt: 1 },
      ]),
      errorTrend: emptyOk(),
      llmCost: emptyOk(),
    });
    // verdict/reason 集約表示 + inspect_error 独立集計 note
    expect(text).toContain('検品分布:');
    expect(text).toContain('ACCEPT/none 4');
    expect(text).toContain('HOLD/license_unknown 2');
    expect(text).toContain('HOLD/inspect_error 3');
    expect(text).toContain('REJECT/dangerous_code 1');
    expect(text).toContain('検品システム障害 3 件');
  });

  it('rows 空: 「検品実行なし」を表示', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: emptyOk(),
      inspect: emptyOk(),
      errorTrend: emptyOk(),
      llmCost: emptyOk(),
    });
    expect(text).toContain('検品分布: 検品実行なし');
  });

  it('ok=false: 「⚠️ 取得失敗」を表示', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: emptyOk(),
      inspect: fail(),
      errorTrend: emptyOk(),
      llmCost: emptyOk(),
    });
    expect(text).toContain('検品分布: ⚠️ 取得失敗');
  });
});

describe('formatBiblioUsageSummary — error-trend (rows / empty / fail)', () => {
  it('rows あり: 総 cnt + preview 3 行 + percentile 情報を表示', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: emptyOk(),
      inspect: emptyOk(),
      errorTrend: ok([
        {
          day: '2026-07-08',
          severity: 'ERROR',
          event: 'vertex.call.timeout',
          cnt: 5,
          p50_ms: 3000,
          p95_ms: 4500,
          p99_ms: 5000,
        },
        { day: '2026-07-08', severity: 'CRITICAL', event: 'biblio.acquire.threw', cnt: 2 },
      ]),
      llmCost: emptyOk(),
    });
    // severity 列表示 + CRITICAL 独立集計 note
    expect(text).toContain('エラー傾向 (総 7 件 (うち CRITICAL 2 件))');
    expect(text).toContain('2026-07-08 [ERROR] vertex.call.timeout 5');
    expect(text).toContain('p50 3000ms');
    expect(text).toContain('p95 4500ms');
    expect(text).toContain('2026-07-08 [CRITICAL] biblio.acquire.threw 2');
  });

  it('rows 空: 「ERROR なし (順調)」を表示', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: emptyOk(),
      inspect: emptyOk(),
      errorTrend: emptyOk(),
      llmCost: emptyOk(),
    });
    expect(text).toContain('エラー傾向: ERROR / CRITICAL なし (順調)');
  });

  it('rows > 3 の場合、「他 N 行」の suffix を出す', () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      day: `2026-07-0${i}`,
      severity: 'ERROR',
      event: `evt-${i}`,
      cnt: 1,
    }));
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: emptyOk(),
      inspect: emptyOk(),
      errorTrend: ok(rows),
      llmCost: emptyOk(),
    });
    expect(text).toContain('他 3 行');
  });

  it('ok=false: 「⚠️ 取得失敗」を表示', () => {
    const { text } = formatBiblioUsageSummary({
      windowDays: 7,
      biblio: emptyOk(),
      inspect: emptyOk(),
      errorTrend: fail(),
      llmCost: emptyOk(),
    });
    expect(text).toContain('エラー傾向: ⚠️ 取得失敗');
  });
});
