/**
 * `blocks-builder.ts` のユニットテスト。
 *
 * `@chat-adapter/slack/blocks.cardToSlackBlocks` を vi.mock で spy 化し、
 * SlackCardElement.children の shape (= SlackTableElement.headers / rows) を assert する。
 * plan GOTCHA: 「cardToSlackBlocks の返り値をそのまま assert しない (library 内実装依存)」に従い、
 * 呼出前の SlackCardElement 引数を検証する形。
 *
 * カバレッジ:
 *   - buildReportBlocks が header (plain_text) + 4 card + optional warnings section を返す
 *   - biblio / inspect / errorTrend / llmCost の各 card に SlackTableElement が入る (rows あり)
 *   - rows 空時は SlackTextElement 「活動なし」/「検品実行なし」/「ERROR なし」/「呼出記録なし」
 *   - QueryOutcome.ok=false 時は SlackTextElement 「⚠️ 取得失敗」
 *   - warnings 追加時に末尾 section block (mrkdwn) が付く
 *   - llmCost card は table に加えて合計/note の text child も持つ
 */
import { describe, expect, it, vi } from 'vitest';
import type { SlackCardElement, SlackTableElement, SlackTextElement } from '@chat-adapter/slack/blocks';

// cardToSlackBlocks を spy 化: 実 library に依存せず「渡された SlackCardElement」を捕捉する
const cardCalls: SlackCardElement[] = [];
vi.mock('@chat-adapter/slack/blocks', () => ({
  cardToSlackBlocks: vi.fn((card: SlackCardElement) => {
    cardCalls.push(card);
    return [{ type: 'section', text: { type: 'mrkdwn', text: `mock:${card.title ?? ''}` } }];
  }),
}));

import { buildReportBlocks } from '../blocks-builder.js';
import type { QueryOutcome } from '../formatter.js';

const ok = <T>(rows: T[]): QueryOutcome<T> => ({ ok: true, rows });
const emptyOk = (): QueryOutcome => ok<unknown>([]);
const fail = (): QueryOutcome => ({ ok: false });

function reset() {
  cardCalls.length = 0;
}

function findTable(card: SlackCardElement): SlackTableElement | undefined {
  return card.children.find((c): c is SlackTableElement => c.type === 'table');
}

function findText(card: SlackCardElement): SlackTextElement | undefined {
  return card.children.find((c): c is SlackTextElement => c.type === 'text');
}

describe('buildReportBlocks — header + 4 card + optional warnings', () => {
  it('warnings 空 → header 1 + 4 card × mock 1 block ずつ = 5 block', () => {
    reset();
    const blocks = buildReportBlocks(
      {
        windowDays: 7,
        biblio: emptyOk(),
        inspect: emptyOk(),
        errorTrend: emptyOk(),
        llmCost: emptyOk(),
      },
      [],
    );
    // header + 4 mock section = 5
    expect(blocks.length).toBe(5);
    expect(blocks[0]).toMatchObject({ type: 'header', text: { type: 'plain_text' } });
    // cardToSlackBlocks は 4 回呼ばれる
    expect(cardCalls).toHaveLength(4);
    expect(cardCalls.map((c) => c.title)).toEqual(['📚 biblio 利用', '⚠️ 検品分布', '🚨 エラー傾向', '💰 LLM コスト']);
  });

  it('warnings 非空 → 末尾に section (mrkdwn) block が追加される', () => {
    reset();
    const blocks = buildReportBlocks(
      {
        windowDays: 7,
        biblio: emptyOk(),
        inspect: emptyOk(),
        errorTrend: emptyOk(),
        llmCost: emptyOk(),
      },
      ['dup', 'dup', 'row: null coerced'],
    );
    // header + 4 mock + warnings section = 6
    expect(blocks.length).toBe(6);
    const last = blocks[blocks.length - 1] as { type: string; text: { type: string; text: string } };
    expect(last.type).toBe('section');
    expect(last.text.type).toBe('mrkdwn');
    expect(last.text.text).toContain('データ整形 warning');
    // 重複除去されている
    expect(last.text.text.match(/dup/g)?.length).toBe(1);
  });
});

