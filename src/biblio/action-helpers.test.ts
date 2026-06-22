/**
 * action-helpers.ts のユニットテスト — Phase 4 で BIBLIO_NAME_RE を 3 要素対応に
 * 拡張した regression を直接固定する。
 *
 * 関数本体 (writeBackMessage / safeNotify / validateBiblioInput) のカバレッジは
 * 4 つの action handler test (= shelve / categorize / enkin / shokyaku) で網羅
 * 済みのため、本ファイルでは regex の入出力に集中する。
 */
import { describe, it, expect } from 'vitest';

import { BIBLIO_NAME_RE } from './action-helpers.js';

describe('BIBLIO_NAME_RE', () => {
  describe('2 要素 (M2 全体仕入れ経路) — 受理', () => {
    it.each([
      ['owner--repo'],
      ['HajimariInc--biblio-shelf'],
      ['anthropics--claude-code-skills'],
      ['a1--b2'],
      ['Vendor.Name--my_repo'],
      ['x-y--p_q.r'],
    ])('"%s" を受理する', (input) => {
      expect(BIBLIO_NAME_RE.test(input)).toBe(true);
    });
  });

  describe('3 要素 (Phase 3 individual-acquire 経路) — 受理', () => {
    it.each([
      ['owner--repo--skill'],
      ['anthropics--claude-code-skills--fire-marker'],
      ['HajimariInc--biblio-shelf--biblio-dev'],
      ['a1--b2--c3'],
      ['owner--repo--skill-with-dashes'],
      ['owner--repo--skill_underscores'],
      ['owner--repo--skill.dotted'],
    ])('"%s" を受理する', (input) => {
      expect(BIBLIO_NAME_RE.test(input)).toBe(true);
    });
  });

  describe('境界値 — 設計上 受理される (greedy matching の既知挙動を意図的に固定)', () => {
    // 文字クラス `[A-Za-z0-9._-]*` が `-` を含むため `--` が segment 内に紛れ込んでも受理される。
    // これは「先頭英数字 + 区切り存在 + path traversal 防御」の最小限制約として運用上問題に
    // ならない (= GitHub repo 名にこれらの形は出ない)。将来 regex を厳格化したとき
    // silent regression にならないよう、受理される境界を test として固定する。
    it.each([
      ['owner---repo'], // 3 連続ハイフン (= owner + "-repo" の組合せでマッチ)
      ['owner--repo--'], // 末尾セパレータ (= owner + repo + "" の 3 要素として受理)
      ['owner--repo--skill--extra'], // 4 要素以上 (= 3 要素まで定義だが greedy で受理、extractOwnerRepo で先頭 2 のみに丸める)
    ])('"%s" を受理する (= greedy 既知挙動、Phase 4 前から)', (input) => {
      expect(BIBLIO_NAME_RE.test(input)).toBe(true);
    });
  });

  describe('不正形式 — 拒否', () => {
    it.each([
      [''],
      ['short-name'], // セパレータなし
      ['owner-repo'], // 1 ハイフン (= owner--repo の `--` ではない)
      ['--owner--repo'], // 先頭セパレータ
      ['.owner--repo'], // 先頭が `.`
      ['_owner--repo'], // 先頭が `_`
      ['-owner--repo'], // 先頭が `-`
      ['owner/repo--skill'], // `/` 含む (path traversal)
      ['../../etc--passwd'], // `..` + `/` (path traversal)
    ])('"%s" を拒否する', (input) => {
      expect(BIBLIO_NAME_RE.test(input)).toBe(false);
    });
  });
});
