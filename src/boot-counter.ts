import type Database from 'better-sqlite3';

import { log } from './log.js';

/**
 * boots カウンタを 1 増分する (PVC + SQLite 永続化の決定的指紋)。
 *
 * Pod 起動 (= host プロセスの起動) ごとに本関数を呼ぶと、central DB の boots
 * テーブル (migration016 で作成) の count が +1 され、last_boot_at が現在時刻で
 * 更新される。Pod 再作成跨ぎで count が monotonic increment することは
 * 「同じ PVC が再 attach されて DB が消えていない」= PVC + SQLite の永続化が
 * 機能していることの assertion になる。
 *
 * テーブルと初期行 (id=1, count=0) は migration016 で確保するので、本関数は
 * 単純な UPDATE で count を +1 するだけで良い。
 *
 * @returns 増分後の count (異常時は -1)
 */
export function incrementBootCounter(db: Database.Database): number {
  const result = db.prepare(`UPDATE boots SET count = count + 1, last_boot_at = datetime('now') WHERE id = 1`).run();
  if (result.changes === 0) {
    // migration016 で id=1 行が必ず確保されるはずなので、ここに来るのは異常。
    // 行が消えた、または異なる DB を見ている可能性 (DSN 切替ミス / PVC 取り違え 等)。
    // UPDATE の changes を見ずに直後の SELECT に進むと、行がなくても count が変わらない
    // 古い値が読めるケースで気付けない (silent failure) ため、ここで必ず検知する。
    log.error('boots UPDATE affected 0 rows — id=1 row missing, migration016 not applied or wrong DB?');
    return -1;
  }
  const row = db.prepare('SELECT count FROM boots WHERE id = 1').get() as { count: number } | undefined;
  if (!row) {
    // UPDATE が changes=1 で成功した直後に SELECT で行が見えないのは、より深刻な異常。
    log.error('boots SELECT returned no row immediately after successful UPDATE — DB inconsistency?');
    return -1;
  }
  log.info('Boot counter incremented', { count: row.count });
  return row.count;
}
