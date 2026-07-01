/**
 * config-tool のユニットテスト (M4-B Phase 4)。
 *
 * shelve-tool.test.ts と同流儀。`BIBLIO_SETTING_KEYS` allowlist Zod enum 検証 +
 * `validateValueForKey` の value 意味検証 + `setBiblioSetting` 委譲を検証。
 * `mockToolContext` / `resetLogMocks` は `test-helpers.ts` 参照。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { setBiblioSettingMock } = vi.hoisted(() => ({
  setBiblioSettingMock: vi.fn(),
}));

vi.mock('../../db/biblio-settings.js', () => ({
  setBiblioSetting: (...args: unknown[]) => setBiblioSettingMock(...args),
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { updateConfigTool, type ConfigUpdateResult } from './config-tool.js';
import { log } from '../../log.js';
import { mockToolContext, resetLogMocks } from './test-helpers.js';

beforeEach(() => {
  setBiblioSettingMock.mockReset();
  resetLogMocks(log);
});

describe('updateConfigTool — name / description', () => {
  it('tool 名と description が LLM 公開向けに設定されている', () => {
    expect(updateConfigTool.name).toBe('update_config');
    expect(updateConfigTool.description).toContain('Update a biblio setting');
    expect(updateConfigTool.description).toContain('ACQUIRE_SKILL_THRESHOLD');
  });
});

describe('updateConfigTool — 正常系 (setBiblioSetting 委譲)', () => {
  it('valid key/value で setBiblioSetting() を呼び ok:true を返す', async () => {
    setBiblioSettingMock.mockImplementation(() => undefined);
    const result = await updateConfigTool.runAsync({
      args: { key: 'ACQUIRE_SKILL_THRESHOLD', value: '25' },
      toolContext: mockToolContext({ invocationId: 'inv-abc', sessionId: 'sess-xyz' }),
    });
    expect(setBiblioSettingMock).toHaveBeenCalledWith('ACQUIRE_SKILL_THRESHOLD', '25');
    expect(result).toEqual({ ok: true, key: 'ACQUIRE_SKILL_THRESHOLD', value: '25' });
  });

  it('構造化ログ event=adk.tool.config.applied が 1 件出る', async () => {
    setBiblioSettingMock.mockImplementation(() => undefined);
    await updateConfigTool.runAsync({
      args: { key: 'ACQUIRE_SKILL_THRESHOLD', value: '10' },
      toolContext: mockToolContext(),
    });
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining('update_config applied'),
      expect.objectContaining({
        event: 'adk.tool.config.applied',
        key: 'ACQUIRE_SKILL_THRESHOLD',
        value: '10',
      }),
    );
  });
});

describe('updateConfigTool — Zod schema 検証 (key allowlist)', () => {
  it('allowlist 外の key ("BAD_KEY") は Zod enum reject で throw + setBiblioSetting() 未呼出', async () => {
    await expect(
      updateConfigTool.runAsync({
        args: { key: 'BAD_KEY' as never, value: '1' },
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow();
    expect(setBiblioSettingMock).not.toHaveBeenCalled();
  });

  it('空 value は Zod min(1) reject', async () => {
    await expect(
      updateConfigTool.runAsync({
        args: { key: 'ACQUIRE_SKILL_THRESHOLD', value: '' },
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow();
    expect(setBiblioSettingMock).not.toHaveBeenCalled();
  });
});

describe('updateConfigTool — validateValueForKey (意味的検証)', () => {
  it('ACQUIRE_SKILL_THRESHOLD に非数値 ("abc") → ok:false + invalid_value + setBiblioSetting() 未呼出', async () => {
    const result = (await updateConfigTool.runAsync({
      args: { key: 'ACQUIRE_SKILL_THRESHOLD', value: 'abc' },
      toolContext: mockToolContext(),
    })) as ConfigUpdateResult;
    expect(result).toMatchObject({ ok: false, reason: 'invalid_value' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain('ACQUIRE_SKILL_THRESHOLD');
    }
    expect(setBiblioSettingMock).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('invalid value for key'),
      expect.objectContaining({
        event: 'adk.tool.config.invalid_value',
      }),
    );
  });

  it('ACQUIRE_SKILL_THRESHOLD に 0 → ok:false + invalid_value', async () => {
    const result = await updateConfigTool.runAsync({
      args: { key: 'ACQUIRE_SKILL_THRESHOLD', value: '0' },
      toolContext: mockToolContext(),
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_value' });
    expect(setBiblioSettingMock).not.toHaveBeenCalled();
  });

  it('ACQUIRE_SKILL_THRESHOLD に負数 ("-5") → ok:false + invalid_value', async () => {
    const result = await updateConfigTool.runAsync({
      args: { key: 'ACQUIRE_SKILL_THRESHOLD', value: '-5' },
      toolContext: mockToolContext(),
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_value' });
    expect(setBiblioSettingMock).not.toHaveBeenCalled();
  });
});

describe('updateConfigTool — 異常系 (setBiblioSetting throw 経路)', () => {
  it('setBiblioSetting() が throw したら tool もそのまま throw する', async () => {
    setBiblioSettingMock.mockImplementation(() => {
      throw new Error('SQLITE_BUSY');
    });
    await expect(
      updateConfigTool.runAsync({
        args: { key: 'ACQUIRE_SKILL_THRESHOLD', value: '15' },
        toolContext: mockToolContext(),
      }),
    ).rejects.toThrow(/SQLITE_BUSY/);
  });
});
