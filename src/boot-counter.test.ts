import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { incrementBootCounter } from './boot-counter.js';
import { runMigrations } from './db/migrations/index.js';

// log は info を呼ぶだけなので mock してテスト出力を汚さない
vi.mock('./log.js', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('incrementBootCounter', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // migration016 で boots テーブル + id=1 行 (count=0) が確保される
    runMigrations(db);
  });

  it('increments count from 0 to 1 on first call', () => {
    expect(incrementBootCounter(db)).toBe(1);
  });

  it('increments monotonically across multiple calls', () => {
    expect(incrementBootCounter(db)).toBe(1);
    expect(incrementBootCounter(db)).toBe(2);
    expect(incrementBootCounter(db)).toBe(3);
  });

  it('keeps the single-row invariant (id=1 only)', () => {
    incrementBootCounter(db);
    incrementBootCounter(db);
    const rows = db.prepare('SELECT id, count FROM boots').all() as { id: number; count: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ id: 1, count: 2 });
  });

  it('updates last_boot_at to a valid datetime string', () => {
    incrementBootCounter(db);
    const row = db.prepare('SELECT last_boot_at FROM boots WHERE id = 1').get() as {
      last_boot_at: string;
    };
    expect(row.last_boot_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('returns -1 and logs error when boots row is missing (defensive)', () => {
    db.exec('DELETE FROM boots');
    expect(incrementBootCounter(db)).toBe(-1);
  });
});
