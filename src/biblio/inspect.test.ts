/**
 * 検品 (inspect) の決定的ロジックのユニットテスト。
 *
 * - 4 fixture (`__fixtures__/`) を `quarantineRoot` で直指して読ませる
 * - vertex-client は `vi.mock` で callVertexClaude を mock (実 LLM は verify で確認)
 * - schema (name 欠落 / 不正 JSON / 不在 / plugin.json 無し)
 * - license (deny / allow / 欠落 / 不明) を 4 fixture + tmpfs で網羅
 * - dangerous (DANGEROUS → REJECT / CLEAN → ACCEPT / fetch throw → HOLD / 出力崩れ → HOLD)
 *
 * acquire.test.ts と同じ vi.mock 境界 (config / log) + vi.hoisted tmpfs パスを踏襲。
 * 真の決定性 (実 LLM 3 回一致) は scripts/verify-m2-b-phase-2.sh で担保する。
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/biblio-inspect-test-${process.pid}` }));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// vertex-client は丸ごと mock (実 LLM 呼び出しを test で発火させない)。
vi.mock('./vertex-client.js', () => ({
  callVertexGemini: vi.fn(),
  setupVertexProxy: vi.fn(),
}));

import { callVertexGemini } from './vertex-client.js';
import { inspect } from './inspect.js';

const FIXTURES_ROOT = path.join(__dirname, '__fixtures__');
const mockLlm = vi.mocked(callVertexGemini);

/** `verdict: CLEAN` を返す LLM mock を仕込む。 */
function mockClean(): void {
  mockLlm.mockResolvedValue('説明不要 — 本文に危険パターンなし\nVERDICT: CLEAN');
}

/** `verdict: DANGEROUS` を返す LLM mock を仕込む。 */
function mockDangerous(): void {
  mockLlm.mockResolvedValue('rm -rf $HOME/* を検出\nVERDICT: DANGEROUS');
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  mockLlm.mockReset();
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('inspect — 存在確認', () => {
  it('quarantine 内に対象が無いと HOLD/inspect_error を返す', async () => {
    const result = await inspect({ biblioName: 'missing' }, { quarantineRoot: TEST_DIR });
    expect(result).toMatchObject({
      verdict: 'HOLD',
      biblioName: 'missing',
      reason: 'inspect_error',
      detail: expect.stringContaining('quarantine path not accessible'),
    });
    expect(mockLlm).not.toHaveBeenCalled();
  });
});

describe('inspect — schema 軸', () => {
  it('bad-schema (name 欠落) で REJECT/schema_invalid を返す (LLM 呼ばない)', async () => {
    const result = await inspect({ biblioName: 'bad-schema' }, { quarantineRoot: FIXTURES_ROOT });
    expect(result).toMatchObject({
      verdict: 'REJECT',
      biblioName: 'bad-schema',
      reason: 'schema_invalid',
      detail: expect.stringContaining('name'),
    });
    expect(mockLlm).not.toHaveBeenCalled();
  });

  it('plugin.json が不正 JSON で REJECT/schema_invalid を返す', async () => {
    const dir = path.join(TEST_DIR, 'broken');
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{ this is not json');
    const result = await inspect({ biblioName: 'broken' }, { quarantineRoot: TEST_DIR });
    expect(result).toMatchObject({
      verdict: 'REJECT',
      reason: 'schema_invalid',
      detail: expect.stringContaining('不正 JSON'),
    });
    expect(mockLlm).not.toHaveBeenCalled();
  });

  it('plugin.json 不在 (.claude-plugin 自体無し) で REJECT/schema_invalid を返す', async () => {
    const dir = path.join(TEST_DIR, 'no-manifest');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.md'), '# nothing');
    const result = await inspect({ biblioName: 'no-manifest' }, { quarantineRoot: TEST_DIR });
    expect(result).toMatchObject({
      verdict: 'REJECT',
      reason: 'schema_invalid',
      detail: expect.stringContaining('読めません'),
    });
    expect(mockLlm).not.toHaveBeenCalled();
  });
});

describe('inspect — license 軸', () => {
  it('no-modify-license (CC-BY-ND-4.0) で HOLD/license_denied を返す (LLM 呼ばない)', async () => {
    const result = await inspect({ biblioName: 'no-modify-license' }, { quarantineRoot: FIXTURES_ROOT });
    expect(result).toMatchObject({
      verdict: 'HOLD',
      biblioName: 'no-modify-license',
      reason: 'license_denied',
      detail: expect.stringContaining('CC-BY-ND-4.0'),
    });
    expect(mockLlm).not.toHaveBeenCalled();
  });

  it('license フィールド欠落で HOLD/license_unknown を返す', async () => {
    const dir = path.join(TEST_DIR, 'no-license');
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'no-license' }));
    const result = await inspect({ biblioName: 'no-license' }, { quarantineRoot: TEST_DIR });
    expect(result).toMatchObject({
      verdict: 'HOLD',
      reason: 'license_unknown',
      detail: expect.stringContaining('指定されていません'),
    });
    expect(mockLlm).not.toHaveBeenCalled();
  });

  it('allow リスト外ライセンス (GPL-3.0) で HOLD/license_unknown を返す', async () => {
    const dir = path.join(TEST_DIR, 'gpl');
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'gpl', license: 'GPL-3.0' }),
    );
    const result = await inspect({ biblioName: 'gpl' }, { quarantineRoot: TEST_DIR });
    expect(result).toMatchObject({
      verdict: 'HOLD',
      reason: 'license_unknown',
      detail: expect.stringContaining('GPL-3.0'),
    });
    expect(mockLlm).not.toHaveBeenCalled();
  });

  it('Proprietary (NoDerivatives 系として扱う) で HOLD/license_denied を返す', async () => {
    const dir = path.join(TEST_DIR, 'prop');
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'prop', license: 'Proprietary' }),
    );
    const result = await inspect({ biblioName: 'prop' }, { quarantineRoot: TEST_DIR });
    expect(result).toMatchObject({ verdict: 'HOLD', reason: 'license_denied' });
  });
});

