/**
 * Tests for writeMessageOut retry behavior (issue #51).
 *
 * The function must:
 *   1. Succeed on first attempt when no SQLITE_BUSY occurs.
 *   2. Retry up to 3 attempts (1 initial + 2 retries) with linear backoff on throw.
 *   3. Throw after exhausting all retries (so server.ts can catch + return isError).
 *
 * Bun:sqlite の本物 SQLITE_BUSY を再現するのは難しいため、内部 Database#prepare
 * を spy で偽 throw させて契約 (retry 回数 / 最終 throw) を検証する。
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './connection.js';
import { writeMessageOut, getUndeliveredMessages } from './messages-out.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('writeMessageOut — retry on SQLITE_BUSY', () => {
  it('writes successfully on first attempt (no retry needed)', () => {
    const seq = writeMessageOut({ id: 'm1', kind: 'system', content: '{"action":"x"}' });
    expect(seq).toBe(1);
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('retries on SQLITE_BUSY then succeeds on second attempt', () => {
    const outbound = getOutboundDb();
    const realPrepare = outbound.prepare.bind(outbound);
    let insertCalls = 0;
    const prepareSpy = spyOn(outbound, 'prepare').mockImplementation((sql: string) => {
      const stmt = realPrepare(sql);
      if (sql.startsWith('INSERT INTO messages_out')) {
        const realRun = stmt.run.bind(stmt);
        // @ts-expect-error — patch run for the INSERT statement only
        stmt.run = (...args: unknown[]) => {
          insertCalls++;
          if (insertCalls === 1) {
            throw new Error('SQLITE_BUSY: database is locked');
          }
          return realRun(...(args as Parameters<typeof realRun>));
        };
      }
      return stmt;
    });

    try {
      const seq = writeMessageOut({ id: 'm2', kind: 'system', content: '{"action":"x"}' });
      expect(insertCalls).toBe(2); // 1st throws, 2nd succeeds
      expect(seq).toBeGreaterThan(0);
      // Container は odd seq を使う (host は even)。CLAUDE.md "disjoint namespace is
      // load-bearing": edit_message / add_reaction が seq → row lookup でホスト書き込み
      // と衝突しないことを保証する不変条件。retry 経由でも壊れてはならない。
      expect(seq % 2).toBe(1);
      expect(getUndeliveredMessages()).toHaveLength(1);
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it('seq is greater than inbound max when inbound has higher seq', () => {
    // Math.max(maxOut, maxIn) の inbound 寄与経路を検証。
    // inbound 読み取りを削除するリグレッションが入った場合に検知する。
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, content)
         VALUES ('h1', 10, 'text', datetime('now'), 'hello')`,
      )
      .run();

    const seq = writeMessageOut({ id: 'm-after-inbound', kind: 'system', content: '{"action":"x"}' });
    // inbound max = 10 (even) → next odd = 11
    expect(seq).toBe(11);
    expect(seq % 2).toBe(1);
  });

  it('throws after exhausting all 3 attempts and writes nothing', () => {
    const outbound = getOutboundDb();
    const realPrepare = outbound.prepare.bind(outbound);
    let insertCalls = 0;
    const prepareSpy = spyOn(outbound, 'prepare').mockImplementation((sql: string) => {
      const stmt = realPrepare(sql);
      if (sql.startsWith('INSERT INTO messages_out')) {
        // @ts-expect-error — patch run for the INSERT statement only
        stmt.run = () => {
          insertCalls++;
          throw new Error('SQLITE_BUSY: database is locked');
        };
      }
      return stmt;
    });

    try {
      expect(() =>
        writeMessageOut({ id: 'm3', kind: 'system', content: '{"action":"x"}' }),
      ).toThrow(/SQLITE_BUSY|database is locked/);
      expect(insertCalls).toBe(3); // 1 initial + 2 retries
      expect(getUndeliveredMessages()).toHaveLength(0);
    } finally {
      prepareSpy.mockRestore();
    }
  });
});
