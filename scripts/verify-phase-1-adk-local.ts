/**
 * M4-B Phase 1 verify — local 実機検証 script。
 *
 * 実 Anthropic Vertex (= ADC + `claude-sonnet-4-6`) + 実 `acquire()` (= GitHub clone) を
 * 起こして、ADK Runner 経路で **1 patron 自然文命令 → tool 自律呼出 → 既存関数実行 → 結果応答**
 * が成立することを実機検証する。Phase 1 plan Task 10 の完了判定 fixture。
 *
 * 使い方:
 *   pnpm exec tsx --import ./src/instrumentation.ts scripts/verify-phase-1-adk-local.ts
 *
 * env (任意):
 *   VERIFY_PHASE_1_BIBLIO  — 取得対象 biblio (default: example-org/test-biblio-minimal)
 *
 * 出力 (stdout、後続の grep/awk が抽出する形式):
 *   TRACE_ID=<32 hex>
 *   EVENT_COUNT=<int>
 *   FINAL_TEXT=<text>
 *
 * **GOTCHA (Phase 1 plan Task 10)**:
 *   - `ANTHROPIC_VERTEX_PROJECT_ID` / `CLOUD_ML_REGION=global` env 必須 + `gcloud auth ADC` 済が前提
 *   - `HTTPS_PROXY` (= OneCLI) が `aiplatform.googleapis.com` に乗ると keyless ADC が壊れる
 *     経路あり (Phase 0 GOTCHA と同じ) — 失敗時は `unset HTTPS_PROXY` or `NO_PROXY` で再試行
 *   - 実 GitHub clone (= `acquire()`) が走るため `VERIFY_PHASE_1_BIBLIO` で安全な test biblio を
 *     指定 (default: `example-org/test-biblio-minimal`)
 *   - `shutdownOtel()` を最後に呼ばないと BatchSpanProcessor が flush されず Cloud Trace に
 *     span が届かない (M4-A Phase 4 で発見済の罠)
 *   - LLM が tool を呼ばずに text のみ返却した場合でも exit 0 (= 実用性のため fail-fast しない)、
 *     ただし stderr に warn を流す。失敗 (= SDK error / acquire 失敗) のみ exit 1
 */
import { trace } from '@opentelemetry/api';
import { isFinalResponse } from '@google/adk';

import { registerAnthropicVertexLlm } from '../src/adk/llm-registry-setup.js';
import { buildRootAgent } from '../src/adk/root-agent.js';
import { buildRunner } from '../src/adk/runner.js';
import { shutdownOtel } from '../src/observability/index.js';
import { log } from '../src/log.js';

async function main(): Promise<void> {
  // LLM registry hook — instrumentation.ts は `--import` 経路で main() より前に起動済み前提。
  registerAnthropicVertexLlm();

  const rootAgent = buildRootAgent();
  const runner = buildRunner(rootAgent);

  const testBiblio = process.env.VERIFY_PHASE_1_BIBLIO ?? 'example-org/test-biblio-minimal';
  const patronCommand = `次の repo を仕入れてください: ${testBiblio}`;

  log.info('Phase 1 verify: starting', {
    event: 'verify.phase_1.start',
    biblio: testBiblio,
    user_id: 'verify-phase-1',
  });

  let finalText = '';
  let traceId: string | undefined;
  let eventCount = 0;
  let toolWasCalled = false;

  for await (const event of runner.runEphemeral({
    userId: 'verify-phase-1',
    newMessage: { role: 'user', parts: [{ text: patronCommand }] },
  })) {
    eventCount++;
    // 最初に取れた active span の trace_id を採用 (= ADK 自動 span / generateContentAsync span)。
    const span = trace.getActiveSpan();
    if (span && !traceId) {
      const sc = span.spanContext();
      if (sc.traceId && !/^0+$/.test(sc.traceId)) {
        traceId = sc.traceId;
      }
    }
    // event 内の functionCall / functionResponse part を観察 (= LLM が tool を呼んだか)。
    const parts = event.content?.parts ?? [];
    for (const p of parts) {
      if (
        (typeof p === 'object' && p !== null && 'functionCall' in p && p.functionCall) ||
        (typeof p === 'object' && p !== null && 'functionResponse' in p && p.functionResponse)
      ) {
        toolWasCalled = true;
      }
    }
    if (isFinalResponse(event)) {
      finalText = event.content?.parts?.[0]?.text ?? '';
    }
  }

  log.info('Phase 1 verify: completed', {
    event: 'verify.phase_1.complete',
    outcome: toolWasCalled ? 'tool_called' : 'text_only',
    event_count: eventCount,
    trace_id: traceId ?? 'undefined',
    final_text_length: finalText.length,
  });

  // 結果 stdout (= verify-script / DEN さんが目視確認する形式)。
  process.stdout.write(`TRACE_ID=${traceId ?? 'undefined'}\n`);
  process.stdout.write(`EVENT_COUNT=${eventCount}\n`);
  process.stdout.write(`TOOL_CALLED=${toolWasCalled}\n`);
  process.stdout.write(`FINAL_TEXT=${finalText.replace(/\n/g, ' ')}\n`);

  if (!toolWasCalled) {
    // LLM が tool を呼ばなかったケース — exit 0 で進めるが warn 出力 (= instruction の調整余地を提示)。
    process.stderr.write(
      'WARN: LLM did not invoke any tool (only text response). Review root agent instruction or test biblio choice.\n',
    );
  }
  if (!traceId) {
    process.stderr.write('WARN: TRACE_ID is undefined. Check OTel init (instrumentation.ts) and ADC.\n');
  }

  await shutdownOtel();
}

main().catch((err) => {
  log.error('Phase 1 verify: failed', {
    event: 'verify.phase_1.error',
    err: err instanceof Error ? err.message : String(err),
  });
  process.stderr.write(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
  // shutdownOtel は best-effort で呼ぶ (= 失敗経路でも flush 試行)
  void shutdownOtel().catch(() => undefined);
});
