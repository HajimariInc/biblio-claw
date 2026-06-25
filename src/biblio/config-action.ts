/**
 * Delivery action handler — `update_config` (= patron が `@bot 設定 KEY VALUE` で
 * biblio 設定値を動的変更する経路、個別 PRD individual-skill-shiire Phase 5)。
 *
 * 経路:
 *   1. agent (Claude) が `update_config` MCP tool で outbound.db に system action を書く
 *      (content: `{ action, key, value }`)
 *   2. delivery poll がここを呼ぶ → 入力 validate → allowlist check → admin check →
 *      key-specific value validation → `setBiblioSetting()` で central DB に upsert →
 *      `writeBackMessage` で patron に通知
 *
 * acquire-action.ts と同形 (= 入口 validate + try/catch + writeBackMessage)。
 *
 * 差分: HITL approval は使わない (= 設定変更は patron 単独完結、enkin/shokyaku のような重大
 * 破壊操作ではない、admin check で十分)。
 *
 * # admin check の制約
 *
 * 既存 delivery action handler は session に紐づく **patron 個人の userId** を直接持たない
 * (= agent container 経由の fire-and-forget 経路で、`acquire-action.ts` 等もユーザー単位の
 * 認可をしない設計)。本 handler でも session-scoped per-user 厳密 check は実装できないため、
 * 次の方針で gating する:
 *
 *   - `user_roles` table 不在 (= permissions モジュール未インストール) → allow-all
 *     (= `command-gate.ts:isAdmin` の「table 不在 → allow-all」フォールバックのみ流儀を踏襲。
 *     コア実装は別 — command-gate は per-user で `WHERE user_id = ?` バインド、本関数は
 *     userId が取れないため意図的に省略し agent_group スコープのみで判定する)
 *   - 該当 `agent_group_id` にスコープが当たる owner / admin 行が 1 件もない → deny
 *     (= 「設定変更責任者を誰も登録していない agent_group」では設定を変えさせない最低限の保険)
 *
 * 将来 (別 PRD) で session → 最新 inbound message → sender userId の逆引き経路を整備したら、
 * この関数を per-user 厳密 check に書き換える。
 */
import { registerDeliveryAction } from '../delivery.js';
import { getDb, hasTable } from '../db/connection.js';
import { setBiblioSetting } from '../db/biblio-settings.js';
import { log } from '../log.js';
import { writeBackMessage } from './action-helpers.js';
import { BIBLIO_SETTING_KEYS, type BiblioSettingKey } from './types.js';
import type { Session } from '../types.js';

/** `BIBLIO_SETTING_KEYS` allowlist の type guard (= 文字列 key を型レベルで絞り込む)。 */
function isAllowlistedKey(key: string): key is BiblioSettingKey {
  return (BIBLIO_SETTING_KEYS as readonly string[]).includes(key);
}

/**
 * 該当 agent_group に admin / owner が紐づくか (= session-scoped 認可の最低保険)。
 *
 * `user_roles` table が存在しない (= permissions モジュール未インストール) なら allow-all。
 * 存在する場合は agent_group に紐づく owner / global admin / scoped admin のいずれかが
 * 1 行でもあれば allow、無ければ deny する。
 */
export function isConfigChangeAllowed(session: Session): boolean {
  const db = getDb();
  if (!hasTable(db, 'user_roles')) return true;
  const row = db
    .prepare(
      `SELECT 1 FROM user_roles
       WHERE (role = 'owner' OR role = 'admin')
         AND (agent_group_id IS NULL OR agent_group_id = ?)
       LIMIT 1`,
    )
    .get(session.agent_group_id);
  return row != null;
}

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
function validateValueForKey(key: BiblioSettingKey, value: string): string | null {
  if (key === 'ACQUIRE_SKILL_THRESHOLD') {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) {
      return `${key} は 1 以上の整数を指定してください (指定: "${value}")。`;
    }
  }
  return null;
}

registerDeliveryAction('update_config', async (content, session, inDb) => {
  const key = typeof content.key === 'string' ? content.key.trim() : '';
  const value = typeof content.value === 'string' ? content.value.trim() : '';
  const requestId = crypto.randomUUID();

  log.info('update_config from agent', {
    event: 'biblio.config',
    key,
    value,
    session_id: session.id,
    request_id: requestId,
  });

  // handler 全体を try/catch で囲む — admin check / allowlist check / value validation 等の
  // 経路で `getDb()` 等が throw した場合に host を巻き込まないように、writeBackMessage まで
  // 必ず完結させる (= delivery action handler は絶対に throw しない不変条件)。
  try {
    // 1. validate (= key/value 空チェック)
    if (!key || !value) {
      log.warn('update_config: missing key or value', {
        event: 'biblio.config',
        outcome: 'failure',
        key,
        value,
        session_id: session.id,
        request_id: requestId,
      });
      await writeBackMessage(
        inDb,
        '設定エラー (invalid_input): key と value を両方指定してください。',
        'config-resp',
        'update_config',
      );
      return;
    }

    // 2. allowlist check (whitelist 方式 — `BIBLIO_SETTING_KEYS` に無い key は全 reject)
    if (!isAllowlistedKey(key)) {
      log.warn('update_config: key not in allowlist', {
        event: 'biblio.config',
        outcome: 'failure',
        key,
        session_id: session.id,
        request_id: requestId,
      });
      await writeBackMessage(
        inDb,
        `設定エラー (invalid_key): 設定可能な key は ${BIBLIO_SETTING_KEYS.join(', ')} のみです (指定: "${key}")。`,
        'config-resp',
        'update_config',
      );
      return;
    }

    // 3. key-specific value validation (詳細は validateValueForKey の JSDoc 参照)。
    const valueErr = validateValueForKey(key, value);
    if (valueErr !== null) {
      log.warn('update_config: invalid value for key', {
        event: 'biblio.config',
        outcome: 'failure',
        key,
        value,
        session_id: session.id,
        request_id: requestId,
      });
      await writeBackMessage(inDb, `設定エラー (invalid_value): ${valueErr}`, 'config-resp', 'update_config');
      return;
    }

    // 4. admin check (= 該当 agent_group に admin/owner が紐づくか、user_roles 不在なら allow-all)
    if (!isConfigChangeAllowed(session)) {
      log.warn('update_config: not allowed (no admin/owner in agent group)', {
        event: 'biblio.config',
        outcome: 'failure',
        key,
        agent_group_id: session.agent_group_id,
        session_id: session.id,
        request_id: requestId,
      });
      await writeBackMessage(
        inDb,
        '設定エラー (permission_denied): 設定変更は admin / owner のみ可能です。',
        'config-resp',
        'update_config',
      );
      return;
    }

    // 5. apply — DB upsert + 完了通知 + 構造化 log
    setBiblioSetting(key, value);
    await writeBackMessage(inDb, `設定完了: ${key} = ${value}`, 'config-resp', 'update_config');
    log.info('update_config done', {
      event: 'biblio.config',
      outcome: 'success',
      key,
      value,
      session_id: session.id,
      request_id: requestId,
    });
  } catch (err) {
    log.error('update_config threw', {
      event: 'biblio.config',
      outcome: 'failure',
      key,
      value,
      session_id: session.id,
      request_id: requestId,
      err,
    });
    const detail = err instanceof Error ? err.message : String(err);
    await writeBackMessage(inDb, `設定エラー (internal): 予期しない失敗 — ${detail}`, 'config-resp', 'update_config');
  }
});
