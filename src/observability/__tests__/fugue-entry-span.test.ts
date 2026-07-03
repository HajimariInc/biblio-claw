/**
 * `withFugueEntrySpan` の contract test (M4-E Phase 4)。
 *
 * `action-helpers.test.ts:145-206` (withBiblioActionSpan) の InMemorySpanExporter パターンを
 * 写経しつつ、Fugue channel 特有の signature (`operation` / `channel:'fugue'` 属性 /
 * `sessionId` 引数なし) に合わせて 4 case で検証する:
 *   1. span 名 + 属性 (channel / fugue.operation / fugue.request_id + 呼出側 setAttribute)
 *   2. fn throw 時の ERROR status + recordException + re-throw
 *   3. finally での span end 保証 (throw 経路も含む)
 *   4. `withBiblioActionSpan` を fn 内から呼ぶと biblio.<action> span が子として nest される
 *      (3 段構造の中央 layer と下 layer の親子関係、fugue-http の本番経路の縮小版)
 */
import * as otelApi from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { withFugueEntrySpan } from '../fugue-entry-span.js';

describe('withFugueEntrySpan', () => {
  let memoryExporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeAll(() => {
    otelApi.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    memoryExporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
      spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
    });
    otelApi.trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    await provider?.shutdown().catch(() => undefined);
    otelApi.trace.disable();
    otelApi.context.disable();
  });

  beforeEach(() => {
    memoryExporter.reset();
  });

  it('fugue.<operation> span を立て、channel / fugue.operation / fugue.request_id を付与する', async () => {
    await withFugueEntrySpan('consult', 'req-abc', async (span) => {
      span.setAttribute('fugue.outcome', 'ok');
    });

    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('fugue.consult');
    expect(spans[0].kind).toBe(otelApi.SpanKind.INTERNAL);
    expect(spans[0].attributes.channel).toBe('fugue');
    expect(spans[0].attributes['fugue.operation']).toBe('consult');
    expect(spans[0].attributes['fugue.request_id']).toBe('req-abc');
    expect(spans[0].attributes['fugue.outcome']).toBe('ok');
  });

  it('extraAttributes を追加属性として反映する (呼出側からの追加項目)', async () => {
    await withFugueEntrySpan('consult', 'req-mode', async () => 0, { 'fugue.mode': 'ask-ad' });

    const spans = memoryExporter.getFinishedSpans();
    expect(spans[0].attributes['fugue.mode']).toBe('ask-ad');
  });

  it('fn throw 時に recordException + ERROR status を記録し err を re-throw する', async () => {
    await expect(
      withFugueEntrySpan('equip', 'req-xyz', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('fugue.equip');
    expect(spans[0].status.code).toBe(otelApi.SpanStatusCode.ERROR);
    expect(spans[0].status.message).toBe('boom');
    expect(spans[0].events.some((e) => e.name === 'exception')).toBe(true);
    // PR #135 review 提案 6a 対応: Phase 4 review I1 (silent-failure #1) で追加された「throw 経路の
    // fugue.outcome='error' デフォルト」の効果を直接固定化する。呼出側が成功経路で outcome を
    // set しないまま throw されたら本 attribute が唯一の diagnostic signal になる (BQ sink /
    // Cloud Trace ダッシュボード)。この 1 行が「Phase 4 で潰した silent failure が今後
    // regression しない」保証。
    expect(spans[0].attributes['fugue.outcome']).toBe('error');
  });

  it('non-Error throw を Error に包み recordException + ERROR status を記録する', async () => {
    await expect(
      withFugueEntrySpan('equip', 'req-nonerr', async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'string-error';
      }),
    ).rejects.toBe('string-error');

    const spans = memoryExporter.getFinishedSpans();
    expect(spans[0].status.code).toBe(otelApi.SpanStatusCode.ERROR);
    expect(spans[0].status.message).toBe('string-error');
    // non-Error throw も同様に fugue.outcome='error' で固定化 (Error/non-Error の枝分岐で
    // silent 差分が生じない保証)。
    expect(spans[0].attributes['fugue.outcome']).toBe('error');
  });

  it('throw 経路でも finally で span end される (成功 + throw の 2 span 揃う)', async () => {
    await withFugueEntrySpan('consult', 'req-1', async () => 'ok');
    await withFugueEntrySpan('equip', 'req-2', async () => {
      throw new Error('x');
    }).catch(() => {});

    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    expect(spans.map((s) => s.name).sort()).toEqual(['fugue.consult', 'fugue.equip']);
  });

  it('fn 内から呼んだ withBiblioActionSpan の span が fugue span の子として nest される', async () => {
    const { withBiblioActionSpan } = await import('../../biblio/action-helpers.js');
    await withFugueEntrySpan('consult', 'req-parent', async () => {
      await withBiblioActionSpan('list', 'req-parent', '', async (biblioSpan) => {
        biblioSpan.setAttribute('biblio.outcome', 'success');
      });
    });

    const spans = memoryExporter.getFinishedSpans();
    const biblio = spans.find((s) => s.name === 'biblio.list');
    const fugue = spans.find((s) => s.name === 'fugue.consult');
    expect(biblio).toBeDefined();
    expect(fugue).toBeDefined();
    // 3 段構造の中央 (fugue) と下 (biblio) の親子関係。
    // SDK は SpanProcessor に finished span から順に渡す = 子 (biblio) が先に finish、
    // 親 (fugue) が後に finish するが、parentSpanContext の traceId/spanId は不変。
    // sdk-trace-base 2.x では ReadableSpan.spanContext は method (関数呼出) だが、
    // parentSpanContext は property (SpanContext | undefined) で access パターンが違う。
    expect(biblio!.parentSpanContext?.spanId).toBe(fugue!.spanContext().spanId);
    expect(biblio!.spanContext().traceId).toBe(fugue!.spanContext().traceId);
  });
});
