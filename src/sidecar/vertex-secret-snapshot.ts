/**
 * issue #136 A2: OneCLI 内の Vertex secret メタデータを 30s 周期で snapshot し、
 * `vertex.onecli.secret_snapshot` event として emit + module-level state に保持する。
 *
 * OneCLI の value 自体は AES-256-GCM で暗号化保管され GET で masked (返らない)。
 * よって観察できるのは id / hostPattern / (updated_at フィールド存在すれば) のみ。
 * これでも「secret が期待通り存在するか」「id が rotator PATCH で保持されているか」
 * (= 意図せず削除 + 再作成されていないか) を追跡できる。
 *
 * 401 発生時 (`AnthropicVertexLlm.ts` の catch、`vertex-client.ts` の !res.ok 分岐)
 * に本 module の `getLastVertexSecretSnapshot()` を forensic dump に組み込む。
 *
 * 写経元: src/sidecar/ca-secret-sync.ts (SchedulerProvider 経由の周期 loop 経路)。
 * 周期は snapshot の即応性のため 60s → 30s に短縮 (issue #136 の DoD「T 時点で
 * OneCLI secret に入っていた token 状態を特定」)。
 *
 * silent failure 撲滅:
 *   - fetch 失敗 (network / non-2xx / throw) は log.warn + lastSnapshot は更新しない
 *     (= 直近成功時の state を保持)
 *   - Vertex secret 名が not found の場合は lastSnapshot.found = false で state を明示
 *     (= 「fetch は成功したが secret 消失」を可観測)
 */

import { getSchedulerProvider, type SchedulerProvider } from '../adapters/scheduler/index.js';
import { log } from '../log.js';

const SNAPSHOT_INTERVAL_MS = 30_000;
const VERTEX_SECRET_NAME = process.env.VERTEX_SECRET_NAME ?? 'biblio-claw-vertex';
const ONECLI_URL = process.env.ONECLI_URL ?? 'http://localhost:10254';

export type VertexSecretSnapshot = {
  observed_at_epoch: number;
  secret_id: string;
  host_pattern: string;
  /** OneCLI 応答に updated_at フィールドが含まれれば、なければ null (degraded fallback)。 */
  updated_at_epoch: number | null;
  /** secret が OneCLI 内で見つかったかどうか (name match)。false = 消失検知。 */
  found: boolean;
};

let lastSnapshot: VertexSecretSnapshot | null = null;
let scheduler: SchedulerProvider | null = null;

export function getLastVertexSecretSnapshot(): VertexSecretSnapshot | null {
  return lastSnapshot;
}

/**
 * OneCLI /v1/secrets から Vertex secret のメタデータを 1 回取得し lastSnapshot を更新。
 * throw しない設計 (catch で log.warn) = SchedulerProvider の consecutiveFailures には
 * カウントされないため、代わりに `found=false` state を watch する Cloud Monitoring
 * alert (Step 8) で「secret 消失」を検知する。
 */
export async function snapshotOnce(): Promise<void> {
  try {
    const res = await fetch(`${ONECLI_URL}/v1/secrets`, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      log.warn('vertex-secret-snapshot: OneCLI GET /v1/secrets non-2xx', {
        event: 'vertex.onecli.secret_snapshot',
        outcome: 'failure',
        status: res.status,
      });
      // snapshot は更新しない (直近成功時の state を保持、silent 化しない)
      return;
    }
    const list = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(list)) {
      log.warn('vertex-secret-snapshot: OneCLI /v1/secrets returned non-array', {
        event: 'vertex.onecli.secret_snapshot',
        outcome: 'parse_failure',
      });
      return;
    }
    const found = list.find((s) => s?.name === VERTEX_SECRET_NAME);
    const nowEpoch = Math.floor(Date.now() / 1000);
    if (!found) {
      lastSnapshot = {
        observed_at_epoch: nowEpoch,
        secret_id: '',
        host_pattern: '',
        updated_at_epoch: null,
        found: false,
      };
      log.warn('vertex-secret-snapshot: Vertex secret not found in OneCLI', {
        event: 'vertex.onecli.secret_snapshot',
        outcome: 'not_found',
        secret_name: VERTEX_SECRET_NAME,
      });
      return;
    }
    // updated_at フィールドの有無は OneCLI 実装依存 (v1.30.0 の shape 未確認、
    // 存在すれば ISO 8601 or unix epoch を parse、なければ null で degraded fallback)。
    const updatedAtRaw = found.updated_at ?? found.updatedAt;
    let updatedAtEpoch: number | null = null;
    if (typeof updatedAtRaw === 'string') {
      const parsed = Math.floor(Date.parse(updatedAtRaw) / 1000);
      updatedAtEpoch = Number.isFinite(parsed) ? parsed : null;
    } else if (typeof updatedAtRaw === 'number') {
      updatedAtEpoch = updatedAtRaw;
    }
    lastSnapshot = {
      observed_at_epoch: nowEpoch,
      secret_id: typeof found.id === 'string' ? found.id : String(found.id ?? ''),
      host_pattern: typeof found.hostPattern === 'string' ? found.hostPattern : '',
      updated_at_epoch: updatedAtEpoch,
      found: true,
    };
    log.info('vertex-secret-snapshot: OneCLI secret observed', {
      event: 'vertex.onecli.secret_snapshot',
      outcome: 'success',
      secret_id: lastSnapshot.secret_id,
      host_pattern: lastSnapshot.host_pattern,
      updated_at_epoch: lastSnapshot.updated_at_epoch,
    });
  } catch (err) {
    log.warn('vertex-secret-snapshot: OneCLI fetch threw', {
      event: 'vertex.onecli.secret_snapshot',
      outcome: 'failure',
      err: err instanceof Error ? err.message : String(err),
    });
    // silent 化しない = warn は残す、lastSnapshot は更新しない (直近成功時の state を保持)
  }
}

export function startVertexSecretSnapshot(): void {
  if (scheduler) {
    log.warn('startVertexSecretSnapshot called twice — ignoring second call');
    return;
  }
  scheduler = getSchedulerProvider(SNAPSHOT_INTERVAL_MS);
  log.info('vertex-secret-snapshot started', {
    interval_ms: SNAPSHOT_INTERVAL_MS,
    secret_name: VERTEX_SECRET_NAME,
    onecli_url: ONECLI_URL,
  });
  scheduler.start(() => snapshotOnce());
}

export function stopVertexSecretSnapshot(): void {
  if (scheduler) {
    scheduler.stop();
    scheduler = null;
    lastSnapshot = null;
  }
}
