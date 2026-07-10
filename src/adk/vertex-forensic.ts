/**
 * issue #136 B (Step 5-a): 401 発生時 (経路 1/2 共通) に emit する forensic dump の
 * payload builder。
 *
 * 分散した state (uptime / rotator snapshot / auth capture / trace) を 1 event に集約する
 * ことで、後から `kubectl logs` を grep して現場を再構築する手間をゼロにする (= "その 1
 * ログ行で拾える" DoD)。
 *
 * emit 経路 (2 箇所):
 *   1. `src/adk/AnthropicVertexLlm.ts` の catch 節、401 判定時 (channel='adk')
 *   2. `src/biblio/vertex-client.ts` の !res.ok 分岐、status===401 時 (channel='onecli')
 *
 * 経路の非対称性:
 *   - 経路 1 (adk): SDK 層で pre-flight Authorization capture 可能 (Step 3-b)。
 *     auth_token_iat / exp / hash / capture_error に実値が入る
 *   - 経路 2 (onecli): SDK 層 capture 不能 (OneCLI MITM が wire で置換)。
 *     auth_token_* は空値、代わりに rotator log の token_hash を BQ で JOIN する運用
 */

import type { Span } from '@opentelemetry/api';

import { getTraceLogFields } from '../observability/trace-fields.js';
import { getLastVertexSecretSnapshot } from '../sidecar/vertex-secret-snapshot.js';

export type VertexForensicChannel = 'adk' | 'onecli';

export interface BuildVertexForensicPayloadInput {
  channel: VertexForensicChannel;
  requestId: string;
  sessionId: string;
  channelType: string;
  authTokenIat: number | null;
  authTokenExp: number | null;
  authTokenHash: string;
  authCaptureError: string | null;
  httpStatus: number | null;
  err: Error;
  span?: Span;
}

/**
 * 401 forensic dump payload を構築する pure function。
 *
 * 副作用:
 *   - `getLastVertexSecretSnapshot()` を呼んで module-level state を読む (副作用に見えるが
 *     read のみ = 純粋関数扱い、test は snapshot mock で決定的化可能)
 *
 * 戻り値は `log.error` にそのまま流し込む Record<string, unknown> (BQ jsonPayload.* に
 * 直接昇格される field 群)。
 */
export function buildVertexForensicPayload(input: BuildVertexForensicPayloadInput): Record<string, unknown> {
  const snapshot = getLastVertexSecretSnapshot();
  return {
    event: 'vertex.401.forensic_dump',
    outcome: 'failure',
    channel: input.channel,
    request_id: input.requestId,
    session_id: input.sessionId,
    channel_type: input.channelType,
    // Node process 起動秒数 (= Pod age proxy)。K8s Pod 起動時刻とは別 (runbook §M4-B で明記)。
    pod_age_sec: Math.round(process.uptime()),
    auth_token_iat: input.authTokenIat,
    auth_token_exp: input.authTokenExp,
    auth_token_hash: input.authTokenHash,
    auth_capture_error: input.authCaptureError,
    age_since_iat_sec: input.authTokenIat != null ? Math.floor(Date.now() / 1000) - input.authTokenIat : null,
    // OneCLI secret snapshot state (両経路共通、経路 2 の rotator 経路との相関に使う)。
    onecli_snapshot_id: snapshot?.secret_id ?? '',
    onecli_snapshot_updated_at_epoch: snapshot?.updated_at_epoch ?? null,
    onecli_snapshot_observed_at_epoch: snapshot?.observed_at_epoch ?? null,
    onecli_snapshot_found: snapshot?.found ?? false,
    http_status: input.httpStatus,
    err_message: input.err.message,
    ...getTraceLogFields(input.span),
  };
}
