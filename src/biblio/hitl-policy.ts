/**
 * HITL 承認要否の政策関数 (M4-E Phase 3 equip-hitl)。
 *
 * Fugue 側契約 (`biblio-claw-required-changes.md` §6.2) の `requires_approval(operation, channel)`
 * matrix をそのまま宣言する pure な関数。副作用なし、外部依存なし = `config-validation.ts`
 * と同流儀の独立 helper file (import chain 問題の予防、副作用ファイルとの分離)。
 *
 * ## 現状の呼び出し元
 *
 * この関数を参照するのは **Fugue equip 経路のみ** (`fugue-http.ts:handleEquip` の冒頭 guard)。
 * 既存の HITL (enkin / shokyaku) 経路は **各 action ファイル側のハードコード分岐**が正:
 *
 *   - `src/biblio/enkin-action.ts` の `requestApproval` 呼出
 *   - `src/biblio/shokyaku-action.ts` の `requestApproval` 呼出
 *   - `src/adk/tools/enkin-tool.ts` / `shokyaku-tool.ts` の `requestConfirmation` 呼出
 *
 * これらは agent group の messaging pipeline (Slack DM / ADK Runner) と密結合しており、
 * 「HITL 要」判定は分岐時点で自明。本関数を経由させる refactor は **意図的にしない**
 * (最小差分アプローチ、regression リスクゼロ、意思決定ログ #4)。
 *
 * ## 本関数の役割
 *
 * 1. **政策宣言**: Fugue 契約 §6.2 の matrix をコード上の single source of truth として置く
 * 2. **Fugue equip 経路の guard**: 「equip@fugue = 承認なし」の簡略化を実装で担保
 * 3. **将来の集中化 anchor**: 政策が変わった場合 / Slack/ADK 経路にも equip tool が
 *    追加された場合 (`M3 Phase 3.5` 申し送り) に、本関数を経由する形で集約する起点
 *
 * ## Matrix (Fugue 契約 §6.2)
 *
 * | operation | slack | fugue |
 * | --------- | ----- | ----- |
 * | consult   | false | false |
 * | equip     | true  | **false** (簡略化) |
 * | shiire (= acquire+shelve 系) | true | true |
 * | tekkyo (= enkin/shokyaku 系) | true | true |
 *
 * `shiire` / `tekkyo` は棚の状態を変える破壊操作のため channel を問わず HITL 承認を要求する
 * (Fugue Director の信頼度が高くても、棚は共有資産 = 変更は必ず人間承認)。`equip@fugue` のみ
 * 装備状態が channel-scoped で closure しているため簡略化する (Fugue Director は 1 人前提)。
 */

/** HITL 判定対象の channel 種別。Slack / Fugue の 2 種のみ (ADK は Slack 内で動くため slack 扱い)。 */
export type HitlChannel = 'slack' | 'fugue';

/**
 * HITL 判定対象の operation 種別。
 *
 * - `consult` — 棚検索 (読み取り、副作用なし)
 * - `equip` — 装備状態の変更 (channel 内で closure、他 channel に影響なし)
 * - `shiire` — 仕入れ + 陳列 (棚の状態を変える破壊操作の代表)
 * - `tekkyo` — 撤去 (禁書 = enkin / 焼却 = shokyaku 系、棚から除去する破壊操作)
 *
 * `shiire` は acquire/inspect/categorize/shelve の 4 action を包む論理単位、`tekkyo` は
 * enkin/shokyaku を包む論理単位。個別の action 名 (acquire 等) を引数にすると本関数が
 * 「実装知識の集約点」に肥大化するため、Fugue 契約 §6.2 と同じ論理粒度に閉じる。
 */
export type HitlOperation = 'consult' | 'equip' | 'shiire' | 'tekkyo';

/**
 * Fugue 契約 §6.2 の requires_approval matrix。
 *
 * 実装は素直な if 連鎖で書く (matrix の直訳)。将来 channel / operation が増えたら
 * exhaustive check を導入する余地は残すが、現状は 2×4 = 8 通りに閉じるため簡潔さ優先。
 */
export function requiresApproval(operation: HitlOperation, channel: HitlChannel): boolean {
  // Fugue equip = HITL 簡略化 (装備状態が channel-scoped で closure、Fugue Director 1 人前提)
  if (channel === 'fugue' && operation === 'equip') return false;
  // 破壊操作 (棚状態変更) は channel を問わず HITL
  if (operation === 'shiire' || operation === 'tekkyo') return true;
  // 上記以外の equip = HITL (Slack 経路の equip は現状経路なし = M3 Phase 3.5 申し送り、
  // 実装されたら本 branch が実効化する)
  if (operation === 'equip') return true;
  // consult は読み取り = HITL 不要
  return false;
}
