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
 * `ACQUIRE_SKILL_THRESHOLD` は正整数を要求するため、`"abc"` / `"0"` / `"-5"` 等の意味的に
 * 不正な値を「設定完了」として patron に返すと、次回 `acquire()` の `resolveSkillThreshold`
 * で silent fallback (= DEFAULT 10 に倒れる) が起き、patron 認知と実態が乖離する。
 * 本関数で書き込み前に reject することで、patron への通知と DB の実態を整合させる。
 *
 * 戻り値: null = 妥当、string = patron 向けエラーメッセージ。
 */
export function validateValueForKey(key: BiblioSettingKey, value: string): string | null {
  if (key === 'ACQUIRE_SKILL_THRESHOLD') {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) {
      return `${key} は 1 以上の整数を指定してください (指定: "${value}")。`;
    }
  }
  return null;
}
