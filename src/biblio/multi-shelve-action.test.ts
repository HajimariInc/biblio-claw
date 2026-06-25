/**
 * shelve_biblio_multi delivery handler のユニットテスト (Phase 4 multi-category-shelve)。
 *
 * shelve-action.test.ts と同形 — registerDeliveryAction の handler を抜いて直呼びする。
 *
 * カバレッジ:
 *  - 入口 validate: items 不在/空、item shape (非 object)、name 欠落/形式違反、category 欠落/不正
 *  - happy path (shelveMulti 成功 → PR URL + 件数 + 内訳 + 手動 merge)
 *  - 失敗 (already_shelved / duplicate_biblio_name 等の reason テキスト)
 *  - shelveMulti 自体の throw を握って writeBack (host を巻き込まない)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// `vi.mock` は import 前に hoist されるため、receiver は `vi.hoisted` 内で初期化する
// (shelve-action.test.ts と同形)。
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

const shelveMultiMock = vi.fn();
vi.mock('./shelve.js', () => ({
  shelveMulti: (...args: unknown[]) => shelveMultiMock(...args),
}));

import './multi-shelve-action.js';

const handler = registered.get('shelve_biblio_multi');
if (!handler) throw new Error('shelve_biblio_multi handler not registered');

const dummyDb: unknown = {};
const dummySession: unknown = { id: 'sess-multi' };

function getWrittenText(): string | undefined {
  const lastCall = insertMessageMock.mock.calls.at(-1);
  if (!lastCall) return undefined;
  const msg = lastCall[1] as { content: string };
  return (JSON.parse(msg.content) as { text: string }).text;
}

beforeEach(() => {
  insertMessageMock.mockReset();
  shelveMultiMock.mockReset();
});

describe('shelve_biblio_multi handler — 入口 validate', () => {
  it('items 未指定 → 「items 配列が空 or 未指定」', async () => {
    await handler({}, dummySession, dummyDb);
    expect(shelveMultiMock).not.toHaveBeenCalled();
    expect(getWrittenText()).toContain('items 配列が空 or 未指定');
  });

  it('items 空配列 → 「items 配列が空 or 未指定」', async () => {
    await handler({ items: [] }, dummySession, dummyDb);
    expect(shelveMultiMock).not.toHaveBeenCalled();
    expect(getWrittenText()).toContain('items 配列が空 or 未指定');
  });

  it('items[0] が非 object → invalid_input + index', async () => {
    await handler({ items: ['not-an-object'] }, dummySession, dummyDb);
    expect(shelveMultiMock).not.toHaveBeenCalled();
    expect(getWrittenText()).toContain('items[0] が object ではありません');
  });

  it('items[0].name 欠落 → invalid_input + index', async () => {
    await handler({ items: [{ category: 'biblio-dev' }] }, dummySession, dummyDb);
    expect(shelveMultiMock).not.toHaveBeenCalled();
    expect(getWrittenText()).toContain('items[0].name が指定されていません');
  });

  it('items[0].name 形式違反 → invalid_input', async () => {
    await handler({ items: [{ name: 'short', category: 'biblio-dev' }] }, dummySession, dummyDb);
    expect(shelveMultiMock).not.toHaveBeenCalled();
    const text = getWrittenText() ?? '';
    expect(text).toContain('items[0].name');
    expect(text).toContain('形式ではありません');
  });

  it('items[1].category 欠落 → invalid_input + index=1', async () => {
    await handler(
      {
        items: [{ name: 'owner--repo--skill-a', category: 'biblio-dev' }, { name: 'owner--repo--skill-b' }],
      },
      dummySession,
      dummyDb,
    );
    expect(shelveMultiMock).not.toHaveBeenCalled();
    expect(getWrittenText()).toContain('items[1].category が指定されていません');
  });

  it('items[1].category 不正値 → invalid_category + index=1', async () => {
    await handler(
      {
        items: [
          { name: 'owner--repo--skill-a', category: 'biblio-dev' },
          { name: 'owner--repo--skill-b', category: 'biblio-zzz' },
        ],
      },
      dummySession,
      dummyDb,
    );
    expect(shelveMultiMock).not.toHaveBeenCalled();
    const text = getWrittenText() ?? '';
    expect(text).toContain('items[1].category');
    expect(text).toContain('invalid_category');
  });

  it('3 要素 biblioName (Phase 3 individual-acquire) を許容', async () => {
    shelveMultiMock.mockResolvedValue({
      ok: true,
      prUrl: 'https://github.com/HajimariInc/biblio-shelf/pull/99',
      prNumber: 99,
      branchName: 'shelve/multi-owner--repo-1700000000',
      items: [
        { biblioName: 'owner--repo--skill-a', category: 'biblio-dev' },
        { biblioName: 'owner--repo--skill-b', category: 'biblio-art' },
      ],
    });
    await handler(
      {
        items: [
          { name: 'owner--repo--skill-a', category: 'biblio-dev', reason: 'dev 寄り' },
          { name: 'owner--repo--skill-b', category: 'biblio-art', reason: 'art 寄り' },
        ],
      },
      dummySession,
      dummyDb,
    );
    expect(shelveMultiMock).toHaveBeenCalledTimes(1);
    const args = shelveMultiMock.mock.calls[0][0];
    expect(args).toEqual([
      { biblioName: 'owner--repo--skill-a', category: 'biblio-dev', reason: 'dev 寄り' },
      { biblioName: 'owner--repo--skill-b', category: 'biblio-art', reason: 'art 寄り' },
    ]);
  });
});

describe('shelve_biblio_multi handler — 成功/失敗パス', () => {
  it('shelveMulti 成功で PR URL + 件数 + 内訳 + 手動 merge メッセージを返す', async () => {
    shelveMultiMock.mockResolvedValue({
      ok: true,
      prUrl: 'https://github.com/HajimariInc/biblio-shelf/pull/55',
      prNumber: 55,
      branchName: 'shelve/multi-owner--repo-1700000000',
      items: [
        { biblioName: 'owner--repo--skill-a', category: 'biblio-dev' },
        { biblioName: 'owner--repo--skill-b', category: 'biblio-dev' },
        { biblioName: 'owner--repo--skill-c', category: 'biblio-art' },
      ],
    });
    await handler(
      {
        items: [
          { name: 'owner--repo--skill-a', category: 'biblio-dev', reason: 'r1' },
          { name: 'owner--repo--skill-b', category: 'biblio-dev', reason: 'r2' },
          { name: 'owner--repo--skill-c', category: 'biblio-art', reason: 'r3' },
        ],
      },
      dummySession,
      dummyDb,
    );
    const text = getWrittenText() ?? '';
    expect(text).toContain('陳列完了 (3 件 / 1 PR)');
    expect(text).toContain('https://github.com/HajimariInc/biblio-shelf/pull/55');
    expect(text).toContain('owner--repo--skill-a');
    expect(text).toContain('biblio-dev');
    expect(text).toContain('owner--repo--skill-c');
    expect(text).toContain('biblio-art');
    expect(text).toContain('手動 merge をお願いします');
  });

  it('shelveMulti 失敗 (already_shelved) で失敗テキスト + reason + detail を返す', async () => {
    shelveMultiMock.mockResolvedValue({
      ok: false,
      reason: 'already_shelved',
      detail: 'marketplace.json に既存 entry: owner--repo--skill-a (全体陳列を中止、部分成功なし)',
      items: [
        { biblioName: 'owner--repo--skill-a', category: 'biblio-dev' },
        { biblioName: 'owner--repo--skill-b', category: 'biblio-art' },
      ],
    });
    await handler(
      {
        items: [
          { name: 'owner--repo--skill-a', category: 'biblio-dev', reason: 'r1' },
          { name: 'owner--repo--skill-b', category: 'biblio-art', reason: 'r2' },
        ],
      },
      dummySession,
      dummyDb,
    );
    const text = getWrittenText() ?? '';
    expect(text).toContain('陳列失敗 (already_shelved)');
    expect(text).toContain('既存 entry');
  });

  it('shelveMulti 失敗 (duplicate_biblio_name) で失敗テキストを返す', async () => {
    shelveMultiMock.mockResolvedValue({
      ok: false,
      reason: 'duplicate_biblio_name',
      detail: '重複する biblioName: owner--repo--skill-a',
      items: [],
    });
    await handler(
      {
        items: [
          { name: 'owner--repo--skill-a', category: 'biblio-dev', reason: 'r1' },
          { name: 'owner--repo--skill-a', category: 'biblio-art', reason: 'r2' },
        ],
      },
      dummySession,
      dummyDb,
    );
    const text = getWrittenText() ?? '';
    expect(text).toContain('陳列失敗 (duplicate_biblio_name)');
  });

  it('shelveMulti 自体が throw しても writeBack に倒す (host を巻き込まない)', async () => {
    shelveMultiMock.mockRejectedValue(new Error('unexpected shelveMulti throw'));
    await expect(
      handler(
        {
          items: [{ name: 'owner--repo--skill-a', category: 'biblio-dev', reason: 'r' }],
        },
        dummySession,
        dummyDb,
      ),
    ).resolves.toBeUndefined();
    const text = getWrittenText() ?? '';
    expect(text).toContain('陳列エラー (internal)');
    expect(text).toContain('unexpected shelveMulti throw');
  });
});
