/**
 * PR #145 review type-design-analyzer CR-3 対応 = 回帰テスト。
 *
 * `src/index.ts` の main() 内で組み立てられる deliveryAdapter (`setTyping` / `deliver`)
 * が受け取った引数を漏らさず vendor 側 (`getChannelAdapter(...).setTyping` /
 * `.deliver`) に forward していることを **static grep** で機械的に固定化する。
 *
 * なぜ必要か:
 * - PR #145 Wave 1 の C1 で発現した「setTyping wrapper の 4 引数目 `status` を落として
 *   書いたが TS の余剰引数無視で型検査が素通り、silent drop」の再発防止。
 * - `tsc --strict --noEmit` で実測: 「宣言引数が少ない実装」を関数部分型付けが常に
 *   許すため、`ChannelDeliveryAdapter.setTyping` 型を締めても検知できない。
 * - main() を実行しないため mock 地獄を回避 (`src/index.ordering.test.ts` と同流儀)。
 *
 * 何を検証するか:
 *   (1) setTyping wrapper 内で `adapter?.setTyping?.(platformId, threadId, status)` の
 *       3 引数呼出が存在する (= 4 引数目 `status` を forward しない書き方に変わったら赤い)
 *   (2) deliver wrapper 内で adapter.deliver に `files` が forward される呼出構造が存在する
 *       (= 同種の余剰引数無視罠を deliver にも派生させない)
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const SRC = readFileSync(new URL('./index.ts', import.meta.url), 'utf-8');

describe('deliveryAdapter argument forwarding (static assertion)', () => {
  it('setTyping wrapper forwards status as the 3rd arg to adapter.setTyping', () => {
    // 「adapter?.setTyping?.(platformId, threadId, status)」の 3 引数呼出が本文中に
    // 存在することを確認する。将来これを 2 引数に落として書いた (C1 再発) 場合、
    // ここで即赤くなる。改行や空白は許容する寛容な正規表現。
    const pattern = /adapter\?\.setTyping\?\.\(\s*platformId\s*,\s*threadId\s*,\s*status\s*\)/;
    expect(pattern.test(SRC)).toBe(true);
  });

  it('deliver wrapper forwards files to adapter.deliver as message.files', () => {
    // deliver は message オブジェクトを組み立てて渡す形。message 内に files が
    // 含まれることを確認 (files を落として書いたら派生 C1 として silent drop する)。
    const pattern = /return\s+adapter\.deliver\(\s*platformId\s*,\s*threadId\s*,\s*\{[^}]*files[^}]*\}\s*\)/s;
    expect(pattern.test(SRC)).toBe(true);
  });

  it('setTyping wrapper accepts status as a 4th parameter (signature preserved)', () => {
    // wrapper 側 signature が 4 引数を受け付けていることを確認 (= 過去に一度 3 引数に
    // 落として書いたのが C1 の原因。宣言側で余剰引数無視される罠なので signature
    // sanity も併せて確認する)。
    const pattern =
      /async\s+setTyping\s*\(\s*channelType[\s:]+string\s*,\s*platformId[\s:]+string\s*,\s*threadId[\s\S]*?status\?/;
    expect(pattern.test(SRC)).toBe(true);
  });
});
