/**
 * M4-F Phase 2 gate audit log。
 *
 * gate 判定の結果を「Cloud Logging structured log」+「local `.jsonl` fallback」の 2 経路で
 * 記録する。GCP は既存 M4-A Phase 3 sink (`biblio-claw-to-bq`、`terraform/m4-a-observability/`) が Cloud Logging → BQ に自動
 * export、local docker (Cloud Logging 経路不在) は `.jsonl` にファイル追記で「残せる」。
 *
 * payload shape は既存 `src/log.ts:emitJson` の Cloud Logging reserved fields
 * (`severity` / `time` / `message`) + `getTraceLogFields()` auto spread と対称にする
 * (trace ↔ log 相関を M4-A 経路で自動確立)。
 *
 * env:
 *   - `GATE_AUDIT_LOG_PATH` (既定 `data/gate-audit.jsonl`): 出力先 path
 *   - `GATE_AUDIT_LOG_DISABLE=1`: local `.jsonl` fallback を無効化 (GCP 環境で emptyDir に
 *     書きたくない場合の退路。Cloud Logging 経路は本 env に影響されず継続発火)
 */
import fs from 'node:fs';
import path from 'node:path';

import { log } from '../log.js';
import { getTraceLogFields } from '../observability/trace-fields.js';
import type { Classification, GateLayer } from './types.js';

/** 発話中に混入した secret 等を全量保存しないための digest 上限 (200 文字)。 */
const UTTERANCE_DIGEST_MAX = 200;

/** truncate helper。200 文字を超えたら `...` suffix を付けて識別可能に。 */
function truncateDigest(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

/** gate audit log 1 件の event shape (呼出側が組み立てる)。 */
export interface GateAuditEvent {
  outcome: 'blocked' | 'allowed';
  layer: GateLayer;
  classification: Classification;
  reason: string;
  /** patron 発話 (先頭 200 文字 truncate、secret 全量保存回避)。 */
  utterance: string;
  channel: 'slack' | 'cli' | 'fugue';
  /** InboundEvent.channelType 生値。multi-channel 対応時の識別用。 */
  channelType: string;
  userId?: string | null;
}

/** payload key ↔ log field 名変換の pure helper (test で shape assert 可能に export)。 */
export function buildGateAuditPayload(event: GateAuditEvent): Record<string, unknown> {
  return {
    severity: event.outcome === 'blocked' ? 'WARNING' : 'INFO',
    message: `gate.${event.outcome}`,
    time: new Date().toISOString(),
    component: 'gate',
    ...getTraceLogFields(), // 自動 trace 相関
    gate_layer: event.layer,
    gate_classification: event.classification,
    gate_reason: event.reason,
    gate_utterance_digest: truncateDigest(event.utterance, UTTERANCE_DIGEST_MAX),
    gate_channel: event.channel,
    gate_channel_type: event.channelType,
    gate_user_id: event.userId ?? null,
  };
}

/**
 * gate audit event 1 件を (1) `log.info/warn` (Cloud Logging → BQ sink) と
 * (2) `.jsonl` local file (`fs.appendFileSync`、mode `0o600`) の 2 経路で emit する。
 *
 * throw しない契約 (呼出元 router / fugue-http は audit failure でも patron 経路を続行):
 *   - Cloud Logging 経路 (log.info/warn) は必ず発火 (log.ts 自体は silent-safe)
 *   - `.jsonl` fallback の write throw は log.error で観測、呼出元には throw しない
 *
 * `GATE_AUDIT_LOG_DISABLE=1` 時は local `.jsonl` fallback を skip (GCP 環境で emptyDir に
 * 書きたくない場合の退路)。Cloud Logging 経路は本 env に影響されない。
 */
export function appendGateAuditLog(event: GateAuditEvent): void {
  const payload = buildGateAuditPayload(event);
  // (1) Cloud Logging 経路 (既存 log.ts の emitJson で severity 判定される)
  if (event.outcome === 'blocked') {
    log.warn(payload.message as string, payload);
  } else {
    log.info(payload.message as string, payload);
  }
  // (2) local `.jsonl` fallback (GATE_AUDIT_LOG_DISABLE=1 で無効化可)
  if (process.env.GATE_AUDIT_LOG_DISABLE === '1') return;
  try {
    const auditPath = process.env.GATE_AUDIT_LOG_PATH || path.join(process.cwd(), 'data', 'gate-audit.jsonl');
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    // mode `0o600` は `O_CREAT` 時のみ適用されるため、既存ファイルへの append では反映されない。
    // 初回のみ `writeFileSync('', {mode})` で明示 create し、以降は append。
    if (!fs.existsSync(auditPath)) {
      fs.writeFileSync(auditPath, '', { mode: 0o600 });
    }
    fs.appendFileSync(auditPath, JSON.stringify(payload) + '\n');
  } catch (err) {
    log.error('gate audit log write failed', {
      event: 'gate.audit.write_failed',
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
