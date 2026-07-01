/**
 * M4-B Phase 1 verify — local scaffolding 構造 smoke + OTel 流出確認 script。
 *
 * **重要 — 何を verify するか / 何を verify しないか** (= code-reviewer C1 + comment-analyzer S3 で
 * 当初記述を訂正):
 *
 *   ADK Runner hierarchy (= `LlmAgent` + `FunctionTool` + `InMemoryRunner`) の **scaffolding 構造**
 *   が壊れていないことと、OTel span が active span として観測できることを実機 (= ADC + Vertex API)
 *   で smoke 確認する。
 *
 *   **しないこと**: 「LLM 自律 tool 呼出 → 既存関数実行 → 結果応答」の E2E は **本 Phase では成立
 *   しない**。理由: Phase 0 `AnthropicVertexLlm` に以下 2 つの未対応事項があるため:
 *     (1) `generateContentAsync` が `llmRequest.config.tools` を読まないため、Anthropic API に
 *         tool 定義 (`FunctionDeclaration[]`) が届かず、Claude は acquire_biblio / inspect_biblio /
 *         shelve_biblio の存在を知らない (= `AnthropicVertexLlm.ts:199-201`)
 *     (2) `toLlmResponse` が `content[].find(c => c.type === 'text')` で text block のみ抽出する
 *         ため、仮に Claude が `tool_use` を返しても ADK `functionCall` event に変換されない
 *         (= 同 `:349-367`)
 *   → 両者を **Phase 2 で `AnthropicVertexLlm` 拡張後** に tool 自律呼出経路が成立する。本 Phase 1
 *   では `TOOL_CALLED=false` + LLM が text 応答のみ返す経路で scaffolding が壊れていないこと
 *   (= Runner 起動 + event 列消費 + span 流出) を smoke 確認する。
 *
 * 使い方:
 *   pnpm exec tsx --import ./src/instrumentation.ts scripts/verify-phase-1-adk-local.ts
 *
 * env:
 *   ANTHROPIC_VERTEX_PROJECT_ID  — Vertex AI project ID (必須)
 *   CLOUD_ML_REGION              — Vertex region (設定推奨、未設定で 'global' フォールバック =
 *                                   `AnthropicVertexLlm.ts:128` の DEFAULT_REGION 経路)
 *   VERIFY_PHASE_1_BIBLIO        — 任意、本 Phase 1 では LLM が tool 呼出しないため未使用に等しい
 *                                   が、Phase 2 拡張後の verify で使う想定で env 接続は残す
 *
 * 出力 (stdout、後続の grep/awk が抽出する形式):
 *   TRACE_ID=<32 hex>
 *   EVENT_COUNT=<int>
 *   TOOL_CALLED=<bool>             — Phase 1 では常に false (= Phase 0 制約)、Phase 2 拡張後に true 期待
 *   FINAL_TEXT=<text>
 *
 * 出力 (stderr、エラー or 想定外経路の warn):
 *   ERROR: ADK error event: <code> — <msg>    (= I2 fix: LLM API 失敗を text-only 経路と区別)
 *
 * **GOTCHA**:
 *   - `gcloud auth ADC` 済が前提
 *   - `HTTPS_PROXY` (= OneCLI) が `aiplatform.googleapis.com` に乗ると keyless ADC が壊れる
 *     経路あり (Phase 0 GOTCHA と同じ) — 失敗時は `unset HTTPS_PROXY` or `NO_PROXY` で再試行
 *   - `shutdownOtel()` を最後に呼ばないと BatchSpanProcessor が flush されず Cloud Trace に
 *     span が届かない (M4-A Phase 4 で発見済の罠)
 *   - **`TOOL_CALLED=false` が正常**: 本 Phase 1 では Phase 0 `AnthropicVertexLlm` 制約により
 *     `true` には到達しない。Phase 2 完了後の同 script 実行で `true` への遷移を期待する
 *   - **ADK error event 検知 (I2 fix)**: LLM API 失敗 (= ADC 未設定 / quota / 503 等) が ADK runner
 *     で `errorCode` 付き event として yield された場合、本 script は exit 1 に倒して fail-fast
 *     する。これにより「LLM API 失敗」と「LLM が tool 呼ばずに text 応答 (= Phase 1 正常)」を
 *     区別できる
 */