describe('buildReportBlocks — biblio card children shape', () => {
  it('rows あり: SlackTableElement (headers=action/outcome/cnt) が入る', () => {
    reset();
    buildReportBlocks(
      {
        windowDays: 7,
        biblio: ok([
          { action: 'acquire', outcome: 'success', cnt: 5 },
          { action: 'inspect', outcome: 'success', cnt: 3 },
        ]),
        inspect: emptyOk(),
        errorTrend: emptyOk(),
        llmCost: emptyOk(),
      },
      [],
    );
    const biblioCard = cardCalls[0];
    expect(biblioCard.title).toBe('📚 biblio 利用');
    const table = findTable(biblioCard);
    expect(table).toBeDefined();
    expect(table?.headers).toEqual(['action', 'outcome', 'cnt']);
    expect(table?.rows).toEqual([
      ['acquire', 'success', '5'],
      ['inspect', 'success', '3'],
    ]);
  });

  it('rows 空: SlackTextElement 「活動なし」', () => {
    reset();
    buildReportBlocks(
      { windowDays: 7, biblio: emptyOk(), inspect: emptyOk(), errorTrend: emptyOk(), llmCost: emptyOk() },
      [],
    );
    const biblioCard = cardCalls[0];
    expect(findTable(biblioCard)).toBeUndefined();
    expect(findText(biblioCard)?.content).toBe('活動なし');
  });

  it('ok=false: 「⚠️ 取得失敗」 text child が入る', () => {
    reset();
    buildReportBlocks(
      { windowDays: 7, biblio: fail(), inspect: emptyOk(), errorTrend: emptyOk(), llmCost: emptyOk() },
      [],
    );
    const biblioCard = cardCalls[0];
    expect(findText(biblioCard)?.content).toContain('⚠️ 取得失敗');
  });
});

describe('buildReportBlocks — inspect card children shape', () => {
  it('rows あり: SlackTableElement (headers=verdict/dangerous/cnt) が入る', () => {
    reset();
    buildReportBlocks(
      {
        windowDays: 7,
        biblio: emptyOk(),
        inspect: ok([
          { verdict: 'ACCEPT', reason: 'none', dangerous: 'false', cnt: 4 },
          { verdict: 'REJECT', reason: 'dangerous_code', dangerous: 'true', cnt: 1 },
        ]),
        errorTrend: emptyOk(),
        llmCost: emptyOk(),
      },
      [],
    );
    const inspectCard = cardCalls[1];
    const table = findTable(inspectCard);
    // reason 列追加
    expect(table?.headers).toEqual(['verdict', 'reason', 'dangerous', 'cnt']);
    expect(table?.rows).toEqual([
      ['ACCEPT', 'none', 'false', '4'],
      ['REJECT', 'dangerous_code', 'true', '1'],
    ]);
  });

  it('rows 空: 「検品実行なし」 text child', () => {
    reset();
    buildReportBlocks(
      { windowDays: 7, biblio: emptyOk(), inspect: emptyOk(), errorTrend: emptyOk(), llmCost: emptyOk() },
      [],
    );
    expect(findText(cardCalls[1])?.content).toBe('検品実行なし');
  });
});

describe('buildReportBlocks — errorTrend card children shape', () => {
  it('rows あり: SlackTableElement (headers=day/event/cnt/p50_ms/p95_ms/p99_ms) が入る、percentile 欠落は空文字', () => {
    reset();
    buildReportBlocks(
      {
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
      },
      [],
    );
    const errorTrendCard = cardCalls[2];
    const table = findTable(errorTrendCard);
    expect(table?.headers).toEqual(['day', 'severity', 'event', 'cnt', 'p50_ms', 'p95_ms', 'p99_ms']);
    expect(table?.rows).toEqual([
      ['2026-07-08', 'ERROR', 'vertex.call.timeout', '5', '3000', '4500', '5000'],
      ['2026-07-08', 'CRITICAL', 'biblio.acquire.threw', '2', '', '', ''],
    ]);
  });

  it('rows 空: 「ERROR なし (順調)」 text child', () => {
    reset();
    buildReportBlocks(
      { windowDays: 7, biblio: emptyOk(), inspect: emptyOk(), errorTrend: emptyOk(), llmCost: emptyOk() },
      [],
    );
    expect(findText(cardCalls[2])?.content).toBe('ERROR / CRITICAL なし (順調)');
  });
});

