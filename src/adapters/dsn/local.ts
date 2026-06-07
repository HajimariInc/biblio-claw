import path from 'path';

import { DATA_DIR } from '../../config.js';
import type { DsnProvider } from './types.js';

/**
 * Local-filesystem DSN provider. Resolves all DB paths under the data root
 * (`config.DATA_DIR`, which honours the `DATA_DIR` env override). Mirrors the
 * original path algebra that lived in `session-manager.ts` so existing on-disk
 * layouts are unchanged.
 */
export class LocalDsnProvider implements DsnProvider {
  readonly name = 'local';

  centralDbPath(): string {
    return path.join(DATA_DIR, 'v2.db');
  }

  sessionsBaseDir(): string {
    return path.join(DATA_DIR, 'v2-sessions');
  }

  sessionDir(agentGroupId: string, sessionId: string): string {
    return path.join(this.sessionsBaseDir(), agentGroupId, sessionId);
  }

  inboundDbPath(agentGroupId: string, sessionId: string): string {
    return path.join(this.sessionDir(agentGroupId, sessionId), 'inbound.db');
  }

  outboundDbPath(agentGroupId: string, sessionId: string): string {
    return path.join(this.sessionDir(agentGroupId, sessionId), 'outbound.db');
  }
}
