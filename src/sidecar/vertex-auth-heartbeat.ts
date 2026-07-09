/**
 * issue #136 C (Step 6): 5min 周期で Vertex 認証 heartbeat probe を実行、両経路の疎通を
 * patron 発話を待たず検知する。probe 失敗が連続したら Cloud Monitoring alert (Step 8)
 * 経由で Slack 通知に飛ばす前提。
 *
 * 2 経路の probe:
 *   1. ADK 経路 (`AnthropicVertex.messages.create` の最小 call) → keyless ADC +
 *      google-auth-library 経路の疎通確認
 *   2. OneCLI 経路 (undici fetch で `aiplatform.googleapis.com/v1/publishers/anthropic/models`)
 *      → OneCLI MITM 経由の疎通確認
 *
 * 写経元: src/sidecar/ca-secret-sync.ts (SchedulerProvider 経由の周期 loop) +
 * src/adapters/scheduler/local.ts:56-70 (FATAL_FAILURE_THRESHOLD 再 escalation pattern)。
 *
 * silent failure 撲滅:
 *   - probe 失敗は log.error で forensic dump 相当の payload を残す (buildVertexForensicPayload
 *     経由、request_id は 'heartbeat' 固定で通常 request と区別)
 *   - consecutive 失敗が threshold に到達したら log.fatal で再 escalate
 *   - 429 (rate limit) は false positive を避けるため fatal counter に含めない
 *     (Vertex quota は heartbeat の実行間隔 5min で消費される可能性がある)
 */

import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { GoogleAuth } from 'google-auth-library';

import { getSchedulerProvider, type SchedulerProvider } from '../adapters/scheduler/index.js';
import { buildVertexForensicPayload } from '../adk/vertex-forensic.js';
import { log } from '../log.js';

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const HEARTBEAT_FATAL_THRESHOLD = 3;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_MODEL = 'claude-sonnet-4-6';

let scheduler: SchedulerProvider | null = null;
const consecutiveFailures = { adk: 0, onecli: 0 };

/** test / verify 用 getter (直接 export はせず、内部 state の意図しない mutation を防ぐ)。 */
export function getVertexAuthHeartbeatFailureCounts(): { adk: number; onecli: number } {
  return { ...consecutiveFailures };
}

