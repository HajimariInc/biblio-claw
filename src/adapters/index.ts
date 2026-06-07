/**
 * Environment-difference adapters barrel.
 *
 * Three factories isolate the environment-dependent choice points so the app
 * body never hard-codes secret retrieval, scheduling, or DB location:
 *   - getDsnProvider()       — DB / session-DB location (env: DSN_PROVIDER)
 *   - getSchedulerProvider() — periodic tick source     (env: SCHEDULER_PROVIDER)
 *   - getSecretProvider()    — credentials / approvals  (env: SECRET_PROVIDER)
 *
 * Phase 2 (GKE/GCP) adds one implementation per adapter and flips the env —
 * the app body stays unchanged.
 */
export { getDsnProvider, type DsnProvider } from './dsn/index.js';
export { getSchedulerProvider, type SchedulerProvider } from './scheduler/index.js';
export { getSecretProvider, type ApprovalCallback, type SecretProvider } from './secret/index.js';
