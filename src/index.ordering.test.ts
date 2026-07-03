/**
 * PR #126 review I5 対応 = pr-test-analyzer 評価 7/10。
 *
 * `src/index.ts` の main() 内で 2 段 sentinel (`/tmp/boot-complete` と `/tmp/host-ready`) が
 * 書かれる順序を **static grep** で機械的に固定化する。main() を実行しない = mock 地獄を回避
 * しつつ「将来のリファクタで順序が入れ替わったら赤くなる」保証だけを得る。
 *
 * なぜ必要か:
 * - `/tmp/host-ready` は StatefulSet の `startupProbe` / `readinessProbe` / `livenessProbe` が
 *   exec `test -f /tmp/host-ready` で読む Pod ready 判定の境界 = 「全 subsystem 起動完了」を
 *   宣言する契約。この writeFileSync が `startCliServer()` や `initChannelAdapters()` より前に
 *   移動すると、Pod は「未初期化なのに ready」を宣言してしまう典型的 silent regression。
 * - `src/index.ts` の main() 全体は integration-only (`main()` は export されておらず、専用
 *   test は存在しない)。順序保証を「コメント」だけで表現するのは腐る。
 * - `src/boot-counter.test.ts` (「決定的指紋」を担保する専用 test) と同じ流儀。
 *
 * 何を検証するか:
 *   `writeFileSync('/tmp/boot-complete'` の出現位置 < `await startCliServer()` の出現位置
 *   < `writeFileSync('/tmp/host-ready'` の出現位置
 *
 * = boot-complete = migration + backfill 完了 → CLI socket server 起動 → host-ready = 全
 * subsystem 完了、の順序が保証される。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('main() boot sentinel ordering (static assertion)', () => {
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf-8');

  it('all 3 anchors exist in src/index.ts', () => {
    // 前提: sentinel 書き込み 2 箇所 + startCliServer 呼び出し 1 箇所が存在する
    // (どれかが消えた場合はここで即赤くなる = 順序 assertion 前の sanity check)
    expect(src).toContain("writeFileSync('/tmp/boot-complete'");
    expect(src).toContain('await startCliServer()');
    expect(src).toContain("writeFileSync('/tmp/host-ready'");
  });

  it('/tmp/boot-complete is written before startCliServer()', () => {
    const idxBootComplete = src.indexOf("writeFileSync('/tmp/boot-complete'");
    const idxStartCli = src.indexOf('await startCliServer()');
    expect(idxBootComplete).toBeGreaterThan(-1);
    expect(idxStartCli).toBeGreaterThan(-1);
    expect(idxBootComplete).toBeLessThan(idxStartCli);
  });

  it('/tmp/host-ready is written after startCliServer() and after /tmp/boot-complete', () => {
    // これが本 test の主契約 = K8s startupProbe が host-ready を「全 subsystem 起動完了」の
    // signal として信頼する不変条件を守る。将来 host-ready の writeFileSync が
    // startCliServer() より前に移動したり、boot-complete より前に移動したら赤くなる。
    const idxBootComplete = src.indexOf("writeFileSync('/tmp/boot-complete'");
    const idxStartCli = src.indexOf('await startCliServer()');
    const idxHostReady = src.indexOf("writeFileSync('/tmp/host-ready'");
    expect(idxBootComplete).toBeGreaterThan(-1);
    expect(idxStartCli).toBeGreaterThan(-1);
    expect(idxHostReady).toBeGreaterThan(-1);
    expect(idxHostReady).toBeGreaterThan(idxStartCli);
    expect(idxHostReady).toBeGreaterThan(idxBootComplete);
  });
});
