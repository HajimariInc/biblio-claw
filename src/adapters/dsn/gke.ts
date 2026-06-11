import path from 'path';

import type { DsnProvider } from './types.js';

/**
 * GKE 環境用 DsnProvider。アプリ image は Phase 1 と同一で、PVC mountPath が
 * `/data` に来る前提でパスを解決する (env `DATA_DIR` で上書き可)。
 *
 * LocalDsnProvider と違って `config.DATA_DIR` を経由しない理由: GKE では
 * DATA_DIR が PVC mountPath 由来で、開発時の `<PROJECT_ROOT>/data` フォールバックは
 * 意味を持たないため、env を直接読んで `/data` を既定値とする。session base
 * directory 名は `v2-sessions` で LocalDsnProvider と揃え、アプリ本体が両環境で
 * 共通の path 算法で動くようにしておく。
 */
export class GkeDsnProvider implements DsnProvider {
  readonly name = 'gke';
  private readonly root: string;

  constructor() {
    this.root = process.env.DATA_DIR ?? '/data';
  }

  centralDbPath(): string {
    return path.join(this.root, 'v2.db');
  }

  sessionsBaseDir(): string {
    return path.join(this.root, 'v2-sessions');
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
