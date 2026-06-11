import path from 'path';

import type { DsnProvider } from './types.js';

/**
 * GKE 環境用 DsnProvider。アプリ image は Phase 1 と同一で、PVC mountPath が
 * `/data` に来る前提でパスを解決する (env `DATA_DIR` で上書き可)。
 *
 * LocalDsnProvider が config.ts の DATA_DIR 定数 (フォールバック = PROJECT_ROOT/data)
 * を経由するのに対し、GkeDsnProvider は constructor で env を直接読み `/data` を
 * フォールバックとする。両者とも env を読む点では同じだが、フォールバック値が異なる:
 * GKE では PROJECT_ROOT/data はコンテナ CWD 由来で意味を持たず、PVC mountPath の
 * 慣例値 `/data` が固定の既定値となるため。session base directory 名は
 * `v2-sessions` で LocalDsnProvider と揃え、アプリ本体が両環境で共通の path 算法で
 * 動くようにしておく。
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
