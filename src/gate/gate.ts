/**
 * gate 全 4 層合成 + `withGateSpan` + `GATE_ENABLED` 判定 helper。
 *
 * `evaluateGate(text)` は **Layer 2 → Layer 1 → Layer 3 → Layer 4** の順で cheap-to-expensive
 * に呼ぶ。Layer 2 (Unicode 正規化) を先頭に置くことで、Layer 1 の ASCII regex が fullwidth /
 * zero-width / bidi override / Unicode Tag block 経由の invisible bypass も「見える形」で
 * 捕捉できるようになる (Layer 1 の効き目底上げ)。Layer 1 で pattern matched なら Layer 3/4
 * を待たず早期 `in-secure` return。
 *
 * `withGateSpan(text, fn)` は Fugue `withFugueEntrySpan` の写経 (INTERNAL kind + catch outcome
 * 上書き + finally end)。router / fugue-http の呼出側で使い、`gate.classify` span 名 + 属性
 * (`gate.classification` / `gate.layer_hit` / `gate.reason` / `gate.latency_ms` / `gate.model` /
 * `gate.text_digest`) を trace 上で可視化する。span digest / audit-log utterance は **生 text**
 * を維持 (Layer 2 正規化を経由しない独立経路、運用者可視性を優先)。
 *
 * `isGateEnabled()` は env boolean 判定 (`GATE_ENABLED === '1' | 'true'`)。既定 false =
 * gate 無効化のまま main 合流可能な退路。
 */
import { SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api';

import { getTracer } from '../observability/otel.js';
import { detectInjectionPattern } from './layer1-pattern.js';
import { normalizeInput } from './layer2-normalize.js';
import { wrapUntrustedInput } from './layer3-xml.js';
import { evaluateInput } from './layer4-evaluator.js';
import type { GateResult } from './types.js';

/** `GATE_ENABLED` env の boolean 判定 (`'1'` / `'true'` を true と解釈)。 */
export function isGateEnabled(): boolean {
  const raw = process.env.GATE_ENABLED;
  return raw === '1' || raw === 'true';
}

/**
 * gate 全 4 層合成 pure orchestration。
 *
 * 手順 (Layer 2 → Layer 1 → Layer 3 → Layer 4):
 *   1. Layer 2 (Unicode 正規化) — NFKC + zero-width/bidi/Tag block strip。以降 Layer 1/3/4 は
 *      正規化済 text を評価する = fullwidth 迂回・invisible 挟み込みが「見える形」になる
 *   2. Layer 1 (pattern) — matched なら早期 in-secure return (Layer 4 未呼出)
 *   3. Layer 3 (XML boundary) — untrusted-input で囲む
 *   4. Layer 4 (LLM evaluator) — 3 分類応答、fallback = biblio-other
 *
 * throw しない契約: Layer 4 は自身で catch + fallback するため、evaluateGate も throw しない。
 * ただし呼出側 (router.ts / fugue-http.ts) は evaluateGate throw を吸収する外側 try/catch を
 * 持つべき (fail-open で従来経路 fallback)。
 *
 * @param text patron 発話の生 text (Layer 2 で正規化してから Layer 1/3/4 に渡す)
 * @returns GateResult (in-secure なら早期 return、それ以外は Layer 4 の結果)
 */
export async function evaluateGate(text: string): Promise<GateResult> {
  const t0 = performance.now();
  // Layer 2: Unicode 正規化 (NFKC + zero-width/bidi/Tag block strip)
  const normalized = normalizeInput(text);
  // Layer 1: pattern detection (pure、synchronous) — 正規化済 text で評価
  const layer1 = detectInjectionPattern(normalized);
  if (layer1.matched) {
    return {
      classification: 'in-secure',
      reason: layer1.reason ?? layer1.pattern ?? 'pattern matched',
      layerHit: 'layer1',
      latencyMs: Math.round(performance.now() - t0),
      // Layer 1 早期 return は model 未使用
    };
  }
  // Layer 3: XML trust boundary — 正規化済 text を untrusted-input で囲む
  const wrapped = wrapUntrustedInput(normalized);
  // Layer 4: LLM evaluator (throw しない、fallback = biblio-other)
  const layer4 = await evaluateInput(wrapped);
  // layer4 の latencyMs は Layer 4 内部の分だけ = ここで Layer 1-4 全体 latency を再計算
  return {
    ...layer4,
    latencyMs: Math.round(performance.now() - t0),
  };
}

/** span 属性用の digest 上限。audit-log の 200 chars と揃える。 */
const SPAN_TEXT_DIGEST_MAX = 200;

function truncateDigest(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

/**
 * gate 評価を entry span で囲む helper (`withFugueEntrySpan` 写経、INTERNAL kind)。
 *
 * span 名は `gate.classify` 固定 (single operation)、初期属性 = `gate.text_digest` (200 chars)
 * + `gate.model` (env or default) を span 開始時に set。fn 内で `span.setAttribute` により
 * `gate.classification` / `gate.layer_hit` / `gate.reason` / `gate.latency_ms` を追加設定できる。
 *
 * throw 経路: `span.setAttribute('gate.outcome', 'error')` + recordException + ERROR status +
 * re-throw (finally で end 保証)。**silent-failure 撲滅** (fugue-entry-span の I1 同流儀)。
 *
 * @param text patron 発話 (span 属性 digest 用、実 evaluateGate 呼出は fn 内で行う)
 * @param fn span active state で実行する非同期関数
 */
export async function withGateSpan<T>(text: string, fn: (span: Span) => Promise<T>): Promise<T> {
  const tracer = getTracer();
  const model = process.env.GATE_MODEL || 'gemini-3.1-flash-lite';
  return tracer.startActiveSpan(
    'gate.classify',
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        'gate.text_digest': truncateDigest(text, SPAN_TEXT_DIGEST_MAX),
        'gate.model': model,
      },
    },
    async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        const errorRecord = err instanceof Error ? err : new Error(String(err));
        span.recordException(errorRecord);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorRecord.message });
        // silent-failure 撲滅原則を継承 (fugue-entry-span.ts と同流儀)
        span.setAttribute('gate.outcome', 'error');
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