describe('inspect — dangerous 軸 (LLM mock)', () => {
  it('clean-biblio + LLM=CLEAN で ACCEPT を返す', async () => {
    mockClean();
    const result = await inspect({ biblioName: 'clean-biblio' }, { quarantineRoot: FIXTURES_ROOT });
    expect(result).toEqual({ verdict: 'ACCEPT', biblioName: 'clean-biblio' });
    expect(mockLlm).toHaveBeenCalledTimes(1);
    // 本文集約に SKILL.md が含まれていることを確認 (集約パスの retention テスト)。
    const calledWith = mockLlm.mock.calls[0]?.[0];
    expect(calledWith?.prompt).toContain('----- FILE:');
    expect(calledWith?.prompt).toContain('SKILL.md');
    expect(calledWith?.temperature).toBe(0);
  });

  it('dangerous-code + LLM=DANGEROUS で REJECT/dangerous_code を返す', async () => {
    mockDangerous();
    const result = await inspect({ biblioName: 'dangerous-code' }, { quarantineRoot: FIXTURES_ROOT });
    expect(result).toMatchObject({
      verdict: 'REJECT',
      biblioName: 'dangerous-code',
      reason: 'dangerous_code',
      detail: expect.stringContaining('危険パターン'),
    });
  });

  it('LLM 呼び出しが throw すると HOLD/inspect_error に倒れる (fail-closed)', async () => {
    mockLlm.mockRejectedValue(new Error('rawPredict 500 — boom'));
    const result = await inspect({ biblioName: 'clean-biblio' }, { quarantineRoot: FIXTURES_ROOT });
    expect(result).toMatchObject({
      verdict: 'HOLD',
      reason: 'inspect_error',
      detail: expect.stringContaining('rawPredict 500'),
    });
  });

  it('LLM 出力に VERDICT 行が無いと HOLD/inspect_error に倒れる', async () => {
    mockLlm.mockResolvedValue('説明だけして VERDICT を出さない応答');
    const result = await inspect({ biblioName: 'clean-biblio' }, { quarantineRoot: FIXTURES_ROOT });
    expect(result).toMatchObject({
      verdict: 'HOLD',
      reason: 'inspect_error',
      detail: expect.stringContaining('VERDICT'),
    });
  });

  it('LLM 出力の VERDICT 行が DANGEROUS / CLEAN どちらでもないと HOLD/inspect_error', async () => {
    mockLlm.mockResolvedValue('VERDICT: MAYBE');
    const result = await inspect({ biblioName: 'clean-biblio' }, { quarantineRoot: FIXTURES_ROOT });
    expect(result).toMatchObject({
      verdict: 'HOLD',
      reason: 'inspect_error',
      detail: expect.stringContaining('判別不能'),
    });
  });

  it('VERDICT 行が複数あれば末尾を優先する', async () => {
    mockLlm.mockResolvedValue('VERDICT: CLEAN\nもう一度書きます\nVERDICT: DANGEROUS');
    const result = await inspect({ biblioName: 'clean-biblio' }, { quarantineRoot: FIXTURES_ROOT });
    expect(result).toMatchObject({ verdict: 'REJECT', reason: 'dangerous_code' });
  });
});
