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

describe('shokyaku_biblio handler — HITL 経路', () => {
  it('validate を通ると requestApproval が action=shokyaku_confirm + payload で呼ばれる', async () => {
    await handler({ name: 'owner--repo', category: 'biblio-ai' }, dummySession, dummyDb);
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
    const opts = requestApprovalMock.mock.calls[0][0] as RequestApprovalOptions;
    expect(opts.action).toBe('shokyaku_confirm');
    expect(opts.payload).toMatchObject({ biblioName: 'owner--repo', category: 'biblio-ai' });
    expect((opts.payload as Record<string, unknown>).originating_request_id).toEqual(expect.any(String));
    expect(opts.title).toBe('焼却の承認');
    expect(getWrittenText()).toContain('焼却承認を申請しました');
  });

  it('requestApproval が throw すると writeBack で internal 失敗を通知', async () => {
    requestApprovalMock.mockRejectedValueOnce(new Error('delivery down'));
    await handler({ name: 'owner--repo', category: 'biblio-dev' }, dummySession, dummyDb);
    expect(getWrittenText()).toContain('焼却エラー (internal)');
    expect(getWrittenText()).toContain('delivery down');
  });
});

describe('shokyaku_confirm approval handler — 承認後の実処理', () => {
  it('shokyaku() ok=true (cleanup 成功) → notify に PR URL + 「再装備不可」', async () => {
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
    expect(shokyakuMock).toHaveBeenCalledWith({ biblioName: 'owner--repo', category: 'biblio-ai' }, expect.anything());
    const notifiedText = notifyMock.mock.calls[0][0] as string;
    expect(notifiedText).toContain('焼却完了');
    expect(notifiedText).toContain('https://github.com/HajimariInc/biblio-shelf/pull/88');
    expect(notifiedText).toContain('再装備不可');
    expect(notifiedText).not.toContain('装備源の物理削除に失敗');
  });

  it('shokyaku() ok=true (cleanupWarning あり) → notify に 「装備源の物理削除に失敗」 が含まれる (silent failure 防止)', async () => {
    shokyakuMock.mockResolvedValue({
      ok: true,
      biblioName: 'owner--repo',
      category: 'biblio-ai',
      prUrl: 'https://github.com/HajimariInc/biblio-shelf/pull/88',
      prNumber: 88,
      branchName: 'shokyaku/biblio-ai--owner--repo-2026-06-21T20-00-00',
      cleanupWarning: '装備源 dir の物理削除に失敗 (/data/biblio-equipped/owner--repo): EACCES',
    });
    const notifyMock = vi.fn();
    await approvalHandler({
      session: { id: 'sess-x' } as never,
      payload: { biblioName: 'owner--repo', category: 'biblio-ai' },
      userId: 'slack:U-DEN',
      notify: notifyMock,
    });
    const notifiedText = notifyMock.mock.calls[0][0] as string;
    expect(notifiedText).toContain('焼却完了');
    expect(notifiedText).toContain('https://github.com/HajimariInc/biblio-shelf/pull/88');
    // cleanup 失敗を patron に明示 (= 「物理削除しました」と無条件通知しない)。
    // PR #117 review (silent-failure-hunter HIGH) 対応でヘッドラインを理由非依存に一般化:
    // 「装備源の物理削除に失敗」→「装備状態のクリーンアップに一部失敗しました」に変更。
    // 個別の失敗詳細は cleanupWarning 経由でメッセージ末尾に残る (EACCES 等)。
    expect(notifiedText).toContain('装備状態のクリーンアップに一部失敗しました');
    expect(notifiedText).toContain('EACCES');
    // 是正指示も理由非依存に (装備源 dir / 装備リスト DB / Fugue 装備状態 DB のどれが
    // 失敗したか cleanupWarning 詳細で確認して個別対処してもらう形)
    expect(notifiedText).toContain('個別に対処');
    // 「再装備不可」は false の状態なので含まれない
    expect(notifiedText).not.toContain('= 再装備不可)');
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

  it('shokyaku() ok=false (config_error) → notify に「焼却失敗 (config_error)」 + detail (env 欠落時)', async () => {
    shokyakuMock.mockResolvedValue({
      ok: false,
      biblioName: 'owner--repo',
      reason: 'config_error',
      detail: 'shelve: required env missing: SHELF_REPO_OWNER',
    });
    const notifyMock = vi.fn();
    await approvalHandler({
      session: { id: 'sess-x' } as never,
      payload: { biblioName: 'owner--repo', category: 'biblio-ai' },
      userId: 'slack:U-DEN',
      notify: notifyMock,
    });
    const notifiedText = notifyMock.mock.calls[0][0] as string;
    expect(notifiedText).toContain('焼却失敗 (config_error)');
    expect(notifiedText).toContain('owner--repo');
    expect(notifiedText).toContain('required env missing: SHELF_REPO_OWNER');
  });

  it('payload 不正 (biblioName 空) → notify で payload 破損を通知 (shokyaku 未呼び)', async () => {
    const notifyMock = vi.fn();
    await approvalHandler({
      session: { id: 'sess-x' } as never,
      payload: { biblioName: '', category: 'biblio-ai' },
      userId: 'slack:U-DEN',
      notify: notifyMock,
    });
    expect(shokyakuMock).not.toHaveBeenCalled();
    const notifiedText = notifyMock.mock.calls[0][0] as string;
    expect(notifiedText).toContain('焼却エラー');
    expect(notifiedText).toContain('payload が壊れています');
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

/**
 * HITL 2 span 連結検証 (= Phase 2 review B1)。enkin-action.test.ts と同流儀。
 */
describe('shokyaku approval handler — HITL 2 span 連結 (originating_request_id)', () => {
  it('payload.originating_request_id を span 属性 biblio.originating_request_id に設定する', async () => {
    const otelApi = await import('@opentelemetry/api');
    const sdk = await import('@opentelemetry/sdk-trace-base');
    const alsHooks = await import('@opentelemetry/context-async-hooks');
    const memoryExporter = new sdk.InMemorySpanExporter();
    otelApi.context.setGlobalContextManager(new alsHooks.AsyncLocalStorageContextManager().enable());
    const provider = new sdk.BasicTracerProvider({
      sampler: new sdk.ParentBasedSampler({ root: new sdk.AlwaysOnSampler() }),
      spanProcessors: [new sdk.SimpleSpanProcessor(memoryExporter)],
    });
    otelApi.trace.setGlobalTracerProvider(provider);

    shokyakuMock.mockResolvedValueOnce({
      ok: true,
      biblioName: 'owner--repo',
      category: 'biblio-ai',
      prUrl: 'https://github.com/owner/biblio-shelf/pull/10',
      prNumber: 10,
      branchName: 'shokyaku/owner--repo',
      cleanupWarning: null,
    });

    const notifyMock = vi.fn();
    await approvalHandler({
      session: { id: 'sess-x' } as never,
      payload: {
        biblioName: 'owner--repo',
        category: 'biblio-ai',
        originating_request_id: 'req-shokyaku-original-uuid',
      },
      userId: 'slack:U-DEN',
      notify: notifyMock,
    });

    const spans = memoryExporter.getFinishedSpans();
    const approvalSpan = spans.find((s) => s.name === 'biblio.shokyaku');
    expect(approvalSpan).toBeDefined();
    expect(approvalSpan?.attributes['biblio.originating_request_id']).toBe('req-shokyaku-original-uuid');

    memoryExporter.reset();
    await provider.shutdown().catch(() => undefined);
    otelApi.trace.disable();
    otelApi.context.disable();
  });
});
