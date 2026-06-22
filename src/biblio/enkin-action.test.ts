/**
 * enkin_biblio delivery handler + enkin_confirm approval handler のユニットテスト。
 *
 * shelve-action.test.ts と同形で registerDeliveryAction / registerApprovalHandler / requestApproval
 * を全て vi.mock 経由で捕捉、enkin() も mock して callback の呼び出し順 + payload を assert する。
 *
 * カバレッジ:
 *  - 入口 validate (name 欠落 / 形式違反 / category 欠落 / category 不正)
 *  - requestApproval 呼び出し (action='enkin_confirm' + payload + title)
 *  - approval handler が enkin() を呼び notify(PR URL) で patron に応答
 *  - enkin() throw を握って notify('internal') (host を巻き込まない)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { ApprovalHandler, RequestApprovalOptions } from '../modules/approvals/primitive.js';

const { registeredDelivery, registeredApprovals, requestApprovalMock } = vi.hoisted(() => ({
  registeredDelivery: new Map<
    string,
    (content: Record<string, unknown>, session: unknown, inDb: unknown) => Promise<void>
  >(),
  registeredApprovals: new Map<string, ApprovalHandler>(),
  requestApprovalMock: vi.fn(),
}));

vi.mock('../delivery.js', () => ({
  registerDeliveryAction: (action: string, handler: (...args: unknown[]) => Promise<void>) => {
    registeredDelivery.set(action, handler as never);
  },
}));

vi.mock('../modules/approvals/index.js', () => ({
  registerApprovalHandler: (action: string, handler: ApprovalHandler) => {
    registeredApprovals.set(action, handler);
  },
  requestApproval: (opts: RequestApprovalOptions) => requestApprovalMock(opts),
}));

const insertMessageMock = vi.fn();
vi.mock('../db/session-db.js', () => ({
  insertMessage: (db: unknown, msg: unknown) => insertMessageMock(db, msg),
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const enkinMock = vi.fn();
vi.mock('./enkin.js', () => ({
  enkin: (...args: unknown[]) => enkinMock(...args),
}));

import './enkin-action.js';

const handler = registeredDelivery.get('enkin_biblio');
if (!handler) throw new Error('enkin_biblio handler not registered');
const approvalHandler = registeredApprovals.get('enkin_confirm');
if (!approvalHandler) throw new Error('enkin_confirm approval handler not registered');

const dummyDb: unknown = {};
const dummySession: unknown = { id: 'sess-x' };

function getWrittenText(): string | undefined {
  const lastCall = insertMessageMock.mock.calls.at(-1);
  if (!lastCall) return undefined;
  const msg = lastCall[1] as { content: string };
  return (JSON.parse(msg.content) as { text: string }).text;
}

beforeEach(() => {
  insertMessageMock.mockReset();
  enkinMock.mockReset();
  requestApprovalMock.mockReset();
  requestApprovalMock.mockResolvedValue(undefined);
});

describe('enkin_biblio handler — 入口 validate', () => {
  it('name 欠落 → 「name が指定されていません」 + requestApproval 未呼び', async () => {
    await handler({ category: 'biblio-dev' }, dummySession, dummyDb);
    expect(requestApprovalMock).not.toHaveBeenCalled();
    expect(getWrittenText()).toContain('name が指定されていません');
  });

  it('owner--name 形式違反 → 形式エラー', async () => {
    await handler({ name: 'short-name', category: 'biblio-dev' }, dummySession, dummyDb);
    expect(requestApprovalMock).not.toHaveBeenCalled();
    expect(getWrittenText()).toContain('`owner--name` 形式ではありません');
  });

  it('category 欠落 → 「category が指定されていません」', async () => {
    await handler({ name: 'owner--repo' }, dummySession, dummyDb);
    expect(requestApprovalMock).not.toHaveBeenCalled();
    expect(getWrittenText()).toContain('category が指定されていません');
  });

  it('category 不正値 → invalid_category', async () => {
    await handler({ name: 'owner--repo', category: 'biblio-zzz' }, dummySession, dummyDb);
    expect(requestApprovalMock).not.toHaveBeenCalled();
    expect(getWrittenText()).toContain('invalid_category');
  });
});

describe('enkin_biblio handler — HITL 経路', () => {
  it('validate を通ると requestApproval が action=enkin_confirm + payload で呼ばれる', async () => {
    await handler({ name: 'owner--repo', category: 'biblio-dev' }, dummySession, dummyDb);
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
    const opts = requestApprovalMock.mock.calls[0][0] as RequestApprovalOptions;
    expect(opts.action).toBe('enkin_confirm');
    expect(opts.payload).toEqual({ biblioName: 'owner--repo', category: 'biblio-dev' });
    expect(opts.title).toBe('禁書の承認');
    expect(getWrittenText()).toContain('禁書承認を申請しました');
  });

  it('requestApproval が throw すると writeBack で internal 失敗を通知', async () => {
    requestApprovalMock.mockRejectedValueOnce(new Error('delivery down'));
    await handler({ name: 'owner--repo', category: 'biblio-dev' }, dummySession, dummyDb);
    expect(getWrittenText()).toContain('禁書エラー (internal)');
    expect(getWrittenText()).toContain('delivery down');
  });
});

describe('enkin_confirm approval handler — 承認後の実処理', () => {
  it('enkin() ok=true → notify に PR URL + 「手動 merge」', async () => {
    enkinMock.mockResolvedValue({
      ok: true,
      biblioName: 'owner--repo',
      category: 'biblio-dev',
      prUrl: 'https://github.com/HajimariInc/biblio-shelf/pull/77',
      prNumber: 77,
      branchName: 'enkin/biblio-dev--owner--repo-2026-06-21T20-00-00',
    });
    const notifyMock = vi.fn();
    await approvalHandler({
      session: { id: 'sess-x' } as never,
      payload: { biblioName: 'owner--repo', category: 'biblio-dev' },
      userId: 'slack:U-DEN',
      notify: notifyMock,
    });
    expect(enkinMock).toHaveBeenCalledWith({ biblioName: 'owner--repo', category: 'biblio-dev' });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const notifiedText = notifyMock.mock.calls[0][0] as string;
    expect(notifiedText).toContain('禁書完了');
    expect(notifiedText).toContain('https://github.com/HajimariInc/biblio-shelf/pull/77');
    expect(notifiedText).toContain('手動 merge');
  });

  it('enkin() ok=false → notify に reason + detail', async () => {
    enkinMock.mockResolvedValue({
      ok: false,
      biblioName: 'owner--repo',
      reason: 'not_shelved',
      detail: '既に解除済',
    });
    const notifyMock = vi.fn();
    await approvalHandler({
      session: { id: 'sess-x' } as never,
      payload: { biblioName: 'owner--repo', category: 'biblio-dev' },
      userId: 'slack:U-DEN',
      notify: notifyMock,
    });
    const notifiedText = notifyMock.mock.calls[0][0] as string;
    expect(notifiedText).toContain('禁書失敗 (not_shelved)');
    expect(notifiedText).toContain('既に解除済');
  });

  it('enkin() throw を握って notify (internal) — host を巻き込まない', async () => {
    enkinMock.mockRejectedValue(new Error('unexpected'));
    const notifyMock = vi.fn();
    await approvalHandler({
      session: { id: 'sess-x' } as never,
      payload: { biblioName: 'owner--repo', category: 'biblio-dev' },
      userId: 'slack:U-DEN',
      notify: notifyMock,
    });
    const notifiedText = notifyMock.mock.calls[0][0] as string;
    expect(notifiedText).toContain('禁書エラー (internal)');
    expect(notifiedText).toContain('unexpected');
  });

  it('payload 不正 (biblioName 空) → notify で payload 破損を通知 (enkin 未呼び)', async () => {
    const notifyMock = vi.fn();
    await approvalHandler({
      session: { id: 'sess-x' } as never,
      payload: { biblioName: '', category: 'biblio-dev' },
      userId: 'slack:U-DEN',
      notify: notifyMock,
    });
    expect(enkinMock).not.toHaveBeenCalled();
    const notifiedText = notifyMock.mock.calls[0][0] as string;
    expect(notifiedText).toContain('禁書エラー');
    expect(notifiedText).toContain('payload が壊れています');
  });
});
