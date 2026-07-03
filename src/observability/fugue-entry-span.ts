// Fugue channel adapter (M4-E) の entry span helper。
//
// **Phase 4 での trace 構造 (2 段、review C1 対応で明示)**:
//
//   fugue.consult (or fugue.equip)  (この helper、kind=INTERNAL)
//     └─ biblio.list (or biblio.equip)  (`withBiblioActionSpan` 経由、M4-A 集計に相乗り)
//
// **auto HTTP SERVER span 層は Phase 5 で 2 段構造を正式化として確定**:
// 本 repo は `"type": "module"` の純 ESM プロジェクトで、起動は `node --import
// ./dist/instrumentation.js`。`@opentelemetry/instrumentation-http` の core module patch は
// `require-in-the-middle` に依存し、ESM で機能させるには `module.register()` 等の
// ESM フックが別途必要 (本 repo に未整備)。Phase 5 の ESM フック判断で **2 段構造を正式仕様として
// 採用** (Node 24.15.0 `module.register()` DEP0205 documentation-only 非推奨化 + Node 26.0.0
// runtime deprecation 予定を根拠に 3 段化投資を見送り、詳細: `docs/operations-runbook.md`
// §M4-E Phase 4 §ESM フック判断)。
//
// **将来 auto server span 層が発火するようになった際の親子関係 (保険設計)**:
// `withFugueEntrySpan` は `tracer.startActiveSpan()` で child span を生成するため、その時点で
// active context に SERVER span があれば自動的にその子として nest される
// (`extractTraceContextFromHttpHeaders` の base が `context.active()` = 破壊しない設計)。
// = 2 段構造は「実質 3 段が発火しないから 2 段」に留めているだけで、将来 auto SERVER span 層
// が発火すれば AsyncLocalStorage 経由で自動的に 3 段化される可逆判断。
//
// M4-A `withBiblioActionSpan` (src/biblio/action-helpers.ts の `withBiblioActionSpan` 関数) の
// 写経で、span 名 / attributes / signature を Fugue channel 用に最小化した helper:
//   - span 名: `fugue.${operation}` (operation ∈ 'consult' | 'equip')
//   - kind: INTERNAL (2 段構造 = 上に SERVER 層を積まない、上記 ESM フック判断で確定)
//   - attributes: `channel: 'fugue'` を span level で持ち、Cloud Trace UI で channel filter 可能に
//                 (M4-A biblio.* は channel-agnostic 集計を維持するため biblio 側では付与しない)
//   - `sessionId` 引数なし — Fugue channel は session 概念なし (`fugue-http.ts` の handleConsult /
//     handleEquip 内で既存 `withBiblioActionSpan` に `sessionId=''` を渡している既存挙動と対称)
//   - `fugue.outcome` は helper では強制せず、呼び出し側 (`handleConsult` / `handleEquip`) が
//     分岐ごとに `span.setAttribute('fugue.outcome', ...)` する (withBiblioActionSpan の
//     `biblio.outcome` と同流儀 = outcome は domain logic が決めるべきで helper で強制しない)
//   - **catch 経路のデフォルト outcome** (Phase 4 review I1、silent-failure #1 対応):
//     fn throw 時に `span.setAttribute('fugue.outcome', 'error')` を無条件で追加。呼び出し側の
//     成功経路で set された outcome は throw より前に評価されるため、catch 経路で「throw =
//     必ず error」を上書きしても意味論の破壊はない (throw したなら outcome は error が正)。
//     これにより、成功経路の未想定例外 (`readListEnv` / `toSkillRefs` / `summarizeConsult` 等)
//     で outcome 属性が欠落し Cloud Trace の outcome ダッシュボードから消える silent failure を撲滅する。
import { SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api';
import { getTracer } from './otel.js';

/**
 * Fugue channel が扱う operation の closed union。
 *
 * 将来 `invoke` (skill 実行) 等を追加する場合はここに値を追加する。M4-E PRD の scope では
 * 現状 `consult` / `equip` のみで、`invoke` は将来検討事項として位置付けられている
 * (詳細は非公開 PRD の scope 節、public 化時に本コメントは残置で参照不能になる点は許容)。
 */
export type FugueOperation = 'consult' | 'equip';

/**
 * Fugue channel の entry span を生成し、`fn` を span active state で実行する。
 *
 * 契約:
 *   - fn が正常終了 → span を UNSET status で end (呼び出し側で `setStatus` 済ならその値を保持)
 *   - fn が throw → `span.setAttribute('fugue.outcome', 'error')` を追加 (Phase 4 review I1) +
 *     `recordException` + ERROR status + err を re-throw (finally で必ず end)
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
        // Phase 4 review I1 (silent-failure #1): throw 経路では必ず outcome=error を反映。
        // 成功経路で `writeJson` 後に `setAttribute('fugue.outcome', ...)` を呼ぶ現行実装では、
        // その setAttribute より後段 (readListEnv / toSkillRefs / summarizeConsult 等) の未想定
        // 例外で outcome 属性が両方欠落し、Cloud Trace の outcome ベースダッシュボードから
        // このクラスの failure が消える silent failure が発生していた。catch 経路での上書きは
        // 「throw したなら outcome は必ず error が正」なので意味論的に安全。
        span.setAttribute('fugue.outcome', 'error');
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
