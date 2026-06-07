/**
 * DSN (data-source location) provider contract.
 *
 * Abstracts *where* the central DB and per-session DBs live so the app body
 * never hard-codes a filesystem layout. Phase 1 ships a local-filesystem
 * implementation; Phase 2 points at a GKE persistent volume by adding one class
 * and flipping `DSN_PROVIDER` — no caller changes.
 *
 * Scope is path/location resolution ONLY. The DB engine stays better-sqlite3
 * and the storage stays SQLite-on-disk across both phases (PRD §Constraints:
 * PostgreSQL/Cloud SQL is explicitly out of scope; persistence is PVC + SQLite).
 * This adapter resolves paths; it does not switch the engine or the storage
 * model.
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
