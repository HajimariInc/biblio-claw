/**
 * shelve_biblio delivery handler のユニットテスト。
 *
 * categorize-action.test.ts と同形 — registerDeliveryAction の handler を抜いて直呼びする。
 *
 * カバレッジ:
 *  - 入口 validate (name 欠落 / 形式違反 / category 欠落 / category 不正)
 *  - happy path (shelve 成功 → PR URL + 「手動 merge」)
 *  - already_shelved (専用テキスト)
 *  - github_api_error (失敗テキスト)
 *  - shelve 自体の throw を握って writeBack (host を巻き込まない)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// `vi.mock` は import 前に hoist されるため、receiver は `vi.hoisted` 内で初期化する
// (categorize-action.test.ts と同形)。
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

const shelveMock = vi.fn();
vi.mock('./shelve.js', () => ({
  shelve: (...args: unknown[]) => shelveMock(...args),
}));

import './shelve-action.js';

const handler = registered.get('shelve_biblio');
if (!handler) throw new Error('shelve_biblio handler not registered');

// Database / Session の具体型は session-db.js / session-manager.js 内で private に閉じている。
// handler 入口は型を見ない (= dummy object で通る) ため unknown で渡す。
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
  shelveMock.mockReset();
});

describe('shelve_biblio handler — 入口 validate', () => {
  it('name 欠落 → 「name が指定されていません」', async () => {
    await handler({ category: 'biblio-dev' }, dummySession, dummyDb);
    expect(shelveMock).not.toHaveBeenCalled();
    expect(getWrittenText()).toContain('name が指定されていません');
  });

  it('owner--name 形式違反 → 形式エラー', async () => {
    await handler({ name: 'short-name', category: 'biblio-dev' }, dummySession, dummyDb);
    expect(shelveMock).not.toHaveBeenCalled();
    expect(getWrittenText()).toContain('`owner--name` 形式ではありません');
  });

  it('category 欠落 → 「category が指定されていません」', async () => {
    await handler({ name: 'owner--repo' }, dummySession, dummyDb);
    expect(shelveMock).not.toHaveBeenCalled();
    expect(getWrittenText()).toContain('category が指定されていません');
  });

  it('category 不正値 → invalid_category', async () => {
    await handler({ name: 'owner--repo', category: 'biblio-zzz' }, dummySession, dummyDb);
    expect(shelveMock).not.toHaveBeenCalled();
    expect(getWrittenText()).toContain('invalid_category');
  });
});

describe('shelve_biblio handler — 成功/失敗パス', () => {
  it('shelve 成功で PR URL + 手動 merge メッセージを返す', async () => {
    shelveMock.mockResolvedValue({
      ok: true,
      biblioName: 'owner--repo',
      category: 'biblio-dev',
      prUrl: 'https://github.com/HajimariInc/biblio-shelf/pull/42',
      prNumber: 42,
      branchName: 'shelve/biblio-dev--owner--repo',
    });
    await handler({ name: 'owner--repo', category: 'biblio-dev', reason: 'TS refactor 補助' }, dummySession, dummyDb);
    const text = getWrittenText() ?? '';
    expect(text).toContain('PR URL = https://github.com/HajimariInc/biblio-shelf/pull/42');
    expect(text).toContain('手動 merge をお願いします');
  });

  it('already_shelved 専用テキストを返す', async () => {
    shelveMock.mockResolvedValue({
      ok: false,
      biblioName: 'owner--repo',
      reason: 'already_shelved',
      detail: '既存 entry',
    });
    await handler({ name: 'owner--repo', category: 'biblio-dev' }, dummySession, dummyDb);
    const text = getWrittenText() ?? '';
    expect(text).toContain('already shelved (key=owner--repo)');
  });

  it('github_api_error 失敗テキストを返す', async () => {
    shelveMock.mockResolvedValue({
      ok: false,
      biblioName: 'owner--repo',
      reason: 'github_api_error',
      detail: 'step=POST git/blobs, status=403',
    });
    await handler({ name: 'owner--repo', category: 'biblio-dev' }, dummySession, dummyDb);
    const text = getWrittenText() ?? '';
    expect(text).toContain('陳列失敗 (github_api_error)');
    expect(text).toContain('step=POST git/blobs');
  });

  it('shelve 自体が throw しても writeBack に倒す (host を巻き込まない)', async () => {
    shelveMock.mockRejectedValue(new Error('unexpected'));
    await expect(
      handler({ name: 'owner--repo', category: 'biblio-dev' }, dummySession, dummyDb),
    ).resolves.toBeUndefined();
    const text = getWrittenText() ?? '';
    expect(text).toContain('陳列エラー (internal)');
    expect(text).toContain('unexpected');
  });
});