describe('buildReportBlocks — llmCost card children shape', () => {
  it('rows あり: 合計 text + SlackTableElement (headers=model/call_count/tokens_in/tokens_out/cache_read/cache_creation)', () => {
    reset();
    buildReportBlocks(
      {
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
            total_cache_read: 200,
            total_cache_creation: 100,
          },
        ]),
      },
      [],
    );
    const llmCard = cardCalls[3];
    const table = findTable(llmCard);
    expect(table?.headers).toEqual(['model', 'call_count', 'tokens_in', 'tokens_out', 'cache_read', 'cache_creation']);
    expect(table?.rows).toEqual([['claude-sonnet-4-6', '10', '1000', '500', '200', '100']]);
    const summaryText = findText(llmCard);
    expect(summaryText?.content).toContain('合計:');
    expect(summaryText?.content).toContain('Anthropic $');
    expect(summaryText?.content).toContain('Gemini $');
  });

  it('rows 空: 「呼出記録なし」 text child', () => {
    reset();
    buildReportBlocks(
      { windowDays: 7, biblio: emptyOk(), inspect: emptyOk(), errorTrend: emptyOk(), llmCost: emptyOk() },
      [],
    );
    expect(findText(cardCalls[3])?.content).toBe('呼出記録なし');
  });

  it('ok=false: 「⚠️ 取得失敗」 text child', () => {
    reset();
    buildReportBlocks(
      { windowDays: 7, biblio: emptyOk(), inspect: emptyOk(), errorTrend: emptyOk(), llmCost: fail() },
      [],
    );
    expect(findText(cardCalls[3])?.content).toContain('⚠️ 取得失敗');
  });

  it('未知 model 検知時に warning text child が追加される', () => {
    reset();
    buildReportBlocks(
      {
        windowDays: 7,
        biblio: emptyOk(),
        inspect: emptyOk(),
        errorTrend: emptyOk(),
        llmCost: ok([
          {
            model: 'gpt-4o-mini',
            call_count: 1,
            total_tokens_in: 100,
            total_tokens_out: 100,
          },
        ]),
      },
      [],
    );
    const llmCard = cardCalls[3];
    const textChildren = llmCard.children.filter((c): c is SlackTextElement => c.type === 'text');
    expect(textChildren.some((c) => c.content.includes('未知 model 検知'))).toBe(true);
  });

  // `uncaptured_cache_calls > 0` は emit 側の `cache_captured=false` 件数を SQL 集計した独立指標。
  // blocks-builder が LLM card に「N 件は usage 未捕捉」warning text child を反映するのを pin。
  it('uncaptured_cache_calls > 0 → 「usage 未捕捉」warning text child が LLM card に入る', () => {
    reset();
    buildReportBlocks(
      {
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
      },
      [],
    );
    const llmCard = cardCalls[3];
    const textChildren = llmCard.children.filter((c): c is SlackTextElement => c.type === 'text');
    expect(textChildren.some((c) => c.content.includes('3 件は usage 未捕捉'))).toBe(true);
  });

  it('uncaptured_cache_calls == 0 → warning text child は入らない (silent 0 表示の抑止)', () => {
    reset();
    buildReportBlocks(
      {
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
      },
      [],
    );
    const llmCard = cardCalls[3];
    const textChildren = llmCard.children.filter((c): c is SlackTextElement => c.type === 'text');
    expect(textChildren.some((c) => c.content.includes('usage 未捕捉'))).toBe(false);
  });
});
