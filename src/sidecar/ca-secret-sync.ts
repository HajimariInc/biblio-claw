/**
 * ca-secret-sync — OneCLI sidecar が emptyDir 経由で生成する root CA bundle を
 * 読み、agent Pod 用 K8s Secret `biblio-onecli-ca` に自動 upsert する (M2 PRD A
 * Phase 3、`TODO(phase-2.6)` 解消)。
 *
 * 配置と起動:
 *   orchestrator Pod 内の本体 container にバンドルされ、`DSN_PROVIDER === 'gke'`
 *   の時のみ `src/index.ts` から `startCaSecretSync()` で起動される。local docker
 *   compose 経路 (DSN_PROVIDER=local) では `scripts/onecli-*-secret.sh` 手叩き経路
 *   を維持するため起動しない。
 *
 * 読み元:
 *   OneCLI sidecar が `/app/data/gateway/ca.pem` を生成する (PoC-5 写経)。同 Pod 内
 *   の本体 container は同じ emptyDir を `/etc/ssl/certs/onecli/ca.pem` で readOnly
 *   mount し、本モジュールはここから読む。
 *
 * 書き先:
 *   K8s Secret `biblio-onecli-ca` (namespace `biblio-claw`)。agent Pod 側の
 *   `K8sJobContainerRuntimeProvider.translateSpec` は本 Secret の `onecli-proxy-ca.pem`
 *   と `onecli-combined-ca.pem` の 2 key を `/etc/ssl/certs/onecli/` に mount する
 *   ことを前提に組まれている (Phase 2.5 で確定、本 Phase でも温存)。そこで同じ
 *   ca.pem 内容を 2 key 両方に書き込む (OneCLI gateway root CA = combined と同等
 *   の使い方を agent 側がしているため、1 ファイル内容を 2 key に流用しても TLS
 *   verify は通る)。
 *
 * 周期:
 *   起動時に 1 回 + その後 60s 周期で sweep。差分が無ければ no-op。
 *
 * 失敗扱い:
 *   - source file ENOENT: silent retry。OneCLI sidecar が CA を生成するまで数秒
 *     〜数十秒の窓が空く。`ENOENT_WARN_THRESHOLD` (= 60s × 5 = 5 分) を超えたら
 *     1 回だけ warn (= sidecar が起動失敗している兆候)。
 *   - K8s API 失敗 (5xx / network): log.warn + 次 tick で retry。Pod 全体を倒さ
 *     ない (silent failure 排除のため warn は出すが、process.exit はしない)。
 *   - K8s API 409 Conflict: replicas=1 なので発生しないはずだが、出たら warn +
 *     retry。
 */
import { promises as fs } from 'fs';

import * as k8s from '@kubernetes/client-node';

import { getSchedulerProvider, type SchedulerProvider } from '../adapters/scheduler/index.js';
import { log } from '../log.js';

const DEFAULT_NAMESPACE = 'biblio-claw';
const DEFAULT_SECRET_NAME = 'biblio-onecli-ca';
const DEFAULT_SOURCE_PATH = '/etc/ssl/certs/onecli/ca.pem';

/**
 * agent Pod 側 (`src/adapters/container/k8s.ts:357-371` + 441-443) が期待する
 * Secret data key 名。1 ファイル内容を両 key に流用する (= OneCLI gateway root CA
 * を proxy / combined 共通の trust anchor として扱う)。
 */
const SECRET_KEY_PROXY = 'onecli-proxy-ca.pem';
const SECRET_KEY_COMBINED = 'onecli-combined-ca.pem';

/**
 * ENOENT が連続して何 tick 続いたら warn を 1 回出すか。60s × 5 = 5 分。
 * sidecar が起動失敗 / OneCLI の CA 生成パスが変わった等の兆候を可視化する。
 */
const ENOENT_WARN_THRESHOLD = 5;

interface Config {
  namespace: string;
  secretName: string;
  sourcePath: string;
}

