/**
 * 蔵書一覧 (list-biblio) の純粋関数ロジックのユニットテスト。
 *
 * - `shelf-gh.ts` の `fetchMarketplace` + `readShelveEnv` のみを vi.mock で差し替え
 * - `pluginsOf` は **`vi.importActual` で本物を取り込む** (= shelf-gh.ts の実装変更に追従、
 *   インライン再実装によるコピー乖離リスクを除去)
 * - 6 ケースで分岐を網羅: 404 / 全件 / category フィルタ / 不正 source / name 空 skip / plugins 非配列
 *
 * 実 GitHub への到達は scripts/biblio-list.ts (CLI ハーネス) + verify-m3.sh
 * で担保する。本テストは projectItem + filter + counts ロジックのみ。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// shelf-gh を partial mock — fetchMarketplace + readListEnv のみ差し替え、
// pluginsOf は本物 (= shelf-gh.ts の実装) をそのまま委譲する。
// list-biblio.ts は read-only 経路のため readListEnv (owner/repo のみ) を mock する
// (= Phase 4.6 で list-biblio.ts は readShelveEnv → readListEnv に切替済)。
vi.mock('./shelf-gh.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shelf-gh.js')>();
  return {
    ...actual,
    readListEnv: vi.fn(() => ({
      shelfOwner: 'HajimariInc',
      shelfRepo: 'biblio-shelf',
    })),
    fetchMarketplace: vi.fn(),
  };
});

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { fetchMarketplace } from './shelf-gh.js';

import { listBiblio } from './list-biblio.js';

const fmtMock = fetchMarketplace as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  fmtMock.mockReset();
});

describe('listBiblio', () => {
  it('404 (raw=null) — 棚が空として正常応答', async () => {
    fmtMock.mockResolvedValue({ raw: null, sha: null });
    const r = await listBiblio({});
    expect(r.ok).toBe(true);
    expect(r.total).toBe(0);
    expect(r.items).toEqual([]);
    expect(r.counts).toEqual({
      'biblio-dev': 0,
      'biblio-art': 0,
      'biblio-bf': 0,
      'biblio-ai': 0,
      unknown: 0,
    });
    expect(r.appliedFilter).toBeNull();
  });

  it('全件取得 — counts と items が一致、appliedFilter=null', async () => {
    fmtMock.mockResolvedValue({
      raw: {
        plugins: [
          { name: 'a--b', source: './biblio-dev/a--b', description: 'd1', version: '1.0' },
          { name: 'c--d', source: './biblio-dev/c--d', description: 'd2', version: '0.1' },
          { name: 'e--f', source: './biblio-art/e--f', description: '', version: '' },
        ],
      },
      sha: 'sha1',
    });
    const r = await listBiblio({});
    expect(r.total).toBe(3);
    expect(r.items).toHaveLength(3);
    expect(r.counts['biblio-dev']).toBe(2);
    expect(r.counts['biblio-art']).toBe(1);
    expect(r.counts['biblio-bf']).toBe(0);
    expect(r.counts['biblio-ai']).toBe(0);
    expect(r.counts.unknown).toBe(0);
    expect(r.appliedFilter).toBeNull();
  });

  it('category フィルタ — counts は全件のまま、items のみ絞り込み', async () => {
    fmtMock.mockResolvedValue({
      raw: {
        plugins: [
          { name: 'a--b', source: './biblio-dev/a--b' },
          { name: 'c--d', source: './biblio-art/c--d' },
        ],
      },
      sha: 'sha1',
    });
    const r = await listBiblio({ category: 'biblio-dev' });
    expect(r.total).toBe(2);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.name).toBe('a--b');
    expect(r.counts['biblio-dev']).toBe(1);
    expect(r.counts['biblio-art']).toBe(1);
    expect(r.appliedFilter).toBe('biblio-dev');
  });

  it('不正な source は category=unknown にバケットされる', async () => {
    fmtMock.mockResolvedValue({
      raw: { plugins: [{ name: 'x--y', source: 'malformed' }] },
      sha: 'sha1',
    });
    const r = await listBiblio({});
    expect(r.items[0]?.category).toBe('unknown');
    expect(r.counts.unknown).toBe(1);
    expect(r.total).toBe(1);
  });

  it('name が空のエントリは skip される (= total に乗らない)', async () => {
    fmtMock.mockResolvedValue({
      raw: {
        plugins: [
          { name: '', source: './biblio-dev/x' },
          { name: 'a--b', source: './biblio-dev/a--b' },
        ],
      },
      sha: 'sha1',
    });
    const r = await listBiblio({});
    expect(r.total).toBe(1);
    expect(r.items[0]?.name).toBe('a--b');
    expect(r.counts['biblio-dev']).toBe(1);
  });

  it('plugins フィールドが非配列 — 空配列として扱う', async () => {
    fmtMock.mockResolvedValue({ raw: { plugins: 'broken' }, sha: 'sha1' });
    const r = await listBiblio({});
    expect(r.total).toBe(0);
    expect(r.items).toEqual([]);
  });
});
