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

/**
 * audit event の channel 分類 (closed union、silent-failure-hunter I4 + type-design 所見 1 対応)。
 *
 * `'other'` は「slack/cli/fugue 以外の将来 channel or 判定不能」の防御的 fallback。将来 Discord/
 * Teams 等の adapter が追加され routeInbound に流れ込んだ際、audit trail が silent に `'slack'`
 * に misattribute される罠を回避する。
 */
export type GateAuditChannel = 'slack' | 'cli' | 'fugue' | 'other';

/**
 * gate audit log 1 件の event shape (呼出側が組み立てる)。
 *
 * silent-failure-hunter I5 対応で `outcome:'error'` variant を追加 (gate 自体の throw を audit
 * trail に載せて `event='gate.classified'` / `component='gate'` 集計から silent undercount する
 * のを防ぐ)。`outcome:'error'` は layer / classification が確定していない状態なので、
 * discriminated union で余計なフィールドを持たない (blocked/allowed variant は従来通り)。
 */
export type GateAuditEvent =
  | {
      outcome: 'blocked' | 'allowed';
      layer: GateLayer;
      classification: Classification;
      reason: string;
      /** patron 発話 (先頭 200 文字 truncate、secret 全量保存回避)。 */
      utterance: string;
      channel: GateAuditChannel;
      /** InboundEvent.channelType 生値。multi-channel 対応時の識別用。 */
      channelType: string;
      userId?: string | null;
      /** Layer 4 evaluator が失敗し fallback biblio-other を返した場合 true (I6 対応)。 */
      degraded?: boolean;
    }
  | {
      outcome: 'error';
      /** gate 自体の throw 理由 (Layer 4 内部 fallback を超えた稀ケース)。 */
      reason: string;
      utterance: string;
      channel: GateAuditChannel;
      channelType: string;
      userId?: string | null;
    };

/** payload key ↔ log field 名変換の pure helper (test で shape assert 可能に export)。 */
export function buildGateAuditPayload(event: GateAuditEvent): Record<string, unknown> {
  const base: Record<string, unknown> = {
    severity: event.outcome === 'blocked' ? 'WARNING' : event.outcome === 'error' ? 'ERROR' : 'INFO',
    message: `gate.${event.outcome}`,
    time: new Date().toISOString(),
    component: 'gate',
    ...getTraceLogFields(), // 自動 trace 相関
    gate_reason: event.reason,
    gate_utterance_digest: truncateDigest(event.utterance, UTTERANCE_DIGEST_MAX),
    gate_channel: event.channel,
    gate_channel_type: event.channelType,
    gate_user_id: event.userId ?? null,
  };
  if (event.outcome === 'error') {
    // layer / classification は確定していないため null で明示
    base.gate_layer = null;
    base.gate_classification = null;
  } else {
    base.gate_layer = event.layer;
    base.gate_classification = event.classification;
    if (event.degraded) base.gate_degraded = true;
  }
  return base;
}

/**
 * `.jsonl` write fail のカウンタ (silent-failure-hunter I12 対応)。misconfigured
 * `GATE_AUDIT_LOG_PATH` (read-only mount 等) で毎 gate 呼出で `log.error` が発火する
 * flood を抑制しつつ、累積失敗数を N 件ごとに再度可視化する。process 単位の in-memory
 * counter、Pod 再起動で reset (local docker path でしか実質発火しない = GKE は
 * `GATE_AUDIT_LOG_DISABLE=1` 前提)。
 */
let jsonlWriteFailCount = 0;
const JSONL_WRITE_FAIL_LOG_INTERVAL = 100;

/**
 * gate audit event 1 件を (1) `log.info/warn/error` (Cloud Logging → BQ sink) と
 * (2) `.jsonl` local file (`fs.appendFileSync`、mode `0o600`) の 2 経路で emit する。
 *
 * throw しない契約 (呼出元 router / fugue-http は audit failure でも patron 経路を続行):
 *   - Cloud Logging 経路 (log.info/warn/error) は必ず発火 (log.ts 自体は silent-safe)
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
  } else if (event.outcome === 'error') {
    log.error(payload.message as string, payload);
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
    // 成功したら counter を 0 に戻す (transient error の後の回復を明示的に log)
    if (jsonlWriteFailCount > 0) {
      log.info('gate audit log write recovered', {
        event: 'gate.audit.write_recovered',
        prior_failure_count: jsonlWriteFailCount,
      });
      jsonlWriteFailCount = 0;
    }
  } catch (err) {
    // I12: rate-limited error log (1 件目 + N 件ごとの milestone)。毎 gate 呼出で
    // log.error が flood すると Cloud Logging の cost / SLA に影響する。
    jsonlWriteFailCount++;
    if (jsonlWriteFailCount === 1 || jsonlWriteFailCount % JSONL_WRITE_FAIL_LOG_INTERVAL === 0) {
      log.error('gate audit log write failed', {
        event: 'gate.audit.write_failed',
        total_failures: jsonlWriteFailCount,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** test で counter を reset するための helper (module scope 変数への直接アクセスを避ける)。 */
export function _resetJsonlWriteFailCounter(): void {
  jsonlWriteFailCount = 0;
}