function loadConfig(): Config {
  return {
    namespace: process.env.BIBLIO_NAMESPACE || DEFAULT_NAMESPACE,
    secretName: process.env.ONECLI_CA_SECRET_NAME || DEFAULT_SECRET_NAME,
    sourcePath: process.env.ONECLI_CA_SOURCE_PATH || DEFAULT_SOURCE_PATH,
  };
}

interface Runtime {
  coreApi: k8s.CoreV1Api;
  config: Config;
  scheduler: SchedulerProvider;
  enoentStreak: number;
  enoentWarned: boolean;
}

let runtime: Runtime | null = null;

/**
 * orchestrator 起動時に呼ぶ。in-cluster KubeConfig + CoreV1Api を初期化し、
 * 即座に 1 回 sweep を走らせてから scheduler に 60s 周期を回させる。
 * `src/index.ts` から `DSN_PROVIDER === 'gke'` の時のみ呼ばれる。
 */
export async function startCaSecretSync(): Promise<void> {
  if (runtime) {
    log.warn('startCaSecretSync called twice — ignoring second call');
    return;
  }

  const config = loadConfig();
  const kc = new k8s.KubeConfig();
  kc.loadFromCluster();
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);

  const scheduler = getSchedulerProvider();
  runtime = { coreApi, config, scheduler, enoentStreak: 0, enoentWarned: false };

  log.info('ca-secret-sync started', {
    namespace: config.namespace,
    secret: config.secretName,
    source: config.sourcePath,
  });

  // Scheduler の `start()` は内部で 1 回目を即時実行 + その後 60s 間隔。
  // tick が throw しても scheduler が swallow + retry するので呼び出し側は
  // 例外を意識せず良い (host-sweep と同じ流儀)。
  scheduler.start(() => syncOnce(runtime!));
}

/** Graceful shutdown 経路。`src/index.ts` の shutdown callback から呼ばれる。 */
export function stopCaSecretSync(): void {
  if (!runtime) return;
  runtime.scheduler.stop();
  runtime = null;
}

/**
 * 1 周期分: source file を読み、K8s Secret と比較、必要なら upsert する。
 * テスト用に export。
 */
export async function syncOnce(rt: Runtime): Promise<void> {
  const ca = await readCaFile(rt);
  if (ca === null) return; // ENOENT: 次 tick で retry

  const desiredData = encodeSecretData(ca);
  const existing = await readSecret(rt);

  if (existing === 'not-found') {
    await createSecret(rt, desiredData);
    return;
  }
  if (existing === 'error') {
    // readSecret が API エラーを log.warn 済み、次 tick で retry
    return;
  }

  if (sameSecretData(existing.data ?? {}, desiredData)) {
    return; // no-op (同内容)
  }

  await replaceSecret(rt, existing, desiredData);
}

async function readCaFile(rt: Runtime): Promise<string | null> {
  try {
    const buf = await fs.readFile(rt.config.sourcePath);
    if (rt.enoentStreak > 0) {
      log.info('ca-secret-sync source file appeared', {
        source: rt.config.sourcePath,
        streak: rt.enoentStreak,
      });
    }
    rt.enoentStreak = 0;
    rt.enoentWarned = false;
    return buf.toString('utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      rt.enoentStreak += 1;
      if (rt.enoentStreak >= ENOENT_WARN_THRESHOLD && !rt.enoentWarned) {
        log.warn('ca-secret-sync source file missing for >= 5 min — OneCLI sidecar may be down', {
          source: rt.config.sourcePath,
          streak: rt.enoentStreak,
        });
        rt.enoentWarned = true;
      }
      return null;
    }
    // ENOENT 以外 (EACCES / EIO 等) は silent failure 排除のため warn を即時発火。
    log.warn('ca-secret-sync source file read error', { source: rt.config.sourcePath, err });
    return null;
  }
}

