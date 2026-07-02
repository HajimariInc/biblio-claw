/**
 * `hitl-policy.ts` の matrix 全 8 組合せを固定するテスト (M4-E Phase 3 equip-hitl)。
 *
 * Fugue 契約 §6.2 の `requires_approval(operation, channel)` matrix と 1:1 の対応を
 * コードで担保する。matrix が Fugue 側と齟齬すると、biblio-claw / Fugue の HITL 期待が
 * 食い違って「Fugue Director が装備したのに Slack で承認カードが飛ぶ」等の混乱を招く。
 *
 * `equip@fugue = false` (簡略化) は本 Phase の中核意思決定なので、独立した it で明示する。
 */
import { describe, expect, it } from 'vitest';

import { requiresApproval, type HitlChannel, type HitlOperation } from './hitl-policy.js';

describe('requiresApproval matrix (Fugue 契約 §6.2)', () => {
  it('equip@fugue = false (HITL 簡略化、本 Phase の中核意思決定)', () => {
    expect(requiresApproval('equip', 'fugue')).toBe(false);
  });

  it('equip@slack = true (Slack 経由 equip は現状経路なし、M3 Phase 3.5 で実効化される)', () => {
    expect(requiresApproval('equip', 'slack')).toBe(true);
  });

  it('consult@fugue = false (読み取り、副作用なし)', () => {
    expect(requiresApproval('consult', 'fugue')).toBe(false);
  });

  it('consult@slack = false (読み取り、副作用なし)', () => {
    expect(requiresApproval('consult', 'slack')).toBe(false);
  });

  it('shiire@fugue = true (棚状態変更、破壊操作)', () => {
    expect(requiresApproval('shiire', 'fugue')).toBe(true);
  });

  it('shiire@slack = true (棚状態変更、破壊操作)', () => {
    expect(requiresApproval('shiire', 'slack')).toBe(true);
  });

  it('tekkyo@fugue = true (棚からの除去、破壊操作)', () => {
    expect(requiresApproval('tekkyo', 'fugue')).toBe(true);
  });

  it('tekkyo@slack = true (棚からの除去、破壊操作、既存 enkin/shokyaku 経路の分岐に該当)', () => {
    expect(requiresApproval('tekkyo', 'slack')).toBe(true);
  });

  // 全 matrix を it.each で回して、上記の個別 it が漏れたら気づく重ね持ちの網羅テスト
  const MATRIX: { op: HitlOperation; ch: HitlChannel; expected: boolean }[] = [
    { op: 'consult', ch: 'slack', expected: false },
    { op: 'consult', ch: 'fugue', expected: false },
    { op: 'equip', ch: 'slack', expected: true },
    { op: 'equip', ch: 'fugue', expected: false },
    { op: 'shiire', ch: 'slack', expected: true },
    { op: 'shiire', ch: 'fugue', expected: true },
    { op: 'tekkyo', ch: 'slack', expected: true },
    { op: 'tekkyo', ch: 'fugue', expected: true },
  ];

  it.each(MATRIX)('requiresApproval($op, $ch) === $expected', ({ op, ch, expected }) => {
    expect(requiresApproval(op, ch)).toBe(expected);
  });
});
