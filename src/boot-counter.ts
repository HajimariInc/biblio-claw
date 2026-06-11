import type Database from 'better-sqlite3';

import { log } from './log.js';

/**
 * boots カウンタを 1 増分する (PoC-13 写経の決定的指紋)。
 *
 * Pod 起動 (= host プロセスの起動) ごとに本関数を呼ぶと、central DB の boots
 * テーブル (migration016 で作成) の count が +1 される。Pod 再作成跨ぎで count が
 * monotonic increment することは「同じ PVC が再 attach されて DB が消えていない」
 * = PVC + SQLite の永続化が機能していることの assertion になる。
 *
 * テーブルと初期行 (id=1, count=0) は migration016 で確保するので、本関数は
 * 単純な UPDATE で count を +1 するだけで良い (INSERT...ON CONFLICT を持たない
 * 古い SQLite でも安全)。
 *
 * @returns 増分後の count (異常時は -1)
 */
export function incrementBootCounter(db: Database.Database): number {
  db.prepare(`UPDATE boots SET count = count + 1, last_boot_at = datetime('now') WHERE id = 1`).run();
  const row = db.prepare('SELECT count FROM boots WHERE id = 1').get() as { count: number } | undefined;
  if (!row) {
    // migration016 で id=1 行が必ず作成されるので、ここに来るのは異常。
    // boots テーブル自体が無いか、migration が走っていない状態。
    log.error('boots row missing — migration016 not applied?');
    return -1;
  }
  log.info('Boot counter incremented', { count: row.count });
  return row.count;
}
