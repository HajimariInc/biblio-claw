// Fugue channel adapter (M4-E) の entry span helper。
//
// 3 段構造の中央に位置する `fugue.<operation>` span を生成する:
//
//   HTTP POST /v1/channels/fugue/consult   (auto server span、kind=SERVER、HttpInstrumentation)
//     └─ fugue.consult (or fugue.equip)      (この helper、kind=INTERNAL)
//          └─ biblio.list (or biblio.equip)   (`withBiblioActionSpan` 経由、M4-A 集計に相乗り)
//
// M4-A `withBiblioActionSpan` (src/biblio/action-helpers.ts:66-100) の写経で、
// span 名 / attributes / signature を Fugue channel 用に最小化した helper:
//   - span 名: `fugue.${operation}` (operation ∈ 'consult' | 'equip')
//   - kind: INTERNAL (SERVER は auto HttpInstrumentation に任せる = Slack adapter との対称性)
//   - attributes: `channel: 'fugue'` を span level で持ち、Cloud Trace UI で channel filter 可能に
//                 (M4-A biblio.* は channel-agnostic 集計を維持するため biblio 側では付与しない)
//   - `sessionId` 引数なし — Fugue channel は session 概念なし (`fugue-http.ts:441, :689` で
//     既存 `withBiblioActionSpan` に `sessionId=''` を渡している既存挙動と対称)
//   - `fugue.outcome` は helper では強制せず、呼び出し側 (`handleConsult` / `handleEquip`) が
//     分岐ごとに `span.setAttribute('fugue.outcome', ...)` する (withBiblioActionSpan の
//     `biblio.outcome` と同流儀 = outcome は domain logic が決めるべきで helper で強制しない)
import { SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api';
import { getTracer } from './otel.js';

/**
 * Fugue channel が扱う operation の closed union。
 *
 * 将来 `invoke` (skill 実行) 等を追加する場合はここに値を追加する。M4-E PRD の scope では
 * 現状 `consult` / `equip` のみで、`invoke` は WON'T 節に置かれている。
 */
export type FugueOperation = 'consult' | 'equip';

/**
 * Fugue channel の entry span を生成し、`fn` を span active state で実行する。
 *
 * 契約:
 *   - fn が正常終了 → span を UNSET status で end (呼び出し側で `setStatus` 済ならその値を保持)
 *   - fn が throw → `recordException` + ERROR status + err を re-throw (finally で必ず end)
 *   - fn 内から `withBiblioActionSpan` を呼ぶと、biblio span が子として自動的に nest される
 *     (両 helper とも同じ `getTracer('biblio-claw')` を使い、AsyncLocalStorageContextManager
 *     で active span を伝搬)
 *
 * @param operation Fugue の operation 種別 (`'consult'` | `'equip'`)。span 名は `fugue.${operation}` になる。
 * @param requestId Fugue から受け取った `request_id`。span attribute `fugue.request_id` として記録される。
 * @param fn span active state で実行する非同期関数。`span` を引数で受け取り、outcome や追加属性を
 *           `span.setAttribute` で自由に設定できる。
 * @param extraAttributes span 開始時点で追加設定する属性。呼び出し側で `fugue.mode` (consult only) 等を
 *                        span 開始時に設定するために使う。省略可 (現状呼び出し元はすべて省略、将来拡張点)。
 */
export async function withFugueEntrySpan<T>(
  operation: FugueOperation,
  requestId: string,
  fn: (span: Span) => Promise<T>,
  extraAttributes?: Record<string, string | number | boolean>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(
    `fugue.${operation}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        channel: 'fugue',
        'fugue.operation': operation,
        'fugue.request_id': requestId,
        ...(extraAttributes ?? {}),
      },
    },
    async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        // err が non-Error (= string/number throw) の場合に Cloud Trace の例外イベントと
        // ERROR status message が undefined にならないよう instanceof guard で分岐
        // (withBiblioActionSpan と同流儀、silent-failure 撲滅原則)。
        const errorRecord = err instanceof Error ? err : new Error(String(err));
        span.recordException(errorRecord);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorRecord.message });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
