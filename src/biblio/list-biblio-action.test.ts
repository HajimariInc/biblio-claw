/**
 * list_biblio delivery handler のユニットテスト。
 *
 * shelve-action.test.ts と同形 — registerDeliveryAction の handler を抜いて直呼びする。
 * `insertMessage` を mock して writeBackMessage の本物経路を維持しつつ、最終的に
 * inbound.db に書かれるはずだったメッセージの text を検証する (既存 biblio action test 流儀)。
 *
 * カバレッジ:
 *  - action="list_biblio" が registered.has で true (副作用 import で登録される)
 *  - category 未指定 → listBiblio({ category: undefined }) を呼ぶ + 件数 + カウント + 一覧
 *  - category 指定 → listBiblio に渡される + appliedFilter 注記
 *  - 不正 category は silent fallback で全件 + 注記 (= patron が略記しても落ちない)
 *  - listBiblio が throw しても writeBack に internal エラーを書く (host 巻き込まない)
 *  - total=0 のとき空棚メッセージ
 *  - unknown カテゴリ混在のとき formatResult が「source 解析不能、要確認」を含む
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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

const listBiblioMock = vi.fn();
vi.mock('./list-biblio.js', () => ({
  listBiblio: (...args: unknown[]) => listBiblioMock(...args),
}));

import './list-biblio-action.js';

const handler = registered.get('list_biblio');
if (!handler) throw new Error('list_biblio handler not registered');

const dummyDb: unknown = {};
const dummySession: unknown = { id: 'sess-x' };

function getWrittenText(): string | undefined {
  const lastCall = insertMessageMock.mock.calls.at(-1);
  if (!lastCall) return undefined;
  const msg = lastCall[1] as { content: string };
  return (JSON.parse(msg.content) as { text: string }).text;
}

/**
 * テスト用 counts helper — 5 keys を 0 で初期化、引数で上書きする。
 * `list-biblio.ts` の `emptyCounts()` と同形だが、本体は export しない方針のため
 * テストファイル内ローカルに置く (= カテゴリ追加時のメンテ負荷を集約)。
 */
function testCounts(
  overrides: Partial<Record<'biblio-dev' | 'biblio-art' | 'biblio-bf' | 'biblio-ai' | 'unknown', number>> = {},
): Record<'biblio-dev' | 'biblio-art' | 'biblio-bf' | 'biblio-ai' | 'unknown', number> {
  return { 'biblio-dev': 0, 'biblio-art': 0, 'biblio-bf': 0, 'biblio-ai': 0, unknown: 0, ...overrides };
}

beforeEach(() => {
  insertMessageMock.mockReset();
  listBiblioMock.mockReset();
});

describe('list_biblio handler', () => {
  it('副作用 import で list_biblio が登録される', () => {
    expect(registered.has('list_biblio')).toBe(true);
  });

  it('category 未指定 — listBiblio({ category: undefined }) + 件数 + カウント + 一覧', async () => {
    listBiblioMock.mockResolvedValue({
      ok: true,
      items: [
        { name: 'a--b', category: 'biblio-dev', description: '', version: '' },
        { name: 'c--d', category: 'biblio-art', description: '', version: '' },
      ],
      counts: testCounts({ 'biblio-dev': 1, 'biblio-art': 1 }),
      total: 2,
      appliedFilter: null,
    });
    await handler({ action: 'list_biblio', category: '' }, dummySession, dummyDb);
    expect(listBiblioMock).toHaveBeenCalledWith({ category: undefined }, expect.anything());
    const text = getWrittenText();
    expect(text).toContain('2 件');
    expect(text).toContain('biblio-dev (1)');
    expect(text).toContain('biblio-art (1)');
    expect(text).toContain('a--b');
    expect(text).toContain('c--d');
    // 全件表示のときは絞り込みヒントが付く。
    expect(text).toContain('カテゴリで絞るには');
  });

  it('category 指定 — listBiblio に渡される + appliedFilter 注記', async () => {
    listBiblioMock.mockResolvedValue({
      ok: true,
      items: [{ name: 'a--b', category: 'biblio-dev', description: '', version: '' }],
      counts: testCounts({ 'biblio-dev': 1, 'biblio-art': 1 }),
      total: 2,
      appliedFilter: 'biblio-dev',
    });
    await handler({ action: 'list_biblio', category: 'biblio-dev' }, dummySession, dummyDb);
    expect(listBiblioMock).toHaveBeenCalledWith({ category: 'biblio-dev' }, expect.anything());
    const text = getWrittenText();
    expect(text).toContain('biblio-dev');
    expect(text).toContain('2 件');
    expect(text).toContain('うち 1 件');
  });

  it('不正 category は silent fallback で全件 + 注記', async () => {
    listBiblioMock.mockResolvedValue({
      ok: true,
      items: [{ name: 'a--b', category: 'biblio-dev', description: '', version: '' }],
      counts: testCounts({ 'biblio-dev': 1 }),
      total: 1,
      appliedFilter: null,
    });
    await handler({ action: 'list_biblio', category: 'invalid' }, dummySession, dummyDb);
    // 不正値は undefined にフォールバックして全件取得を要求する。
    expect(listBiblioMock).toHaveBeenCalledWith({ category: undefined }, expect.anything());
    const text = getWrittenText();
    expect(text).toContain('invalid');
    expect(text).toContain('全件を返しました');
  });

  it('listBiblio が throw しても writeBack に internal エラーを書く', async () => {
    listBiblioMock.mockRejectedValue(new Error('boom'));
    await handler({ action: 'list_biblio', category: '' }, dummySession, dummyDb);
    const text = getWrittenText();
    expect(text).toContain('蔵書一覧取得エラー');
    expect(text).toContain('boom');
  });

  it('unknown カテゴリが混在するとき "source 解析不能、要確認" 行が出力される', async () => {
    // `formatResult` の `counts.unknown > 0` 分岐を action test レベルで通す。
    // list-biblio.test.ts は projectItem の unknown bucket を検証するが、
    // formatResult の表示分岐は本テストで担保する。
    listBiblioMock.mockResolvedValue({
      ok: true,
      items: [
        { name: 'a--b', category: 'biblio-dev', description: '', version: '' },
        { name: 'x--y', category: 'unknown', description: '', version: '' },
      ],
      counts: testCounts({ 'biblio-dev': 1, unknown: 1 }),
      total: 2,
      appliedFilter: null,
    });
    await handler({ action: 'list_biblio', category: '' }, dummySession, dummyDb);
    const text = getWrittenText();
    expect(text).toContain('unknown (1)');
    expect(text).toContain('source 解析不能、要確認');
  });

  it('total=0 のとき空棚メッセージを返す', async () => {
    listBiblioMock.mockResolvedValue({
      ok: true,
      items: [],
      counts: testCounts(),
      total: 0,
      appliedFilter: null,
    });
    await handler({ action: 'list_biblio', category: '' }, dummySession, dummyDb);
    const text = getWrittenText();
    expect(text).toContain('まだ並んでいません');
    expect(text).toContain('仕入れ → 検品');
  });
});
