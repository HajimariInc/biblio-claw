/**
 * Tests for the claude provider container config (Vertex / BASE_URL branches).
 *
 * The provider self-registers on import into a module-level singleton registry
 * (provider-container-registry.ts), which throws on double-register. We use
 * `vi.resetModules()` + dynamic import per test to get a fresh registry +
 * fresh claude.ts registration each time, which lets us swap the .env values
 * via a hoisted mock without state leakage.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readEnvFile: vi.fn(),
}));

vi.mock('../env.js', () => ({
  readEnvFile: mocks.readEnvFile,
}));

async function loadClaudeConfig() {
  vi.resetModules();
  const reg = await import('./provider-container-registry.js');
  await import('./claude.js'); // self-registers into the fresh registry
  const fn = reg.getProviderContainerConfig('claude');
  if (!fn) throw new Error('claude provider config not registered');
  return fn({ sessionDir: '', agentGroupId: 'ag-test', hostEnv: {} });
}

describe('claude provider container config', () => {
  beforeEach(() => {
    mocks.readEnvFile.mockReset();
  });

  describe('Vertex mode (ANTHROPIC_VERTEX_PROJECT_ID present)', () => {
    it('emits the full 7-key Vertex env group with correct values', async () => {
      mocks.readEnvFile.mockReturnValue({
        ANTHROPIC_VERTEX_PROJECT_ID: 'my-gcp-project',
        CLOUD_ML_REGION: 'us-central1',
      });

      const { env } = await loadClaudeConfig();

      expect(env).toEqual({
        CLAUDE_CODE_USE_VERTEX: '1',
        CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
        ANTHROPIC_VERTEX_PROJECT_ID: 'my-gcp-project',
        CLOUD_ML_REGION: 'us-central1',
        ANTHROPIC_AUTH_TOKEN: 'placeholder',
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
      });
    });

    it('forces ANTHROPIC_API_KEY to the empty string (load-bearing: non-empty X-Api-Key would shadow AUTH_TOKEN, 401-ing all Vertex calls)', async () => {
      mocks.readEnvFile.mockReturnValue({
        ANTHROPIC_VERTEX_PROJECT_ID: 'p',
      });

      const { env } = await loadClaudeConfig();

      expect(env).toHaveProperty('ANTHROPIC_API_KEY');
      expect(env!.ANTHROPIC_API_KEY).toBe('');
    });

    it('falls back CLOUD_ML_REGION to "global" when unset', async () => {
      mocks.readEnvFile.mockReturnValue({
        ANTHROPIC_VERTEX_PROJECT_ID: 'p',
      });

      const { env } = await loadClaudeConfig();

      expect(env!.CLOUD_ML_REGION).toBe('global');
    });

    it('does not leak ANTHROPIC_BASE_URL into the Vertex env group', async () => {
      mocks.readEnvFile.mockReturnValue({
        ANTHROPIC_VERTEX_PROJECT_ID: 'p',
        ANTHROPIC_BASE_URL: 'https://leak.example.com',
      });

      const { env } = await loadClaudeConfig();

      expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    });
  });

  describe('BASE_URL mode (legacy NanoClaw, ANTHROPIC_BASE_URL only)', () => {
    it('emits only ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (back-compat)', async () => {
      mocks.readEnvFile.mockReturnValue({
        ANTHROPIC_BASE_URL: 'https://proxy.example.com',
      });

      const { env } = await loadClaudeConfig();

      expect(env).toEqual({
        ANTHROPIC_BASE_URL: 'https://proxy.example.com',
        ANTHROPIC_AUTH_TOKEN: 'placeholder',
      });
      // Critical: Vertex-mode keys must not leak in.
      expect(env).not.toHaveProperty('CLAUDE_CODE_USE_VERTEX');
      expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    });
  });

  describe('Neither mode (standard install)', () => {
    it('returns an empty env when no .env keys are present', async () => {
      mocks.readEnvFile.mockReturnValue({});

      const { env } = await loadClaudeConfig();

      expect(env).toEqual({});
    });
  });
});
