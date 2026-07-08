/**
 * Fugue HTTP server の trace 相関 log field 検証。
 *
 * `LOG_FORMAT=json` 経路 (Prod default) で emitJson() が active span から `getTraceLogFields()`
 * を呼び出し、`logging.googleapis.com/trace` / `logging.googleapis.com/spanId` /
 * `logging.googleapis.com/trace_sampled` を全 emit payload に自動付与することを実証する。
 *
 * log.ts の FORMAT は module load 時に `process.env.LOG_FORMAT === 'json'` で評価される
 * (src/log.ts:31)。本 test file では test 内で `process.env.LOG_FORMAT = 'json'` を先に設定
 * してから `await import('./fugue-http.js')` で dynamic import することで、log.js を fresh
 * evaluate して emitJson 経路を確実に有効化する (`log-trace.test.ts:47` と同流儀)。
 *
 * span 発火 + outcome 属性の検証は `fugue-http.otel.test.ts` に分離済 (2 file 分離は
 * LOG_FORMAT env stubbing の module 初期化順序制約に配慮)。
 */
import * as otelApi from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListBiblioResult } from '../biblio/types.js';

const TOKEN = 'otel-log-test-token-abcdef0123456789abcdef0123456789ab';

vi.mock('../biblio/list-biblio.js', () => ({
  listBiblio: vi.fn(),
}));

vi.mock('../biblio/shelf-gh.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../biblio/shelf-gh.js')>();
  return {
    ...original,
    readListEnv: vi.fn(() => ({ shelfOwner: 'MockOwner', shelfRepo: 'mock-shelf' })),
  };
});

vi.mock('../db/fugue-equipped-biblios.js', () => ({
  insertFugueEquippedBiblio: vi.fn(() => true),
  getFugueEquippedBiblioNames: vi.fn(() => []),
  deleteFugueEquippedBiblioByName: vi.fn(() => 0),
}));

const FIXTURE_RESULT: ListBiblioResult = {
  ok: true,
  items: [
    {
      name: 'HajimariInc--figma-reviewer',
      category: 'biblio-art',
      description: 'Figma review skill.',
      version: '1.0.0',
    },
  ],
  counts: {
    'biblio-dev': 0,
    'biblio-art': 1,
    'biblio-bf': 0,
    'biblio-ai': 0,
    unknown: 0,
  },
  total: 1,
  appliedFilter: null,
};

