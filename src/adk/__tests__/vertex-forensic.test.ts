import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VertexSecretSnapshot } from '../../sidecar/vertex-secret-snapshot.js';
import { buildVertexForensicPayload } from '../vertex-forensic.js';

// snapshot module を mock (test 決定化のため)
vi.mock('../../sidecar/vertex-secret-snapshot.js', () => ({
  getLastVertexSecretSnapshot: () => currentSnapshot,
}));

let currentSnapshot: VertexSecretSnapshot | null = null;

afterEach(() => {
  currentSnapshot = null;
});

describe('buildVertexForensicPayload', () => {
  it('snapshot 存在時、onecli_snapshot_* に snapshot 値が入る', () => {
    currentSnapshot = {
      observed_at_epoch: 1700000000,
      secret_id: 'secret-abc',
      host_pattern: 'aiplatform.googleapis.com',
      updated_at_epoch: 1699999000,
      found: true,
    };
    const payload = buildVertexForensicPayload({
      channel: 'adk',
      requestId: 'req-x',
      sessionId: 'sess-x',
      channelType: 'cli',
      authTokenIat: 1699999500,
      authTokenExp: 1700003100,
      authTokenHash: 'abc123def456',
      authCaptureError: null,
      httpStatus: 401,
      err: new Error('token expired'),
    });
    expect(payload.event).toBe('vertex.401.forensic_dump');
    expect(payload.outcome).toBe('failure');
    expect(payload.channel).toBe('adk');
    expect(payload.request_id).toBe('req-x');
    expect(payload.onecli_snapshot_id).toBe('secret-abc');
    expect(payload.onecli_snapshot_updated_at_epoch).toBe(1699999000);
    expect(payload.onecli_snapshot_found).toBe(true);
    expect(payload.auth_token_hash).toBe('abc123def456');
    expect(payload.http_status).toBe(401);
    expect(payload.err_message).toBe('token expired');
    // age_since_iat_sec は現在時刻 - iat の計算経路が生きているか
    expect(typeof payload.age_since_iat_sec).toBe('number');
  });

  it('snapshot null 時 (sidecar 起動前 or 初回 fetch 前)、onecli_snapshot_* は空/null/false でも payload は組める', () => {
    currentSnapshot = null;
    const payload = buildVertexForensicPayload({
      channel: 'onecli',
      requestId: 'req-y',
      sessionId: '',
      channelType: '',
      authTokenIat: null,
      authTokenExp: null,
      authTokenHash: '',
      authCaptureError: 'not_available_on_onecli_route',
      httpStatus: 401,
      err: new Error('401 Unauthorized'),
    });
    expect(payload.channel).toBe('onecli');
    expect(payload.onecli_snapshot_id).toBe('');
    expect(payload.onecli_snapshot_updated_at_epoch).toBeNull();
    expect(payload.onecli_snapshot_found).toBe(false);
    expect(payload.auth_capture_error).toBe('not_available_on_onecli_route');
    expect(payload.age_since_iat_sec).toBeNull();
  });

  it('pod_age_sec は process.uptime() から採る (数値 field 存在確認)', () => {
    currentSnapshot = null;
    const payload = buildVertexForensicPayload({
      channel: 'adk',
      requestId: 'req-z',
      sessionId: '',
      channelType: '',
      authTokenIat: null,
      authTokenExp: null,
      authTokenHash: '',
      authCaptureError: null,
      httpStatus: null,
      err: new Error('generic error'),
    });
    expect(typeof payload.pod_age_sec).toBe('number');
    expect(payload.pod_age_sec).toBeGreaterThanOrEqual(0);
  });
});
