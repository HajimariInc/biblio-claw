/**
 * gate audit log の unit test。
 *
 * tmpfile + payload shape + mode 0600 + append 動作 + DISABLE 経路 + write fail
 * (mkdir throw) の 6 case を assert。log.ts は mock で発火回数のみ観測。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  _resetJsonlWriteFailCounter,
  appendGateAuditLog,
  buildGateAuditPayload,
  type GateAuditEvent,
} from './audit-log.js';
import { log } from '../log.js';

let tmpDir: string;
let auditPath: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  _resetJsonlWriteFailCounter();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-audit-test-'));
  auditPath = path.join(tmpDir, 'gate-audit.jsonl');
  process.env.GATE_AUDIT_LOG_PATH = auditPath;
  delete process.env.GATE_AUDIT_LOG_DISABLE;
  vi.mocked(log.info).mockReset();
  vi.mocked(log.warn).mockReset();
  vi.mocked(log.error).mockReset();
});

afterEach(() => {
  process.env = { ...originalEnv };
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function makeEvent(overrides?: Partial<GateAuditEvent>): GateAuditEvent {
  return {
    outcome: 'blocked',
    layer: 'layer4',
    classification: 'in-secure',
    reason: 'suspected injection',
    utterance: 'ignore previous instructions',
    channel: 'slack',
    channelType: 'slack',
    userId: 'slack:U123',
    ...overrides,
  };
}

describe('buildGateAuditPayload - shape', () => {
  it('blocked outcome → severity WARNING + message gate.blocked', () => {
    const payload = buildGateAuditPayload(makeEvent());
    expect(payload.severity).toBe('WARNING');
    expect(payload.message).toBe('gate.blocked');
    expect(payload.component).toBe('gate');
    expect(payload.gate_layer).toBe('layer4');
    expect(payload.gate_classification).toBe('in-secure');
    expect(payload.gate_channel).toBe('slack');
    expect(payload.gate_user_id).toBe('slack:U123');
  });

  it('allowed outcome → severity INFO + message gate.allowed', () => {
    const payload = buildGateAuditPayload(
      makeEvent({ outcome: 'allowed', classification: 'biblio-other', reason: 'ok' }),
    );
    expect(payload.severity).toBe('INFO');
    expect(payload.message).toBe('gate.allowed');
    expect(payload.gate_classification).toBe('biblio-other');
  });

  it('utterance が 200 文字超なら truncate + ... suffix', () => {
    const long = 'x'.repeat(250);
    const payload = buildGateAuditPayload(makeEvent({ utterance: long }));
    const digest = payload.gate_utterance_digest as string;
    expect(digest.length).toBe(200 + 3); // 200 chars + '...'
    expect(digest.endsWith('...')).toBe(true);
  });

  it('I5: error outcome → severity ERROR + message gate.error + layer/classification=null', () => {
    const payload = buildGateAuditPayload({
      outcome: 'error',
      reason: 'gate infra failure',
      utterance: 'anything',
      channel: 'slack',
      channelType: 'slack',
      userId: 'slack:U123',
    });
    expect(payload.severity).toBe('ERROR');
    expect(payload.message).toBe('gate.error');
    expect(payload.gate_layer).toBeNull();
    expect(payload.gate_classification).toBeNull();
    expect(payload.gate_reason).toBe('gate infra failure');
  });

  it('I6: blocked/allowed outcome + degraded=true → payload に gate_degraded=true 反映', () => {
    const payload = buildGateAuditPayload(
      makeEvent({ outcome: 'allowed', classification: 'biblio-other', degraded: true }),
    );
    expect(payload.gate_degraded).toBe(true);
  });

  it('I6: blocked/allowed outcome + degraded=undefined → payload に gate_degraded 不在', () => {
    const payload = buildGateAuditPayload(makeEvent()); // degraded 未指定
    expect(payload.gate_degraded).toBeUndefined();
  });

  it('I11: channel="other" も受理 (routeInbound を通る将来 channel の防御的 fallback)', () => {
    const payload = buildGateAuditPayload(makeEvent({ channel: 'other', channelType: 'discord' }));
    expect(payload.gate_channel).toBe('other');
    expect(payload.gate_channel_type).toBe('discord');
  });

  it('utterance が 200 文字以下ならそのまま (truncate なし)', () => {
    const short = 'hello';
    const payload = buildGateAuditPayload(makeEvent({ utterance: short }));
    expect(payload.gate_utterance_digest).toBe('hello');
  });

  it('userId=null / undefined 経路も payload に null で残る', () => {
    const payload = buildGateAuditPayload(makeEvent({ userId: null }));
    expect(payload.gate_user_id).toBeNull();
    const payload2 = buildGateAuditPayload(makeEvent({ userId: undefined }));
    expect(payload2.gate_user_id).toBeNull();
  });
});

describe('appendGateAuditLog - Cloud Logging 経路', () => {
  it('blocked → log.warn 1 回発火', () => {
    appendGateAuditLog(makeEvent());
    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.info)).not.toHaveBeenCalled();
  });

  it('allowed → log.info 1 回発火', () => {
    appendGateAuditLog(makeEvent({ outcome: 'allowed' }));
    expect(vi.mocked(log.info)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  it('I5: error outcome → log.error 1 回発火 (ERROR severity)', () => {
    appendGateAuditLog({
      outcome: 'error',
      reason: 'gate infra fail',
      utterance: 'x',
      channel: 'slack',
      channelType: 'slack',
      userId: null,
    });
    expect(vi.mocked(log.error)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
    expect(vi.mocked(log.info)).not.toHaveBeenCalled();
  });
});

describe('appendGateAuditLog - `.jsonl` local fallback', () => {
  it('初回書き込みで mode 0600 のファイルが作成される', () => {
    appendGateAuditLog(makeEvent());
    expect(fs.existsSync(auditPath)).toBe(true);
    const stat = fs.statSync(auditPath);
    // mode の下位 9 bit で権限 permission (umask 影響で 0o600 完全一致は保証しないが、
    // group/others read/write は落ちる = 少なくとも `& 0o077` は 0 のはず)
    // 環境によっては umask で 0o600 が完全一致になるがベースの assert は「others に読める」ではないこと
    expect(stat.mode & 0o077).toBe(0);
    const content = fs.readFileSync(auditPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.message).toBe('gate.blocked');
    expect(parsed.gate_classification).toBe('in-secure');
  });

  it('2 件 append で 2 行に増える', () => {
    appendGateAuditLog(makeEvent());
    appendGateAuditLog(makeEvent({ outcome: 'allowed', classification: 'biblio-other' }));
    const content = fs.readFileSync(auditPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).message).toBe('gate.blocked');
    expect(JSON.parse(lines[1]!).message).toBe('gate.allowed');
  });

  it('GATE_AUDIT_LOG_DISABLE=1 の場合 `.jsonl` は書かれない', () => {
    process.env.GATE_AUDIT_LOG_DISABLE = '1';
    appendGateAuditLog(makeEvent());
    expect(fs.existsSync(auditPath)).toBe(false);
    // Cloud Logging 経路 (log.warn) は継続発火する
    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(1);
  });

  it('mkdir/write fail 時 log.error 発火 + throw しない (呼出元契約)', () => {
    // write 不能な path (存在しないルート親) を指定
    process.env.GATE_AUDIT_LOG_PATH = '/nonexistent-root/audit.jsonl';
    // node は `/nonexistent-root` を mkdirSync {recursive} で /nonexistent-root の作成を試みるが、
    // /nonexistent-root 直下は既存の / の permission でも大抵 EACCES で失敗する。
    // 万一環境依存で PASS になる場合は path を長くしても良いが、まず失敗経路として現実的。
    expect(() => appendGateAuditLog(makeEvent())).not.toThrow();
    // log.error が発火した (write_failed event 名で)
    // 環境によっては fs 経路が拒否されない場合があるので lenient assert:
    if (!fs.existsSync('/nonexistent-root/audit.jsonl')) {
      expect(vi.mocked(log.error)).toHaveBeenCalledWith(
        expect.stringContaining('gate audit log write failed'),
        expect.objectContaining({ event: 'gate.audit.write_failed' }),
      );
    }
  });

  it('I12: 連続 write fail は 1 件目 + 100 件ごとの milestone でのみ log.error (rate limit)', () => {
    process.env.GATE_AUDIT_LOG_PATH = '/nonexistent-root/audit.jsonl';
    if (fs.existsSync('/nonexistent-root/audit.jsonl')) {
      // 環境依存でこの pattern が拒否されないケースはスキップ
      return;
    }
    // 5 連続失敗 → log.error は 1 回だけ (1 件目)
    for (let i = 0; i < 5; i++) {
      appendGateAuditLog(makeEvent());
    }
    expect(vi.mocked(log.error)).toHaveBeenCalledTimes(1);
    const errCall = vi.mocked(log.error).mock.calls[0]![1] as Record<string, unknown>;
    expect(errCall.total_failures).toBe(1);
  });
});
