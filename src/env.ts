import fs from 'fs';
import path from 'path';
import { log } from './log.js';

/**
 * Resolve values for the requested keys from `<cwd>/.env` (preferred) and
 * fall back to `process.env` for keys not populated from the file.
 *
 * The file is read each call (no caching) and values are NOT loaded
 * into `process.env`, so secrets stay scoped to the caller and don't
 * leak to child processes. The fallback exists so the same call sites
 * work in containerised environments (GKE Pod / docker run) where the
 * project-local `.env` is absent and values arrive via env vars
 * injected by the runtime (envFrom secretRef, --env-file, etc.).
 *
 * Key presence in `.env` wins over `process.env` even when the file
 * value is empty — i.e. writing `FOO=` in `.env` deliberately suppresses
 * a `process.env.FOO` set elsewhere. The `process.env` fallback path
 * still skips empty strings since callers (Slack token etc.) treat
 * empty as "not configured".
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  let content: string | null = null;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      log.debug('.env file not found, falling back to process.env', { envFile });
    } else {
      log.warn('.env file unreadable, falling back to process.env', { envFile, code, err });
    }
  }

  if (content !== null) {
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (!wanted.has(key)) continue;
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }

  for (const key of keys) {
    if (result[key] !== undefined) continue;
    const fromEnv = process.env[key];
    if (fromEnv && fromEnv.length > 0) {
      result[key] = fromEnv;
    }
  }

  return result;
}
