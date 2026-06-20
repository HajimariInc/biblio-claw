/**
 * カテゴライズ (categorize) の決定的ロジックのユニットテスト。
 *
 * - vertex-client.callVertexAnthropic を vi.mock で制御 (実 LLM は verify-m2.sh で確認)
 * - tmpfs に biblio を組み立て、`quarantineRoot` で直接指す
 * - 4 namespace × 1 ケース + parse_error + llm_error + invalid_category + 本文 0 件 で網羅
 *
 * inspect.test.ts と同じ vi.mock 境界 (config / log / vertex-client) を踏襲。
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/biblio-categorize-test-${process.pid}` }));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('./vertex-client.js', () => ({
  callVertexAnthropic: vi.fn(),
  setupVertexProxy: vi.fn(),
}));

// readEnvFile は config.ts と別 mock 境界 (categorize 内で `CATEGORIZE_MODEL` を読むため、
// 期待モデル ID を確実に注入する)。
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({ CATEGORIZE_MODEL: 'claude-sonnet-4-6' })),
}));

import { callVertexAnthropic } from './vertex-client.js';
import { categorize } from './categorize.js';

const mockLlm = vi.mocked(callVertexAnthropic);

/** tmpfs 内に biblio dir を作り、SKILL.md と plugin.json を配置する。 */
function setupBiblio(name: string, opts: { description?: string; skill?: string } = {}): string {
  const dir = path.join(TEST_DIR, name);
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name,
      description: opts.description ?? 'sample biblio for test',
      license: 'MIT',
      version: '0.1.0',
    }),
  );
  fs.writeFileSync(path.join(dir, 'SKILL.md'), opts.skill ?? '# skill body');
  return dir;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  mockLlm.mockReset();
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('categorize — 4 namespace 判定', () => {
  it('biblio-dev に分類する LLM 応答で ok=true + category=biblio-dev', async () => {
    setupBiblio('owner--repo', { skill: '# refactor helper for TypeScript' });
    mockLlm.mockResolvedValue('CATEGORY: biblio-dev\nREASON: TypeScript refactor 補助の skill');
    const result = await categorize({ biblioName: 'owner--repo' }, { quarantineRoot: TEST_DIR });
    expect(result).toEqual({
      ok: true,
      biblioName: 'owner--repo',
      category: 'biblio-dev',
      reason: 'TypeScript refactor 補助の skill',
    });
  });

  it('biblio-art に分類する LLM 応答で category=biblio-art', async () => {
    setupBiblio('owner--art-skill', { skill: '# image style transfer' });
    mockLlm.mockResolvedValue('CATEGORY: biblio-art\nREASON: 画像スタイル変換の skill');
    const result = await categorize({ biblioName: 'owner--art-skill' }, { quarantineRoot: TEST_DIR });
    expect(result).toMatchObject({ ok: true, category: 'biblio-art' });
  });

  it('biblio-bf に分類する LLM 応答で category=biblio-bf', async () => {
    setupBiblio('owner--bf-skill', { skill: '# mail draft assistant' });
    mockLlm.mockResolvedValue('CATEGORY: biblio-bf\nREASON: メール起草補助の skill');
    const result = await categorize({ biblioName: 'owner--bf-skill' }, { quarantineRoot: TEST_DIR });
    expect(result).toMatchObject({ ok: true, category: 'biblio-bf' });
  });

  it('biblio-ai に分類する LLM 応答で category=biblio-ai', async () => {
    setupBiblio('owner--ai-skill', { skill: '# MCP server scaffold generator' });
    mockLlm.mockResolvedValue('CATEGORY: biblio-ai\nREASON: MCP server 雛形生成の skill');
    const result = await categorize({ biblioName: 'owner--ai-skill' }, { quarantineRoot: TEST_DIR });
    expect(result).toMatchObject({ ok: true, category: 'biblio-ai' });
  });
});

describe('categorize — fail-closed 経路', () => {
  it('quarantine 不在で ok=false / quarantine_missing', async () => {
    const result = await categorize({ biblioName: 'missing' }, { quarantineRoot: TEST_DIR });
    expect(result).toMatchObject({ ok: false, reason: 'quarantine_missing' });
    // LLM 自体は呼ばれない (= 存在確認で fail-fast)。
    expect(mockLlm).not.toHaveBeenCalled();
  });

  it('LLM が CATEGORY 行を返さないと parse_error', async () => {
    setupBiblio('owner--repo');
    mockLlm.mockResolvedValue('説明だけで構造化フォーマットなし');
    const result = await categorize({ biblioName: 'owner--repo' }, { quarantineRoot: TEST_DIR });
    expect(result).toMatchObject({ ok: false, reason: 'parse_error' });
  });

  it('LLM が REASON 行を返さないと parse_error', async () => {
    setupBiblio('owner--repo');
    mockLlm.mockResolvedValue('CATEGORY: biblio-dev\n(理由なし)');
    const result = await categorize({ biblioName: 'owner--repo' }, { quarantineRoot: TEST_DIR });
    expect(result).toMatchObject({ ok: false, reason: 'parse_error' });
  });

  it('LLM 呼び出しが throw すると llm_error に倒す', async () => {
    setupBiblio('owner--repo');
    mockLlm.mockRejectedValue(new Error('vertex-client: rawPredict 403 Forbidden — project not enabled'));
    const result = await categorize({ biblioName: 'owner--repo' }, { quarantineRoot: TEST_DIR });
    expect(result).toMatchObject({
      ok: false,
      reason: 'llm_error',
      detail: expect.stringContaining('rawPredict 403'),
    });
  });

  it('本文が一切ない (plugin.json 不在 / README 不在 / SKILL.md 不在) で parse_error', async () => {
    // 空 dir を作るだけ
    fs.mkdirSync(path.join(TEST_DIR, 'owner--empty'), { recursive: true });
    const result = await categorize({ biblioName: 'owner--empty' }, { quarantineRoot: TEST_DIR });
    expect(result).toMatchObject({ ok: false, reason: 'parse_error' });
    // 入力 0 = LLM 呼ばない (= 余計なコスト回避)
    expect(mockLlm).not.toHaveBeenCalled();
  });
});