async function probeAdkRoute(): Promise<void> {
  const region = process.env.CLOUD_ML_REGION ?? 'global';
  const projectId = process.env.ANTHROPIC_VERTEX_PROJECT_ID ?? '';
  if (!projectId) {
    log.warn('vertex-auth-heartbeat (adk): ANTHROPIC_VERTEX_PROJECT_ID unset, skipping probe', {
      event: 'vertex.auth.heartbeat_skip',
      channel: 'adk',
      reason: 'project_id_unset',
    });
    return;
  }
  const googleAuth = new GoogleAuth({
    scopes: 'https://www.googleapis.com/auth/cloud-platform',
    projectId,
  });
  const client = new AnthropicVertex({ region, projectId: projectId || null, googleAuth });
  const probeModel = process.env.HEARTBEAT_PROBE_MODEL ?? DEFAULT_HEARTBEAT_MODEL;
  try {
    // 最小コスト probe: max_tokens=1 + role='user' + content='ping' = ~5 tokens。
    // 12 回/h × 24h = 288 call/day = ~1440 tokens/day (M4-C pricing で $0.001 未満/day)。
    await client.messages.create({
      model: probeModel,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
    consecutiveFailures.adk = 0;
    log.info('vertex.auth.heartbeat_ok (adk)', {
      event: 'vertex.auth.heartbeat_ok',
      channel: 'adk',
      outcome: 'success',
      model: probeModel,
    });
  } catch (err) {
    const errorRecord = err instanceof Error ? err : new Error(String(err));
    const httpStatus = (err as { status?: number })?.status ?? null;
    // 429 (rate limit) は heartbeat 実行が quota を圧迫した false positive の可能性 =
    // fatal counter には含めない。ただし観察はする (silent 化しない)。
    if (httpStatus === 429) {
      log.warn('vertex.auth.heartbeat rate-limited (adk) — not counted as failure', {
        event: 'vertex.auth.heartbeat_rate_limited',
        channel: 'adk',
        outcome: 'rate_limited',
        err: errorRecord.message,
      });
      return;
    }
    consecutiveFailures.adk += 1;
    log.error(
      'vertex.auth.heartbeat_failed (adk)',
      buildVertexForensicPayload({
        channel: 'adk',
        requestId: 'heartbeat',
        sessionId: '',
        channelType: 'heartbeat',
        authTokenIat: null,
        authTokenExp: null,
        authTokenHash: '',
        authCaptureError: 'skipped_in_heartbeat_path',
        httpStatus,
        err: errorRecord,
      }),
    );
    if (
      consecutiveFailures.adk >= HEARTBEAT_FATAL_THRESHOLD &&
      consecutiveFailures.adk % HEARTBEAT_FATAL_THRESHOLD === 0
    ) {
      log.fatal('vertex.auth.heartbeat consecutive failures (adk)', {
        event: 'vertex.auth.heartbeat_fatal',
        channel: 'adk',
        consecutive_failures: consecutiveFailures.adk,
        threshold: HEARTBEAT_FATAL_THRESHOLD,
      });
    }
  }
}

async function probeOneCliRoute(): Promise<void> {
  const region = process.env.CLOUD_ML_REGION ?? 'global';
  const host = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/publishers/anthropic/models`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer placeholder' },
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    consecutiveFailures.onecli = 0;
    log.info('vertex.auth.heartbeat_ok (onecli)', {
      event: 'vertex.auth.heartbeat_ok',
      channel: 'onecli',
      outcome: 'success',
    });
  } catch (err) {
    const errorRecord = err instanceof Error ? err : new Error(String(err));
    const httpStatus = (err as { status?: number })?.status ?? null;
    if (httpStatus === 429) {
      log.warn('vertex.auth.heartbeat rate-limited (onecli) — not counted as failure', {
        event: 'vertex.auth.heartbeat_rate_limited',
        channel: 'onecli',
        outcome: 'rate_limited',
        err: errorRecord.message,
      });
      return;
    }
    consecutiveFailures.onecli += 1;
    log.error(
      'vertex.auth.heartbeat_failed (onecli)',
      buildVertexForensicPayload({
        channel: 'onecli',
        requestId: 'heartbeat',
        sessionId: '',
        channelType: 'heartbeat',
        authTokenIat: null,
        authTokenExp: null,
        authTokenHash: '',
        authCaptureError: 'not_available_on_onecli_route',
        httpStatus,
        err: errorRecord,
      }),
    );
    if (
      consecutiveFailures.onecli >= HEARTBEAT_FATAL_THRESHOLD &&
      consecutiveFailures.onecli % HEARTBEAT_FATAL_THRESHOLD === 0
    ) {
      log.fatal('vertex.auth.heartbeat consecutive failures (onecli)', {
        event: 'vertex.auth.heartbeat_fatal',
        channel: 'onecli',
        consecutive_failures: consecutiveFailures.onecli,
        threshold: HEARTBEAT_FATAL_THRESHOLD,
      });
    }
  }
}

/** 1 tick = 両経路を並列 probe。片方の throw が他方をキャンセルしないよう Promise.all は
 *  避け、各 probe 内 catch で完結させる (両 probe が同 tick で失敗する経路も観察できる)。 */
export async function heartbeatTick(): Promise<void> {
  await Promise.all([probeAdkRoute(), probeOneCliRoute()]);
}

export function startVertexAuthHeartbeat(): void {
  if (scheduler) {
    log.warn('startVertexAuthHeartbeat called twice — ignoring second call');
    return;
  }
  scheduler = getSchedulerProvider(HEARTBEAT_INTERVAL_MS);
  log.info('vertex-auth-heartbeat started', {
    interval_ms: HEARTBEAT_INTERVAL_MS,
    fatal_threshold: HEARTBEAT_FATAL_THRESHOLD,
  });
  scheduler.start(() => heartbeatTick());
}

export function stopVertexAuthHeartbeat(): void {
  if (scheduler) {
    scheduler.stop();
    scheduler = null;
    consecutiveFailures.adk = 0;
    consecutiveFailures.onecli = 0;
  }
}
