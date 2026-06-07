/**
 * Claude provider container config — registered whenever host-side env
 * passthrough is needed. Two mutually-exclusive modes:
 *
 *  1. Vertex-via-OneCLI (biblio-claw, Phase 1): set when
 *     ANTHROPIC_VERTEX_PROJECT_ID is present in .env. claude-code talks
 *     Vertex's rawPredict format directly, but we suppress its google-auth
 *     path (CLAUDE_CODE_SKIP_VERTEX_AUTH=1) and hand it a dummy
 *     ANTHROPIC_AUTH_TOKEN. The container's HTTPS_PROXY points at the OneCLI
 *     gateway, which MITM-injects a real ADC Bearer for
 *     aiplatform.googleapis.com (see scripts/onecli-vertex-secret.sh). The
 *     real credential never enters the container.
 *
 *  2. Custom Anthropic-compatible endpoint: set when ANTHROPIC_BASE_URL is
 *     present (the original NanoClaw setup path). Same dummy-token trick,
 *     OneCLI rewrites Authorization on the wire.
 *
 * Standard installs hitting api.anthropic.com need neither and return {}.
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('claude', () => {
  const dotenv = readEnvFile(['ANTHROPIC_BASE_URL', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION']);
  const env: Record<string, string> = {};

  if (dotenv.ANTHROPIC_VERTEX_PROJECT_ID) {
    // Vertex mode. CLAUDE_CODE_USE_VERTEX is detected by *presence*, not value
    // (Issue #2804) — so we only emit this whole group in Vertex mode and never
    // set it to "0". To fall back to direct ADC, drop ANTHROPIC_VERTEX_PROJECT_ID
    // from .env so none of these vars are emitted.
    env.CLAUDE_CODE_USE_VERTEX = '1';
    // Suppress claude-code's built-in google-auth so the dummy token survives
    // for OneCLI to overwrite (the previously-untrodden region PoC-5 sidestepped).
    env.CLAUDE_CODE_SKIP_VERTEX_AUTH = '1';
    env.ANTHROPIC_VERTEX_PROJECT_ID = dotenv.ANTHROPIC_VERTEX_PROJECT_ID;
    env.CLOUD_ML_REGION = dotenv.CLOUD_ML_REGION || 'global';
    // Dummy bearer for OneCLI to MITM-replace with a real ADC token.
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
    // Must be empty: a non-empty X-Api-Key (priority 3) would shadow
    // ANTHROPIC_AUTH_TOKEN (priority 2) and break the Bearer path.
    env.ANTHROPIC_API_KEY = '';
    // Without this Vertex rejects claude-code's beta headers with HTTP 400.
    env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
  } else if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  }

  return { env };
});