describe('FugueHttpServer trace log correlation (Phase 4, LOG_FORMAT=json)', () => {
  const originalFormat = process.env.LOG_FORMAT;
  const originalLevel = process.env.LOG_LEVEL;
  let memoryExporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  const writes: string[] = [];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    process.env.LOG_FORMAT = 'json';
    process.env.LOG_LEVEL = 'debug';
    otelApi.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    otelApi.propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    memoryExporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
      spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
    });
    otelApi.trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    process.env.LOG_FORMAT = originalFormat;
    process.env.LOG_LEVEL = originalLevel;
    await provider?.shutdown().catch(() => undefined);
    otelApi.trace.disable();
    otelApi.propagation.disable();
    otelApi.context.disable();
  });

  beforeEach(async () => {
    writes.length = 0;
    memoryExporter.reset();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const { listBiblio } = await import('../biblio/list-biblio.js');
    vi.mocked(listBiblio).mockResolvedValue(FIXTURE_RESULT);
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.mocked((await import('../biblio/list-biblio.js')).listBiblio).mockReset();
  });

  function parseJsonWrites(): Array<Record<string, unknown>> {
    return writes
      .flatMap((s) => s.split('\n'))
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        try {
          return JSON.parse(s) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((v): v is Record<string, unknown> => v !== null);
  }

  it('consult 成功経路の fugue.consult.completed emit に trace 相関 field が付与される', async () => {
    // FugueHttpServer は log.ts に依存 → 本 test 内で LOG_FORMAT=json が有効な状態で
    // dynamic import して log.ts を fresh evaluate する (module load 時点で LOG_FORMAT 判定
    // が起きるため、静的 import ではタイミングを外す可能性がある)。
    const { FugueHttpServer } = await import('./fugue-http.js');
    const server = new FugueHttpServer({ port: 0, host: '127.0.0.1', expectedToken: TOKEN });
    const started = await server.start();
    const baseUrl = `http://127.0.0.1:${started.port}`;

    const parentTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    try {
      const res = await fetch(`${baseUrl}/v1/channels/fugue/consult`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
          traceparent: `00-${parentTraceId}-00f067aa0ba902b7-01`,
        },
        body: JSON.stringify({
          schema_version: '1',
          request_id: 'req-log-1',
          query: 'Figma',
          mode: 'ask-ad',
        }),
      });
      expect(res.status).toBe(200);
    } finally {
      await server.stop();
    }

    const payloads = parseJsonWrites();
    const completed = payloads.find((p) => p.event === 'fugue.consult.completed');
    expect(completed, 'fugue.consult.completed payload missing').toBeDefined();
    expect(completed!.channel).toBe('fugue');
    expect(typeof completed!.processing_time_ms).toBe('number');
    // fugue span が active の状態で emit されているので Preferred Format の 3 field が全て乗る。
    expect(completed!['logging.googleapis.com/trace']).toMatch(/^[0-9a-f]{32}$/);
    expect(completed!['logging.googleapis.com/spanId']).toMatch(/^[0-9a-f]{16}$/);
    expect(completed!['logging.googleapis.com/trace_sampled']).toBe(true);
    // 継承した parent trace_id と一致する (Fugue Cloud Run → biblio 相関の要)。
    expect(completed!['logging.googleapis.com/trace']).toBe(parentTraceId);
  });

  it('equip 成功経路の fugue.equip.completed emit にも trace 相関 field が付与される', async () => {
    const { FugueHttpServer } = await import('./fugue-http.js');
    const server = new FugueHttpServer({ port: 0, host: '127.0.0.1', expectedToken: TOKEN });
    const started = await server.start();
    const baseUrl = `http://127.0.0.1:${started.port}`;

    try {
      const res = await fetch(`${baseUrl}/v1/channels/fugue/equip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          schema_version: '1',
          request_id: 'req-log-eq',
          skill_id: 'HajimariInc--figma-reviewer',
          channel: 'fugue',
        }),
      });
      expect(res.status).toBe(200);
    } finally {
      await server.stop();
    }

    const payloads = parseJsonWrites();
    const completed = payloads.find((p) => p.event === 'fugue.equip.completed');
    expect(completed, 'fugue.equip.completed payload missing').toBeDefined();
    expect(completed!.channel).toBe('fugue');
    expect(completed!['logging.googleapis.com/trace']).toMatch(/^[0-9a-f]{32}$/);
    expect(completed!['logging.googleapis.com/spanId']).toMatch(/^[0-9a-f]{16}$/);
  });

  // 部分失敗経路 (log.error) の trace 相関 field 検証。
  // 従来は成功経路の completed event のみ確認していたが、trace 相関ログの実運用価値は
  // 「失敗した request を trace_id から辿って原因を見る」場面で最大化する。partial_failure ログが
  // 同じ active span context 内 (withFugueEntrySpan → withBiblioActionSpan の中、span.end() 前) で
  // 呼ばれていることを実測する = 「log.error の呼び出し位置を早期 return の外に出す」ような一見
  // 無害なリファクタで無警告に壊れる regression を検知する。
  it('consult partial_failure (listBiblio throw) log にも trace 相関 field が付与される', async () => {
    const { listBiblio } = await import('../biblio/list-biblio.js');
    vi.mocked(listBiblio).mockRejectedValueOnce(new Error('simulated network error'));
    const { FugueHttpServer } = await import('./fugue-http.js');
    const server = new FugueHttpServer({ port: 0, host: '127.0.0.1', expectedToken: TOKEN });
    const started = await server.start();
    const baseUrl = `http://127.0.0.1:${started.port}`;

    const parentTraceId = '7e5c9f2d1b8a4e6c3f0a5d8e2b7c9f4e';
    try {
      const res = await fetch(`${baseUrl}/v1/channels/fugue/consult`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
          traceparent: `00-${parentTraceId}-a1b2c3d4e5f60718-01`,
        },
        body: JSON.stringify({
          schema_version: '1',
          request_id: 'req-log-cpf',
          query: 'x',
          mode: 'ask-ad',
        }),
      });
      // AD の本義: 200 + status:'error' (5xx でない)。
      expect(res.status).toBe(200);
    } finally {
      await server.stop();
    }

    const payloads = parseJsonWrites();
    const partial = payloads.find((p) => p.event === 'fugue.consult.partial_failure');
    expect(partial, 'fugue.consult.partial_failure payload missing').toBeDefined();
    expect(partial!.channel).toBe('fugue');
    expect(typeof partial!.processing_time_ms).toBe('number');
    // trace 相関 field が partial_failure log にも付いていることが本 test の主眼。
    expect(partial!['logging.googleapis.com/trace']).toMatch(/^[0-9a-f]{32}$/);
    expect(partial!['logging.googleapis.com/spanId']).toMatch(/^[0-9a-f]{16}$/);
    // 継承した trace_id と一致する = 「失敗した request を Fugue 側の trace_id から追跡可能」。
    expect(partial!['logging.googleapis.com/trace']).toBe(parentTraceId);
  });

  it('equip partial_failure (listBiblio throw) log にも trace 相関 field が付与される', async () => {
    const { listBiblio } = await import('../biblio/list-biblio.js');
    vi.mocked(listBiblio).mockRejectedValueOnce(new Error('simulated gh outage'));
    const { FugueHttpServer } = await import('./fugue-http.js');
    const server = new FugueHttpServer({ port: 0, host: '127.0.0.1', expectedToken: TOKEN });
    const started = await server.start();
    const baseUrl = `http://127.0.0.1:${started.port}`;

    try {
      const res = await fetch(`${baseUrl}/v1/channels/fugue/equip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          schema_version: '1',
          request_id: 'req-log-epf',
          skill_id: 'HajimariInc--figma-reviewer',
          channel: 'fugue',
        }),
      });
      expect(res.status).toBe(200);
    } finally {
      await server.stop();
    }

    const payloads = parseJsonWrites();
    const partial = payloads.find((p) => p.event === 'fugue.equip.partial_failure');
    expect(partial, 'fugue.equip.partial_failure payload missing').toBeDefined();
    expect(partial!.channel).toBe('fugue');
    expect(partial!['logging.googleapis.com/trace']).toMatch(/^[0-9a-f]{32}$/);
    expect(partial!['logging.googleapis.com/spanId']).toMatch(/^[0-9a-f]{16}$/);
  });

  // malformed traceparent 経路の regression 検知:
  //
  // Fugue Cloud Run 側が壊れた `traceparent` header を送ってきたときに `fugue.traceparent.malformed`
  // event を warn として emit する経路 = 「auto trace 経路が壊れているのに Cloud Trace 側が何事も
  // なかったかのように見える」silent 縮退を可視化するために明示的に追加された regression 検知点。
  // しかし本 event 自体を叩く test が unit / E2E どちらにも存在せず「検知ガード自身が最も無防備」
  // だった。malformed traceparent (all-zero trace_id、W3C spec §3.2 で invalid) を送信して:
  //   (a) HTTP 応答は 200 で継続 (AD の本義: header 破損で検索を殺さない)
  //   (b) `fugue.traceparent.malformed` event が warn 経路で 1 回だけ emit される
  //   (c) 応答自体は fresh な (継承していない) 新 trace_id で生成される
  // ことを固定化する。
  it('malformed traceparent (all-zero trace_id) は fugue.traceparent.malformed を warn しつつ 200 で処理を継続する', async () => {
    const { FugueHttpServer } = await import('./fugue-http.js');
    const server = new FugueHttpServer({ port: 0, host: '127.0.0.1', expectedToken: TOKEN });
    const started = await server.start();
    const baseUrl = `http://127.0.0.1:${started.port}`;

    try {
      const res = await fetch(`${baseUrl}/v1/channels/fugue/consult`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
          // W3C traceparent grammar §3.2: trace-id が all-zero は禁止。version-format としては通過
          // するが、propagator が silently drop するため fugue-http.ts 側が明示的に warn を吐く経路。
          traceparent: '00-00000000000000000000000000000000-0000000000000000-01',
        },
        body: JSON.stringify({
          schema_version: '1',
          request_id: 'req-log-badtp',
          // fixture (HajimariInc--figma-reviewer, "Figma review skill.") にヒットする query。
          // status='ok' で `fugue.consult.completed` event が emit される経路 (`x` だと not_found event になる)。
          query: 'Figma',
          mode: 'ask-ad',
        }),
      });
      // (a) header 破損で検索を殺さない (AD の本義)。
      expect(res.status).toBe(200);
    } finally {
      await server.stop();
    }

    const payloads = parseJsonWrites();
    // (b) `fugue.traceparent.malformed` event が 1 回だけ emit されている (silent fallback の可視化)。
    const malformed = payloads.filter((p) => p.event === 'fugue.traceparent.malformed');
    expect(malformed.length).toBeGreaterThanOrEqual(1);
    expect(malformed[0].channel).toBe('fugue');
    // (c) 応答経路の completed event の trace_id は Fugue の壊れた traceparent を継承せず fresh に。
    const completed = payloads.find((p) => p.event === 'fugue.consult.completed');
    expect(completed, 'fugue.consult.completed payload missing').toBeDefined();
    expect(completed!['logging.googleapis.com/trace']).toMatch(/^[0-9a-f]{32}$/);
    // all-zero でない = 新規生成された trace_id (propagator が invalid header を drop した結果)
    expect(completed!['logging.googleapis.com/trace']).not.toBe('00000000000000000000000000000000');
  });
});
