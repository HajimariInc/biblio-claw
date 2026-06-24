/**
 * `acquire_biblio` delivery handler のユニットテスト (PR #37 review-agents Important I5、9/10)。
 *
 * action handler は writeBack (= insertMessage) を 1 度叩いて patron に応答する形式。
 * `registerDeliveryAction` を mock して module load 時の handler を抜き、直接呼ぶ。
 *
 * カバレッジ (= 6 分岐):
 *   1. repo 欠落 → invalid_input writeBack (acquire は呼ばない)
 *   2. ok=true → 仕入れ完了 + quarantinePath writeBack
 *   3. ok=false reason=not_found → 仕入れエラー (not_found)
 *   4. ok=false reason=internal → システム構成エラー (= 専用文言)
 *   5. ok=false reason=clone_failed → 仕入れエラー (clone_failed)
 *   6. acquire throw → システム構成エラー: 予期しない失敗 (host を巻き込まない)
 *
 * 同時検証: acquire 呼出に ctx (= { requestId, sessionId }) が渡されていること
 * (= Phase 2 で確立した request_id propagation、I1 解消の回帰防止)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { registered } = vi.hoisted(() => ({
  registered: new Map<string, (content: Record<string, unknown>, session: unknown, inDb: unknown) => Promise<void>>(),
}));

vi.mock('../delivery.js', () => ({
  registerDeliveryAction: (action: string, handler: (...args: unknown[]) => Promise<void>) => {
    registered.set(action, handler as never);
  },
}));

const insertMessageMock = vi.fn();
vi.mock('../db/session-db.js', () => ({
  insertMessage: (db: unknown, msg: unknown) => insertMessageMock(db, msg),
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const acquireMock = vi.fn();
vi.mock('./acquire.js', () => ({
  acquire: (...args: unknown[]) => acquireMock(...args),
}));

// 副作用 import で `registerDeliveryAction('acquire_biblio', handler)` が走る
import './acquire-action.js';

const handler = registered.get('acquire_biblio');
if (!handler) throw new Error('acquire_biblio handler not registered');

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
  acquireMock.mockReset();
});

describe('acquire_biblio handler — 入口 validate', () => {
  it('repo 欠落で「repo が指定されていません」を返す (acquire は呼ばない)', async () => {
    await handler({}, dummySession, dummyDb);
    expect(acquireMock).not.toHaveBeenCalled();
    expect(getWrittenText()).toContain('invalid_input');
    expect(getWrittenText()).toContain('repo が指定されていません');
  });
});

describe('acquire_biblio handler — happy path', () => {
  it('acquire 成功で「仕入れ完了」+ quarantinePath を返す', async () => {
    acquireMock.mockResolvedValue({
      ok: true,
      biblioName: 'octocat--hello',
      quarantinePath: '/tmp/q/octocat--hello',
    });
    await handler({ repo: 'octocat/hello' }, dummySession, dummyDb);
    expect(acquireMock).toHaveBeenCalledWith(
      { repo: 'octocat/hello' },
      // I1 検証: ctx に requestId (UUID 形式) + sessionId が渡されている
      expect.objectContaining({
        ctx: expect.objectContaining({
          requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
          sessionId: 'sess-x',
        }),
      }),
    );
    const text = getWrittenText() ?? '';
    expect(text).toContain('仕入れ完了');
    expect(text).toContain('/tmp/q/octocat--hello');
    expect(text).toContain('inspect_biblio');
  });
});

describe('acquire_biblio handler — fail path', () => {
  it('reason=not_found で「仕入れエラー (not_found)」を返す', async () => {
    acquireMock.mockResolvedValue({
      ok: false,
      reason: 'not_found',
      detail: 'repo が見つかりません: foo/bar',
    });
    await handler({ repo: 'foo/bar' }, dummySession, dummyDb);
    const text = getWrittenText() ?? '';
    expect(text).toContain('仕入れエラー (not_found)');
    expect(text).toContain('repo が見つかりません');
  });

  it('reason=internal で「システム構成エラー」専用文言を返す (= 再試行を促さない)', async () => {
    acquireMock.mockResolvedValue({
      ok: false,
      reason: 'internal',
      detail: 'OneCLI proxy への接続に失敗',
    });
    await handler({ repo: 'foo/bar' }, dummySession, dummyDb);
    const text = getWrittenText() ?? '';
    expect(text).toContain('システム構成エラー');
    expect(text).toContain('OneCLI proxy への接続に失敗');
    // 再試行誘発の「仕入れエラー」文言ではないこと
    expect(text).not.toContain('仕入れエラー (internal)');
  });

  it('reason=clone_failed で「仕入れエラー (clone_failed)」を返す', async () => {
    acquireMock.mockResolvedValue({
      ok: false,
      reason: 'clone_failed',
      detail: 'git clone exit=128',
    });
    await handler({ repo: 'foo/bar' }, dummySession, dummyDb);
    const text = getWrittenText() ?? '';
    expect(text).toContain('仕入れエラー (clone_failed)');
    expect(text).toContain('exit=128');
  });

  it('acquire 自体が throw しても host を巻き込まず writeBack に倒す', async () => {
    acquireMock.mockRejectedValue(new Error('unexpected fatal'));
    await expect(handler({ repo: 'foo/bar' }, dummySession, dummyDb)).resolves.toBeUndefined();
    const text = getWrittenText() ?? '';
    expect(text).toContain('システム構成エラー');
    expect(text).toContain('予期しない失敗');
    expect(text).toContain('unexpected fatal');
  });
});
