/**
 * `router.ts` progress-status 配線の static grep 回帰テスト。
 *
 * `src/router.ts` の progress-status 配線 (今回 PR の存在理由 = 実機 status race fix
 * を守る唯一の safety net) を **static grep** で機械的に固定化する。
 *
 * なぜ必要か:
 * - `startTypingRefresh(null)` + 分離 `updateTypingStatus` の 2 発 →
 *   `initialStatus` 引数経由の 1 発集約に変更した実機 race fix は、`typing/index.ts`
 *   側の unit test で「initialStatus を渡せば race が起きない」ことしか保証しない。
 *   「router.ts が実際に initialStatus を渡しているか」は既存 test で未保証。
 * - 誰かが将来 router.ts をリファクタして `startTypingRefresh(session.id, ...,
 *   event.threadId)` の第 6 引数 (`PIPELINE_STATUS.CONTAINER_STARTING`) を落として
 *   書いても、既存 test は全て green のまま通ってしまう。
 * - main() を実行しないため mock 地獄を回避 (`src/index.ordering.test.ts` /
 *   `src/index.test.ts` と同流儀の static assertion)。
 *
 * 何を検証するか:
 *   (1) `emitPreSpawnStatus(event.channelType, event.platformId, event.threadId,
 *       PIPELINE_STATUS.GATE_CLASSIFYING)` の呼出パターンが存在する
 *   (2) `startTypingRefresh(..., PIPELINE_STATUS.CONTAINER_STARTING)` を渡す呼出
 *       パターンが存在する
 *   (3) `updateTypingStatus` の import が残っていない (regression 防止)
 *   (4) `PIPELINE_STATUS` を import している (定数集約経路が保たれている)
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const SRC = readFileSync(new URL('./router.ts', import.meta.url), 'utf-8');

describe('router.ts progress-status 配線 (static assertion)', () => {
  it('emitPreSpawnStatus に PIPELINE_STATUS.GATE_CLASSIFYING を渡す呼出が存在する', () => {
    // `void emitPreSpawnStatus(event.channelType, event.platformId, event.threadId,
    //   PIPELINE_STATUS.GATE_CLASSIFYING)` の呼出構造を寛容な正規表現で確認する。
    // 引数のいずれかを落として書いたら赤くなる (「event.channelType」または
    // 「PIPELINE_STATUS.GATE_CLASSIFYING」の grep miss)。
    const pattern =
      /emitPreSpawnStatus\(\s*event\.channelType\s*,\s*event\.platformId\s*,\s*event\.threadId\s*,\s*PIPELINE_STATUS\.GATE_CLASSIFYING/s;
    expect(pattern.test(SRC)).toBe(true);
  });

  it('startTypingRefresh に initialStatus=PIPELINE_STATUS.CONTAINER_STARTING を渡す呼出が存在する', () => {
    // wake 分岐の `startTypingRefresh(session.id, session.agent_group_id,
    //   event.channelType, event.platformId, event.threadId,
    //   PIPELINE_STATUS.CONTAINER_STARTING)` を確認。第 6 引数の initialStatus を
    // 落として書いたら過去に解消済の「Typing... 後勝ち」race が復活する。
    const pattern = /startTypingRefresh\([\s\S]*?PIPELINE_STATUS\.CONTAINER_STARTING/;
    expect(pattern.test(SRC)).toBe(true);
  });

  it('PIPELINE_STATUS を progress-status barrel から import している (定数集約経路)', () => {
    // 「'./modules/progress-status/index.js'」から PIPELINE_STATUS を取り込むこと。
    // 定数集約経路が壊れて hardcode 文字列に戻ったら赤くなる。
    const pattern = /import\s*\{[^}]*PIPELINE_STATUS[^}]*\}\s*from\s*['"]\.\/modules\/progress-status\/index\.js['"]/;
    expect(pattern.test(SRC)).toBe(true);
  });

  it('updateTypingStatus の import が存在しない (regression 防止)', () => {
    // router.ts では updateTypingStatus は使わない (呼出は poller.ts / typing/index.ts
    // 内側のみ)。誤って import すると `pnpm run lint` が unused-var で落ちる回帰罠。
    const pattern = /import\s*\{[^}]*\bupdateTypingStatus\b[^}]*\}\s*from\s*['"]\.\/modules\/typing\/index\.js['"]/;
    expect(pattern.test(SRC)).toBe(false);
  });

  it('emitPreSpawnStatus 呼出に .catch() が付いている (unhandledRejection 撲滅)', () => {
    // fire-and-forget の void 呼出が unhandledRejection に落ちて event / request_id が
    // 失われる silent failure を防ぐため .catch() を明示する。dispatcher.ts の
    // emitAdkToolStatus と同流儀。
    const pattern = /void\s+emitPreSpawnStatus\(\s*[\s\S]*?\)\.catch/s;
    expect(pattern.test(SRC)).toBe(true);
  });
});
