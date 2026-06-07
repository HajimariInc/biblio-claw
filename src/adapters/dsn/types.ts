/**
 * DSN (data-source location) provider contract.
 *
 * Abstracts *where* the central DB and per-session DBs live so the app body
 * never hard-codes a filesystem layout. Phase 1 ships a local-filesystem
 * implementation; Phase 2 swaps in a GKE/Cloud SQL variant by adding one class
 * and flipping `DSN_PROVIDER` — no caller changes.
 *
 * Scope is path/location resolution ONLY. The DB engine stays better-sqlite3
 * (PRD §Constraints); this adapter does not switch SQLite for another engine.
 */
export interface DsnProvider {
  readonly name: string;
  /** Absolute path to the central DB (`<DATA_DIR>/v2.db` in local). */
  centralDbPath(): string;
  /** Root directory holding all per-session DBs (`<DATA_DIR>/v2-sessions`). */
  sessionsBaseDir(): string;
  /** Directory for one session: `<sessionsBaseDir>/<agentGroupId>/<sessionId>/`. */
  sessionDir(agentGroupId: string, sessionId: string): string;
  /** Path to the host-owned inbound DB for a session. */
  inboundDbPath(agentGroupId: string, sessionId: string): string;
  /** Path to the container-owned outbound DB for a session. */
  outboundDbPath(agentGroupId: string, sessionId: string): string;
}
