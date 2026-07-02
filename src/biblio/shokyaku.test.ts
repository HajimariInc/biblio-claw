/**
 * 焼却 (shokyaku) の決定的ロジックのユニットテスト。
 *
 * `unshelve()` は mock で全置換 (= GitHub API は unshelve.test.ts でカバー済)。
 * 本テストは shokyaku 固有の cleanup 経路 (= fs.rmSync + deleteEquippedBiblioByName) と、
 * **cleanup 失敗時に ok=true 維持 + cleanupWarning に蓄積** の設計 (PR #15 silent-failure HIGH 2
 * 対応) を unit レベルで固定する。
 */
import fs from 'node:fs';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const unshelveResultOk = {
  ok: true as const,
  biblioName: 'owner--repo',
  category: 'biblio-dev' as const,
  prUrl: 'https://github.com/HajimariInc/biblio-shelf/pull/99',
  prNumber: 99,
  branchName: 'shokyaku/biblio-dev--owner--repo-2026-06-21T20-00-00',
};

const unshelveResultFail = {
  ok: false as const,
  biblioName: 'owner--repo',
  reason: 'not_shelved' as const,
  detail: '既に解除済',
};

const unshelveMock = vi.fn();
vi.mock('./unshelve.js', () => ({
  unshelve: (...args: unknown[]) => unshelveMock(...args),
}));

const deleteEquippedMock = vi.fn();
vi.mock('../db/session-equipped-biblios.js', () => ({
  deleteEquippedBiblioByName: (name: unknown) => deleteEquippedMock(name),
}));

const deleteFugueEquippedMock = vi.fn();
vi.mock('../db/fugue-equipped-biblios.js', () => ({
  deleteFugueEquippedBiblioByName: (name: unknown) => deleteFugueEquippedMock(name),
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { shokyaku } from './shokyaku.js';

beforeEach(() => {
  unshelveMock.mockReset();
  deleteEquippedMock.mockReset();
  deleteFugueEquippedMock.mockReset();
  // 既定は成功 (= changes=0、既存 test の対称性を保つ)。fugue 側 delete も test で明示 override 可。
  deleteFugueEquippedMock.mockReturnValue(0);
});

describe('shokyaku — unshelve 失敗時の早期 return', () => {
  it('unshelve ok=false → 早期 return、fs.rmSync / DB delete は走らない', async () => {
    unshelveMock.mockResolvedValue(unshelveResultFail);
    const result = await shokyaku(
      { biblioName: 'owner--repo', category: 'biblio-dev' },
      { equipmentRoot: '/tmp/biblio-test-nonexistent-root' },
    );
    expect(result.ok).toBe(false);
    expect(deleteEquippedMock).not.toHaveBeenCalled();
  });
});

describe('shokyaku — cleanup 成功経路', () => {
  it('unshelve ok=true + rmSync 成功 + DB delete 成功 → ok=true、cleanupWarning なし', async () => {
    unshelveMock.mockResolvedValue(unshelveResultOk);
    deleteEquippedMock.mockReturnValue(2);

    // 存在しない dir を指定して force:true で no-op 経由
    const result = await shokyaku(
      { biblioName: 'owner--repo', category: 'biblio-dev' },
      { equipmentRoot: '/tmp/biblio-test-nonexistent-root' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable'); // 型 narrowing
    expect(result.prUrl).toBe(unshelveResultOk.prUrl);
    expect(result.cleanupWarning).toBeUndefined();
    expect(deleteEquippedMock).toHaveBeenCalledWith('owner--repo');
  });
});

describe('shokyaku — cleanup 失敗時 ok=true 維持 + cleanupWarning に蓄積 (silent failure 防止)', () => {
  it('fs.rmSync が throw でも ok=true + cleanupWarning に rmSync 失敗が立つ', async () => {
    unshelveMock.mockResolvedValue(unshelveResultOk);
    deleteEquippedMock.mockReturnValue(0);
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });

    const result = await shokyaku(
      { biblioName: 'owner--repo', category: 'biblio-dev' },
      { equipmentRoot: '/tmp/biblio-test-rmSync-fail' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.prUrl).toBe(unshelveResultOk.prUrl);
    expect(result.cleanupWarning).toBeDefined();
    expect(result.cleanupWarning).toContain('装備源 dir の物理削除に失敗');
    expect(result.cleanupWarning).toContain('EACCES');
    rmSpy.mockRestore();
  });

  it('deleteEquippedBiblioByName が throw でも ok=true + cleanupWarning に DB delete 失敗が立つ', async () => {
    unshelveMock.mockResolvedValue(unshelveResultOk);
    deleteEquippedMock.mockImplementation(() => {
      throw new Error('SQLITE_LOCKED: database is locked');
    });

    const result = await shokyaku(
      { biblioName: 'owner--repo', category: 'biblio-dev' },
      { equipmentRoot: '/tmp/biblio-test-db-fail' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.prUrl).toBe(unshelveResultOk.prUrl);
    expect(result.cleanupWarning).toBeDefined();
    expect(result.cleanupWarning).toContain('装備リスト DB の個別削除に失敗');
    expect(result.cleanupWarning).toContain('SQLITE_LOCKED');
  });

  it('deleteFugueEquippedBiblioByName が throw でも ok=true + cleanupWarning に Fugue DB delete 失敗が立つ (M4-E Phase 3 判断 J)', async () => {
    unshelveMock.mockResolvedValue(unshelveResultOk);
    deleteEquippedMock.mockReturnValue(0);
    deleteFugueEquippedMock.mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });

    const result = await shokyaku(
      { biblioName: 'owner--repo', category: 'biblio-dev' },
      { equipmentRoot: '/tmp/biblio-test-fugue-db-fail' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.prUrl).toBe(unshelveResultOk.prUrl);
    expect(result.cleanupWarning).toBeDefined();
    expect(result.cleanupWarning).toContain('Fugue 装備状態 DB の削除に失敗');
    expect(result.cleanupWarning).toContain('SQLITE_BUSY');
    // session 側 delete は成功しているので warn には出ない
    expect(result.cleanupWarning).not.toContain('装備リスト DB の個別削除に失敗');
  });

  it('shokyaku 成功時は deleteFugueEquippedBiblioByName を biblioName で 1 回呼ぶ', async () => {
    unshelveMock.mockResolvedValue(unshelveResultOk);
    deleteEquippedMock.mockReturnValue(0);
    deleteFugueEquippedMock.mockReturnValue(1);

    const result = await shokyaku(
      { biblioName: 'owner--repo', category: 'biblio-dev' },
      { equipmentRoot: '/tmp/biblio-test-fugue-success' },
    );

    expect(result.ok).toBe(true);
    expect(deleteFugueEquippedMock).toHaveBeenCalledWith('owner--repo');
    expect(deleteFugueEquippedMock).toHaveBeenCalledTimes(1);
  });

  it('rmSync + DB delete 両方 throw でも ok=true + cleanupWarning に両方の失敗が連結される', async () => {
    unshelveMock.mockResolvedValue(unshelveResultOk);
    deleteEquippedMock.mockImplementation(() => {
      throw new Error('db error');
    });
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
      throw new Error('rmSync error');
    });

    const result = await shokyaku(
      { biblioName: 'owner--repo', category: 'biblio-dev' },
      { equipmentRoot: '/tmp/biblio-test-both-fail' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.cleanupWarning).toContain('装備源 dir の物理削除に失敗');
    expect(result.cleanupWarning).toContain('装備リスト DB の個別削除に失敗');
    rmSpy.mockRestore();
  });
});
