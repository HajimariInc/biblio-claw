import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readEnvFile } from './env.js';

// log は debug を呼ぶだけなので mock してテスト出力を汚さない
vi.mock('./log.js', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('readEnvFile', () => {
  let tempDir: string;
  let originalCwd: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblio-env-test-'));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads values from .env file when present', () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'FOO=from-file\nBAR=also-file\n');
    const result = readEnvFile(['FOO', 'BAR']);
    expect(result).toEqual({ FOO: 'from-file', BAR: 'also-file' });
  });

  it('falls back to process.env when .env is missing', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-from-env';
    process.env.SLACK_APP_TOKEN = 'xapp-from-env';
    const result = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    expect(result).toEqual({
      SLACK_BOT_TOKEN: 'xoxb-from-env',
      SLACK_APP_TOKEN: 'xapp-from-env',
    });
  });

  it('falls back to process.env for keys not in .env', () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'FOO=from-file\n');
    process.env.BAR = 'from-env';
    const result = readEnvFile(['FOO', 'BAR']);
    expect(result).toEqual({ FOO: 'from-file', BAR: 'from-env' });
  });

  it('prefers .env over process.env when both are set', () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'FOO=from-file\n');
    process.env.FOO = 'from-env';
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: 'from-file' });
  });

  it('returns empty object when neither source has the keys', () => {
    delete process.env.MISSING_KEY;
    const result = readEnvFile(['MISSING_KEY']);
    expect(result).toEqual({});
  });

  it('strips matching surrounding quotes from .env values', () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'QUOTED="quoted-value"\nSQUOTED=\'single-value\'\n');
    const result = readEnvFile(['QUOTED', 'SQUOTED']);
    expect(result).toEqual({ QUOTED: 'quoted-value', SQUOTED: 'single-value' });
  });

  it('skips comments and blank lines', () => {
    fs.writeFileSync(path.join(tempDir, '.env'), '# header\n\nFOO=ok\n# trailing\n');
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: 'ok' });
  });

  it('ignores process.env values that are empty strings', () => {
    process.env.EMPTY = '';
    const result = readEnvFile(['EMPTY']);
    expect(result).toEqual({});
  });

  it('honors `.env` empty value to suppress process.env fallback', () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'FOO=\n');
    process.env.FOO = 'from-env';
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: '' });
  });
});
