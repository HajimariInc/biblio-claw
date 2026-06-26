import { describe, it, expect } from 'bun:test';

import { ClaudeProvider } from './claude.js';

// isSessionInvalid drives continuation invalidation. When it returns true the
// poll-loop drops the resumed session id and starts a fresh one on the next
// patron message — that's the auto-recovery hook for issue #49 (Vertex 401
// ACCESS_TOKEN_EXPIRED retry loops where the SDK's internal auth state has
// stuck against an expired ADC token).
describe('ClaudeProvider.isSessionInvalid', () => {
  const provider = new ClaudeProvider();

  it('returns true for missing conversation', () => {
    expect(
      provider.isSessionInvalid(new Error('no conversation found: abc-123')),
    ).toBe(true);
  });

  it('returns true for missing transcript .jsonl', () => {
    expect(
      provider.isSessionInvalid(
        new Error('ENOENT: no such file or directory, open /tmp/xxx.jsonl'),
      ),
    ).toBe(true);
  });

  it('returns true for session not found', () => {
    expect(
      provider.isSessionInvalid(new Error('session abc not found')),
    ).toBe(true);
  });

  // issue #49 — Vertex 401 ACCESS_TOKEN_EXPIRED. Real wire-format error body
  // captured from agent Pod logs (2026-06-25).
  it('returns true for Vertex 401 ACCESS_TOKEN_EXPIRED', () => {
    const err = new Error(
      'API Error: 401 {"error":{"code":401,"message":"Request had invalid authentication credentials. Expected OAuth 2 access token","status":"UNAUTHENTICATED","details":[{"reason":"ACCESS_TOKEN_EXPIRED","domain":"googleapis.com"}]}}',
    );
    expect(provider.isSessionInvalid(err)).toBe(true);
  });

  // issue #49 — Google API canonical phrasing for auth failure (used by
  // Vertex even when the body shape varies). Anchored with `401.*` so the
  // raw HTTP status must precede the phrase.
  it('returns true for 401 with "invalid authentication credentials"', () => {
    expect(
      provider.isSessionInvalid(
        new Error('API Error: 401 Request had invalid authentication credentials.'),
      ),
    ).toBe(true);
  });

  // Guard against over-broad 401 match: a bare 401 (e.g. transient rate-limit
  // variants) must NOT drop continuation, only the auth-typed ones do.
  it('returns false for bare 401 without ACCESS_TOKEN_EXPIRED', () => {
    expect(
      provider.isSessionInvalid(new Error('HTTP 401 rate limit exceeded')),
    ).toBe(false);
  });

  // Design boundary: ACCESS_TOKEN_EXPIRED without a preceding 401 must
  // not drop continuation. Documents intent in case a future PR is tempted
  // to relax the anchor.
  it('returns false for ACCESS_TOKEN_EXPIRED without preceding 401', () => {
    expect(
      provider.isSessionInvalid(
        new Error('{"reason":"ACCESS_TOKEN_EXPIRED","domain":"googleapis.com"}'),
      ),
    ).toBe(false);
  });

  // Design boundary: "invalid authentication credentials" without 401
  // must not drop continuation. Protects against future MCP tools (Drive,
  // BigQuery, etc.) that surface this canonical Google OAuth phrasing in
  // non-Vertex contexts.
  it('returns false for "invalid authentication credentials" without 401', () => {
    expect(
      provider.isSessionInvalid(
        new Error('MCP tool error: invalid authentication credentials from drive.googleapis.com'),
      ),
    ).toBe(false);
  });

  it('returns false for unrelated errors', () => {
    expect(
      provider.isSessionInvalid(new Error('500 internal server error')),
    ).toBe(false);
    expect(
      provider.isSessionInvalid(new Error('rate limit exceeded')),
    ).toBe(false);
  });

  it('handles non-Error throwables via String()', () => {
    expect(provider.isSessionInvalid('no conversation found')).toBe(true);
    expect(provider.isSessionInvalid(null)).toBe(false);
  });
});