function encodeSecretData(ca: string): Record<string, string> {
  // K8s Secret data は base64 エンコード文字列を要求する。
  const b64 = Buffer.from(ca, 'utf8').toString('base64');
  return {
    [SECRET_KEY_PROXY]: b64,
    [SECRET_KEY_COMBINED]: b64,
  };
}

function sameSecretData(actual: Record<string, string>, desired: Record<string, string>): boolean {
  const actualKeys = Object.keys(actual).sort();
  const desiredKeys = Object.keys(desired).sort();
  if (actualKeys.length !== desiredKeys.length) return false;
  for (let i = 0; i < actualKeys.length; i++) {
    if (actualKeys[i] !== desiredKeys[i]) return false;
    if (actual[actualKeys[i]] !== desired[desiredKeys[i]]) return false;
  }
  return true;
}

type ReadSecretResult = k8s.V1Secret | 'not-found' | 'error';

async function readSecret(rt: Runtime): Promise<ReadSecretResult> {
  try {
    return await rt.coreApi.readNamespacedSecret({
      name: rt.config.secretName,
      namespace: rt.config.namespace,
    });
  } catch (err) {
    if (isHttpStatus(err, 404)) return 'not-found';
    log.warn('ca-secret-sync readNamespacedSecret failed', {
      name: rt.config.secretName,
      namespace: rt.config.namespace,
      err,
    });
    return 'error';
  }
}

async function createSecret(rt: Runtime, data: Record<string, string>): Promise<void> {
  const body: k8s.V1Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: rt.config.secretName,
      namespace: rt.config.namespace,
      labels: {
        'app.kubernetes.io/name': 'biblio-claw',
        'app.kubernetes.io/component': 'onecli',
        'app.kubernetes.io/managed-by': 'ca-secret-sync',
      },
    },
    type: 'Opaque',
    data,
  };
  try {
    await rt.coreApi.createNamespacedSecret({ namespace: rt.config.namespace, body });
    log.info('ca-secret-sync created K8s Secret', {
      name: rt.config.secretName,
      namespace: rt.config.namespace,
    });
  } catch (err) {
    log.warn('ca-secret-sync createNamespacedSecret failed', {
      name: rt.config.secretName,
      namespace: rt.config.namespace,
      err,
    });
  }
}

async function replaceSecret(rt: Runtime, existing: k8s.V1Secret, data: Record<string, string>): Promise<void> {
  // 既存 metadata は保ちつつ labels と data だけ更新 (resourceVersion を保つことで
  // K8s 側の楽観ロックを利かせる)。
  const body: k8s.V1Secret = {
    ...existing,
    metadata: {
      ...(existing.metadata ?? {}),
      labels: {
        ...(existing.metadata?.labels ?? {}),
        'app.kubernetes.io/managed-by': 'ca-secret-sync',
      },
    },
    type: 'Opaque',
    data,
  };
  try {
    await rt.coreApi.replaceNamespacedSecret({
      name: rt.config.secretName,
      namespace: rt.config.namespace,
      body,
    });
    log.info('ca-secret-sync updated K8s Secret', {
      name: rt.config.secretName,
      namespace: rt.config.namespace,
    });
  } catch (err) {
    log.warn('ca-secret-sync replaceNamespacedSecret failed', {
      name: rt.config.secretName,
      namespace: rt.config.namespace,
      err,
    });
  }
}

function isHttpStatus(err: unknown, status: number): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  if (typeof e.statusCode === 'number' && e.statusCode === status) return true;
  if (typeof e.code === 'number' && e.code === status) return true;
  const response = e.response as Record<string, unknown> | undefined;
  if (response && typeof response.statusCode === 'number' && response.statusCode === status) return true;
  return false;
}

// テスト用の内部 export。production からは触らない。
export const __testing = {
  loadConfig,
  encodeSecretData,
  sameSecretData,
  isHttpStatus,
  readCaFile,
  readSecret,
  createSecret,
  replaceSecret,
  ENOENT_WARN_THRESHOLD,
  type: undefined as unknown as Runtime,
};
