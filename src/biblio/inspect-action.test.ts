/**
 * inspect_biblio delivery handler のユニットテスト (M4-C Phase 2 review R6 で新設)。
 *
 * `acquire-action.test.ts` の pattern を踏襲: `registerDeliveryAction` mock で handler を
 * capture、`log.info` mock で emit を確認、`inspect` mock で verdict/reason を制御。
 *
 * カバレッジ:
 *   - 入口 validate (name 不在 / BIBLIO_NAME_RE 不整合)
 *   - verdict × reason × dangerous の 5 分岐 emit (review R6 の I1/I3)
 *     - ACCEPT + reason=undefined → dangerous:false, reason:null
 *     - HOLD + reason=inspect_error → dangerous:false, reason:'inspect_error' (システム障害)
 *     - HOLD + reason=license_unknown → dangerous:false, reason:'license_unknown' (policy 保留)
 *     - REJECT + reason=schema_invalid → dangerous:false, reason:'schema_invalid'
 *     - REJECT + reason=dangerous_code → dangerous:true, reason:'dangerous_code' (唯一の危険判定)
 *   - inspect() 自体が throw → 例外握って patron 通知
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `registerDeliveryAction(action, handler)` の handler を抜き出すための receiver。
const { registered } = vi.hoisted(() => ({
  registered: new Map<string, (content: Record<string, unknown>, session: unknown, inDb: unknown) => Promise<void>>(),
}));

vi.mock('../delivery.js', () => ({
  registerDeliveryAction: (action: string, handler: (...args: unknown[]) => Promise<void>) => {
    registered.set(action, handler as never);
  },
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const inspectMock = vi.fn();
vi.mock('./inspect.js', () => ({
  inspect: (...args: unknown[]) => inspectMock(...args),
}));

// action-helpers は partial mock — writeBackMessage だけ差し替える。
// withBiblioActionSpan は実 pass-through (span 生成 = tracer noop で問題なし)。
const writeBackCalls: Array<{ text: string; idPrefix: string; actionName: string }> = [];
vi.mock('./action-helpers.js', async () => {
  const actual = await vi.importActual<typeof import('./action-helpers.js')>('./action-helpers.js');
  return {
    ...actual,
    writeBackMessage: async (_db: unknown, text: string, idPrefix: string, actionName: string) => {
      writeBackCalls.push({ text, idPrefix, actionName });
    },
  };
});

// 副作用 import で `registerDeliveryAction('inspect_biblio', handler)` が走る
import './inspect-action.js';
import { log } from '../log.js';

const handler = registered.get('inspect_biblio');
if (!handler) throw new Error('inspect_biblio handler not registered');

const dummyDb: unknown = {};
const dummySession: unknown = { id: 'sess-inspect' };

beforeEach(() => {
  inspectMock.mockReset();
  writeBackCalls.length = 0;
  vi.mocked(log.info).mockReset();
  vi.mocked(log.warn).mockReset();
  vi.mocked(log.error).mockReset();
});

describe('inspect_biblio handler — 入口 validate', () => {
  it('name 未指定 → invalid_input writeBack + inspect を呼ばない', async () => {
    await handler({}, dummySession, dummyDb);
    expect(inspectMock).not.toHaveBeenCalled();
    expect(writeBackCalls.at(-1)?.text).toContain('name が指定されていません');
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'inspect_biblio missing name',
      expect.objectContaining({ outcome: 'failure' }),
    );
  });

  it('BIBLIO_NAME_RE 不整合 (path traversal 系) → invalid_input writeBack', async () => {
    await handler({ name: '../evil' }, dummySession, dummyDb);
    expect(inspectMock).not.toHaveBeenCalled();
    expect(writeBackCalls.at(-1)?.text).toContain('owner--name');
  });
});

describe('inspect_biblio handler — verdict × reason × dangerous emit', () => {
  it('ACCEPT (reason 不在) → outcome:success, verdict:ACCEPT, reason:null, dangerous:false', async () => {
    inspectMock.mockResolvedValue({ verdict: 'ACCEPT', biblioName: 'owner--repo' });
    await handler({ name: 'owner--repo' }, dummySession, dummyDb);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      'inspect_biblio done',
      expect.objectContaining({
        event: 'biblio.inspect',
        outcome: 'success',
        verdict: 'ACCEPT',
        reason: null,
        dangerous: false,
      }),
    );
  });

  // review R6 (I1): HOLD + inspect_error = システム障害 (Vertex 呼出失敗、応答崩れ、quarantine 不可)。
  // policy 保留 (license_*) と同じ verdict/dangerous に潰されないように、reason field で区別。
  it('HOLD + reason=inspect_error → outcome:hold, verdict:HOLD, reason:inspect_error, dangerous:false', async () => {
    inspectMock.mockResolvedValue({
      verdict: 'HOLD',
      biblioName: 'owner--repo',
      reason: 'inspect_error',
      detail: 'Vertex 呼出失敗',
    });
    await handler({ name: 'owner--repo' }, dummySession, dummyDb);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      'inspect_biblio done',
      expect.objectContaining({
        outcome: 'hold',
        verdict: 'HOLD',
        reason: 'inspect_error',
        dangerous: false,
      }),
    );
  });

  it('HOLD + reason=license_unknown → outcome:hold, verdict:HOLD, reason:license_unknown, dangerous:false', async () => {
    inspectMock.mockResolvedValue({
      verdict: 'HOLD',
      biblioName: 'owner--repo',
      reason: 'license_unknown',
      detail: 'allow リスト外',
    });
    await handler({ name: 'owner--repo' }, dummySession, dummyDb);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      'inspect_biblio done',
      expect.objectContaining({
        outcome: 'hold',
        verdict: 'HOLD',
        reason: 'license_unknown',
        dangerous: false,
      }),
    );
  });

  it('REJECT + reason=schema_invalid → outcome:failure, verdict:REJECT, reason:schema_invalid, dangerous:false', async () => {
    inspectMock.mockResolvedValue({
      verdict: 'REJECT',
      biblioName: 'owner--repo',
      reason: 'schema_invalid',
      detail: 'plugin metadata に name field なし',
    });
    await handler({ name: 'owner--repo' }, dummySession, dummyDb);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      'inspect_biblio done',
      expect.objectContaining({
        outcome: 'failure',
        verdict: 'REJECT',
        reason: 'schema_invalid',
        dangerous: false,
      }),
    );
  });

  // review R6 (I1): dangerous_code は唯一 dangerous=true になる reason (安全と誤解しないよう pin)。
  it('REJECT + reason=dangerous_code → outcome:failure, verdict:REJECT, reason:dangerous_code, dangerous:true', async () => {
    inspectMock.mockResolvedValue({
      verdict: 'REJECT',
      biblioName: 'owner--repo',
      reason: 'dangerous_code',
      detail: 'LLM が DANGEROUS 判定',
    });
    await handler({ name: 'owner--repo' }, dummySession, dummyDb);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      'inspect_biblio done',
      expect.objectContaining({
        outcome: 'failure',
        verdict: 'REJECT',
        reason: 'dangerous_code',
        dangerous: true,
      }),
    );
  });
});

describe('inspect_biblio handler — 例外握り', () => {
  it('inspect() が throw → 例外握って patron 通知 + log.error', async () => {
    inspectMock.mockRejectedValue(new Error('unexpected boom'));
    await handler({ name: 'owner--repo' }, dummySession, dummyDb);
    expect(writeBackCalls.at(-1)?.text).toContain('検品エラー (internal)');
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      'inspect_biblio threw',
      expect.objectContaining({
        event: 'biblio.inspect',
        outcome: 'failure',
      }),
    );
  });
});
