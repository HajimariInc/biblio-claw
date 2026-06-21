/**
 * shokyaku_biblio delivery handler + shokyaku_confirm approval handler のユニットテスト。
 *
 * enkin-action.test.ts と同形 (= mock 構造を完全に共有)。差分は action key + 「焼却」テキスト +
 * shokyaku() を mock する点のみ。
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

const shokyakuMock = vi.fn();
vi.mock('./shokyaku.js', () => ({
  shokyaku: (...args: unknown[]) => shokyakuMock(...args),
}));

import './shokyaku-action.js';

const handler = registeredDelivery.get('shokyaku_biblio');
if (!handler) throw new Error('shokyaku_biblio handler not registered');
const approvalHandler = registeredApprovals.get('shokyaku_confirm');
if (!approvalHandler) throw new Error('shokyaku_confirm approval handler not registered');

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
  shokyakuMock.mockReset();
  requestApprovalMock.mockReset();
  requestApprovalMock.mockResolvedValue(undefined);
});

describe('shokyaku_biblio handler — 入口 validate', () => {
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

  it('category 不正値 → invalid_category', async () => {
    await handler({ name: 'owner--repo', category: 'biblio-zzz' }, dummySession, dummyDb);
    expect(requestApprovalMock).not.toHaveBeenCalled();
    expect(getWrittenText()).toContain('invalid_category');
  });
});

describe('shokyaku_biblio handler — HITL 経路', () => {
  it('validate を通ると requestApproval が action=shokyaku_confirm + payload で呼ばれる', async () => {
    await handler({ name: 'owner--repo', category: 'biblio-ai' }, dummySession, dummyDb);
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
    const opts = requestApprovalMock.mock.calls[0][0] as RequestApprovalOptions;
    expect(opts.action).toBe('shokyaku_confirm');
    expect(opts.payload).toEqual({ biblioName: 'owner--repo', category: 'biblio-ai' });
    expect(opts.title).toBe('焼却の承認');
    expect(getWrittenText()).toContain('焼却承認を申請しました');
  });
});

describe('shokyaku_confirm approval handler — 承認後の実処理', () => {
  it('shokyaku() ok=true → notify に PR URL + 「再装備不可」', async () => {
    shokyakuMock.mockResolvedValue({
      ok: true,
      biblioName: 'owner--repo',
      category: 'biblio-ai',
      prUrl: 'https://github.com/HajimariInc/biblio-shelf/pull/88',
      prNumber: 88,
      branchName: 'shokyaku/biblio-ai--owner--repo-2026-06-21T20-00-00',
    });
    const notifyMock = vi.fn();
    await approvalHandler({
      session: { id: 'sess-x' } as never,
      payload: { biblioName: 'owner--repo', category: 'biblio-ai' },
      userId: 'slack:U-DEN',
      notify: notifyMock,
    });
    expect(shokyakuMock).toHaveBeenCalledWith({ biblioName: 'owner--repo', category: 'biblio-ai' });
    const notifiedText = notifyMock.mock.calls[0][0] as string;
    expect(notifiedText).toContain('焼却完了');
    expect(notifiedText).toContain('https://github.com/HajimariInc/biblio-shelf/pull/88');
    expect(notifiedText).toContain('再装備不可');
  });

  it('shokyaku() ok=false → notify に reason + detail', async () => {
    shokyakuMock.mockResolvedValue({
      ok: false,
      biblioName: 'owner--repo',
      reason: 'github_api_error',
      detail: 'step=POST git/blobs, status=403',
    });
    const notifyMock = vi.fn();
    await approvalHandler({
      session: { id: 'sess-x' } as never,
      payload: { biblioName: 'owner--repo', category: 'biblio-ai' },
      userId: 'slack:U-DEN',
      notify: notifyMock,
    });
    const notifiedText = notifyMock.mock.calls[0][0] as string;
    expect(notifiedText).toContain('焼却失敗 (github_api_error)');
    expect(notifiedText).toContain('step=POST git/blobs');
  });

  it('shokyaku() throw を握って notify (internal)', async () => {
    shokyakuMock.mockRejectedValue(new Error('unexpected'));
    const notifyMock = vi.fn();
    await approvalHandler({
      session: { id: 'sess-x' } as never,
      payload: { biblioName: 'owner--repo', category: 'biblio-ai' },
      userId: 'slack:U-DEN',
      notify: notifyMock,
    });
    const notifiedText = notifyMock.mock.calls[0][0] as string;
    expect(notifiedText).toContain('焼却エラー (internal)');
    expect(notifiedText).toContain('unexpected');
  });
});