import { trace } from '@opentelemetry/api';
import { isFinalResponse } from '@google/adk';

import { registerAnthropicVertexLlm } from '../src/adk/llm-registry-setup.js';
import { buildRootAgent } from '../src/adk/root-agent.js';
import { buildRunner } from '../src/adk/runner.js';
import { initHostProxy } from '../src/biblio/host-proxy.js';
import { setupVertexProxy } from '../src/biblio/vertex-client.js';
import { shutdownOtel } from '../src/observability/index.js';
import { log } from '../src/log.js';

async function main(): Promise<void> {
  // Phase 2 追加: host proxy 初期化 — `acquire()` 内 `github.fetch` を OneCLI proxy 経由に
  // 乗せて GH App installation token を注入する経路を有効化する。本番 main() (`src/index.ts`)
  // で実施されている初期化と同等 (= verify script 内では touch しない方針の `src/index.ts` を
  // 経由しないため、main() 同等の bootstrap を verify 内で複製する)。Phase 1 では LLM が
  // tool を呼ばないため `acquire()` が走らず本問題は発覚しなかった = Phase 2 で tool routing
  // 成立後に表面化した inflight bug の補正。
  await initHostProxy();
  setupVertexProxy();

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
  let adkErrorCode: string | undefined;
  let adkErrorMessage: string | undefined;

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
    // ADK error event 検知 (= silent-failure-hunter I2 fix): LLM API 失敗時に ADK runner は
    // throw せず `errorCode` 付き event を yield する。これを text 応答経路から区別して fail-fast。
    if (typeof event === 'object' && event !== null && 'errorCode' in event) {
      const ev = event as { errorCode?: string; errorMessage?: string };
      if (ev.errorCode) {
        adkErrorCode = ev.errorCode;
        adkErrorMessage = ev.errorMessage;
        log.error('Phase 1 verify: ADK error event received', {
          event: 'verify.phase_1.adk_error',
          error_code: ev.errorCode,
          error_message: ev.errorMessage,
        });
        break;
      }
    }
    // event 内の functionCall / functionResponse part を観察 (= LLM が tool を呼んだか、
    // = code-simplifier S11b で guard-clause 抽出した重複除去版)。
    const parts = event.content?.parts ?? [];
    for (const p of parts) {
      if (typeof p !== 'object' || p === null) continue;
      if (('functionCall' in p && p.functionCall) || ('functionResponse' in p && p.functionResponse)) {
        toolWasCalled = true;
      }
    }
    if (isFinalResponse(event)) {
      finalText = event.content?.parts?.[0]?.text ?? '';
    }
  }

  log.info('Phase 1 verify: completed', {
    event: 'verify.phase_1.complete',
    outcome: adkErrorCode ? 'adk_error' : toolWasCalled ? 'tool_called' : 'text_only',
    event_count: eventCount,
    trace_id: traceId ?? 'undefined',
    final_text_length: finalText.length,
  });

  // 結果 stdout (= verify-script / DEN さんが目視確認する形式)。
  process.stdout.write(`TRACE_ID=${traceId ?? 'undefined'}\n`);
  process.stdout.write(`EVENT_COUNT=${eventCount}\n`);
  process.stdout.write(`TOOL_CALLED=${toolWasCalled}\n`);
  process.stdout.write(`FINAL_TEXT=${finalText.replace(/\n/g, ' ')}\n`);

  if (adkErrorCode) {
    // I2 fix: LLM API 失敗 = exit 1 で text 応答経路 (= Phase 1 正常) と区別する
    process.stderr.write(`ERROR: ADK error event: ${adkErrorCode} — ${adkErrorMessage ?? '(no message)'}\n`);
    process.exitCode = 1;
  } else if (!toolWasCalled) {
    // 厳格 assertion は `scripts/verify-phase-2-adk-gke.sh` 側が担う (= GKE Pod 内で
    // TOOL_CALLED=true を強制、fail() で exit 1)。本 script は local smoke として INFO を
    // 残すだけで exit 0 を維持し、GKE 経路 verify を最終判定に委ねる設計。
    process.stderr.write(
      'INFO: LLM did not invoke any tool (text response only). ' +
        '厳格な TOOL_CALLED=true 判定は verify-phase-2-adk-gke.sh が担う。\n',
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
