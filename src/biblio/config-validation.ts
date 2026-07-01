/**
 * biblio 設定値の意味検証ヘルパ (delivery + ADK 経路共通、副作用なし)。
 *
 * `validateValueForKey` は delivery action handler (`config-action.ts`) と ADK FunctionTool
 * (`src/adk/tools/config-tool.ts`) の両方から呼ばれる。config-action.ts が `registerDeliveryAction`
 * を module-scope で発火する副作用を持つため、ADK tool 側が直接 import すると root-agent の
 * test 環境で不要な delivery pipeline 初期化が走る (= import chain 問題)。本 file は
 * `BIBLIO_SETTING_KEYS` の意味検証だけを提供する pure helper で、副作用を持たない。
 *
 * 将来 key を追加する場合:
 *   1. `src/biblio/types.ts` の `BIBLIO_SETTING_KEYS` に追記
 *   2. 本 `validateValueForKey` に case を追加
 *   → delivery + ADK 両経路が反映される (= 単一更新点)
 */
import type { BiblioSettingKey } from './types.js';

/**
 * key ごとの value semantic validation。allowlist 通過後に呼ぶ。
 *
 * `ACQUIRE_SKILL_THRESHOLD` は正整数を要求するため、`"abc"` / `"0"` / `"-5"` / `"10.5"` 等の
 * 意味的に不正な値を「設定完了」として patron に返すと、次回 `acquire()` の
 * `resolveSkillThreshold` で silent fallback (= DEFAULT 10 に倒れる) or 非整数閾値の暗黙採用が
 * 起き、patron 認知と実態が乖離する。本関数で書き込み前に reject することで、patron への通知と
 * DB の実態を整合させる。
 *
 * **Phase 4 review I3 対応**: `Number.parseInt('10.5', 10) === 10` で先頭 int 部分が拾われる
 * ため小数文字列が **素通し**して DB に literal 保存されるバグがあった。`Number.isInteger(Number(value))`
 * を追加して整数のみ受理する。既存の非数値 / 0 / 負数 reject は維持。LLM 経由 (`update_config`
 * tool) からの露出面拡大に対応。
 *
 * 戻り値: null = 妥当、string = patron 向けエラーメッセージ。
 */
export function validateValueForKey(key: BiblioSettingKey, value: string): string | null {
  if (key === 'ACQUIRE_SKILL_THRESHOLD') {
    // 小数拒否 (I3): `Number("10.5") === 10.5` で `Number.isInteger` が false になる。
    // `parseInt` は "10.5" → 10 で通してしまうため、`Number` で全体を評価する。
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
      return `${key} は 1 以上の整数を指定してください (指定: "${value}")。`;
    }
  }
  return null;
}
