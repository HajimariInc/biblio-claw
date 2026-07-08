/**
 * `pollActive` best-effort 契約の回帰テスト (static grep 経路)。
 *
 * `src/delivery.ts` の `pollActive()` は 1s tick ループで
 * `deliverSessionMessages` → `refreshProgressStatus` を直列実行する。この経路の
 * best-effort 契約 (progress-status failure が delivery を殺さない) を **static
 * grep** で機械的に固定化する。
 *
 * なぜ必要か:
 * - `pollActive` は `setTimeout` の自己再帰 + `await` を含むためユニットテストで
 *   直接発火させると poll loop がテスト間で漏れる (fake timer で捕まえきれない)。
 * - 直接 test しにくい代わりに「契約に必要な構造」= 3 点 (1s tick loop / catch
 *   吸収 / 継続 setTimeout) を static grep で fix する = 将来リファクタで silent
 *   に落ちても赤くなる。
 * - 1s tick 経路の中核契約を最低限のコストで守る狙い。
 *
 * 何を検証するか:
 *   (1) pollActive() 内で `refreshProgressStatus(session)` を await 呼出している
 *   (2) `.catch()` で例外を拾い、log.warn を event 名付きで発火している
 *   (3) 外側 try/catch が `Active delivery poll error` を拾い、無限に伝播しない
 *   (4) `setTimeout(pollActive, ACTIVE_POLL_MS)` で継続 (loop が生き続ける)
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const SRC = readFileSync(new URL('./delivery.ts', import.meta.url), 'utf-8');

describe('pollActive best-effort 契約 (static assertion)', () => {
  it('pollActive() 内で refreshProgressStatus(session) を await している', () => {
    // deliverSessionMessages と直列で走る 1s tick 経路の存在を確認。
    const pattern = /await\s+refreshProgressStatus\(session\)/;
    expect(pattern.test(SRC)).toBe(true);
  });

  it('refreshProgressStatus 呼出に .catch() が付き log.warn 発火する', () => {
    // best-effort 契約: reject を吸収して構造化 warn を発火 (event: 'progress.status.refresh_failed')。
    const pattern =
      /refreshProgressStatus\(session\)\.catch\([\s\S]*?event:\s*['"]progress\.status\.refresh_failed['"]/s;
    expect(pattern.test(SRC)).toBe(true);
  });

  it('pollActive() 外側 try/catch が Active delivery poll error を拾う', () => {
    // 例: `catch (err) { log.error('Active delivery poll error', { err }); }` を確認。
    const pattern = /log\.error\(\s*['"]Active delivery poll error['"]/;
    expect(pattern.test(SRC)).toBe(true);
  });

  it('setTimeout(pollActive, ACTIVE_POLL_MS) で継続する (loop 生き続け保証)', () => {
    const pattern = /setTimeout\(\s*pollActive\s*,\s*ACTIVE_POLL_MS\s*\)/;
    expect(pattern.test(SRC)).toBe(true);
  });

  it('drainSession db open 判定は isPreSpawnDbOpenError を使う (regression 防止)', () => {
    // SQLITE_CANTOPEN を `poller.ts` と共通化した helper 化が
    // 剥がれると本 test が赤くなる。
    const pattern = /if\s*\(\s*isPreSpawnDbOpenError\(code\)\s*\)/;
    expect(pattern.test(SRC)).toBe(true);
  });
});
