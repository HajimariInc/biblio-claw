/**
 * `config.ts` の DATA_DIR / GROUPS_DIR 絶対化 (= `path.resolve()` ラップ) の回帰テスト。
 *
 * 背景: PR #20 で発覚した silent fail (= `DATA_DIR=./data` のような相対パスが env で
 * 渡されると docker run -v が「相対 = local volume 名」と解釈して exit 125 で reject)
 * の根本対処として、`config.ts` の env override 経路を `path.resolve()` で包んだ。
 * 本テストは将来のリファクタで `path.resolve` が外れた場合を回帰防止する。
 *
 * `config.ts` は module load 時に env を評価するため、`vi.resetModules()` + dynamic import で
 * 都度 fresh module を取得する必要がある。
 */
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('config.ts: DATA_DIR / GROUPS_DIR 絶対化', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  it('DATA_DIR: env で相対パスを渡しても絶対パスとして export される', async () => {
    process.env.DATA_DIR = './relative/path';
    const { DATA_DIR } = await import('./config.js');
    expect(path.isAbsolute(DATA_DIR)).toBe(true);
    expect(DATA_DIR).toBe(path.resolve('./relative/path'));
  });

  it('DATA_DIR: env で絶対パスを渡してもそのまま (= path.resolve は idempotent)', async () => {
    process.env.DATA_DIR = '/tmp/biblio-test-data';
    const { DATA_DIR } = await import('./config.js');
    expect(DATA_DIR).toBe('/tmp/biblio-test-data');
  });

  it('DATA_DIR: env 未設定なら PROJECT_ROOT/data に解決される (絶対パス)', async () => {
    delete process.env.DATA_DIR;
    const { DATA_DIR } = await import('./config.js');
    expect(path.isAbsolute(DATA_DIR)).toBe(true);
    expect(DATA_DIR).toMatch(/[/\\]data$/);
  });

  it('GROUPS_DIR: env で相対パスを渡しても絶対パスとして export される', async () => {
    process.env.GROUPS_DIR = '../outside/groups';
    const { GROUPS_DIR } = await import('./config.js');
    expect(path.isAbsolute(GROUPS_DIR)).toBe(true);
    expect(GROUPS_DIR).toBe(path.resolve('../outside/groups'));
  });

  it('GROUPS_DIR: env 未設定なら PROJECT_ROOT/groups に解決される (絶対パス)', async () => {
    delete process.env.GROUPS_DIR;
    const { GROUPS_DIR } = await import('./config.js');
    expect(path.isAbsolute(GROUPS_DIR)).toBe(true);
    expect(GROUPS_DIR).toMatch(/[/\\]groups$/);
  });
});
