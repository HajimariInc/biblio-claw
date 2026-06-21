/**
 * 蔵書一覧 (list-biblio) の純粋関数ロジックのユニットテスト (M3 Phase 4)。
 *
 * - `shelf-gh.ts` を vi.mock で差し替え、`fetchMarketplace` の戻り値を制御
 * - `pluginsOf` は実装のまま委譲 (= raw plugins を返すだけの単純なヘルパ、border 維持)
 * - 6 ケースで分岐を網羅: 404 / 全件 / category フィルタ / 不正 source / name 空 skip / plugins 非配列
 *
 * 実 GitHub への到達は scripts/biblio-list.ts (CLI ハーネス) + Phase 5 verify-m3.sh
 * で担保する。本テストは projectItem + filter + counts ロジックのみ。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// shelf-gh をモック化 — fetchMarketplace は test ごとに mockResolvedValue で制御、
// pluginsOf は本物の挙動 (= raw.plugins が Array なら返す、それ以外は空配列) を維持する。
vi.mock('./shelf-gh.js', () => ({
  readShelveEnv: vi.fn(() => ({
    shelfOwner: 'HajimariInc',
    shelfRepo: 'biblio-shelf',
    authorName: 'biblio-claw[bot]',
    authorEmail: 'biblio-claw@example.com',
    fallbackAuthor: null,
  })),
  fetchMarketplace: vi.fn(),
  pluginsOf: (m: Record<string, unknown>) => (Array.isArray(m.plugins) ? m.plugins : []),
}));

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
