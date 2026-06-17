import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { coreApi, kubeConfigCtor, fsReadFile, schedulerStart, schedulerStop, warnCalls, infoCalls } = vi.hoisted(() => {
  const coreApi = {
    readNamespacedSecret: vi.fn(),
    createNamespacedSecret: vi.fn().mockResolvedValue({}),
    replaceNamespacedSecret: vi.fn().mockResolvedValue({}),
  };
  // `new kubeConfigCtor()` で instance を埋めるため function 形式 (arrow は不可)。
  const kubeConfigCtor = vi.fn(function (this: { loadFromCluster: () => void; makeApiClient: () => unknown }) {
    this.loadFromCluster = vi.fn();
    this.makeApiClient = vi.fn().mockReturnValue(coreApi);
  });
  return {
    coreApi,
    kubeConfigCtor,
    fsReadFile: vi.fn(),
    schedulerStart: vi.fn(),
    schedulerStop: vi.fn(),
    warnCalls: [] as unknown[],
    infoCalls: [] as unknown[],
  };
});

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: kubeConfigCtor,
  CoreV1Api: vi.fn(),
}));

vi.mock('fs', () => ({
  promises: { readFile: fsReadFile },
}));

// scheduler をモックして start に渡されるコールバックをキャプチャ可能にする
// (= startCaSecretSync が syncOnce を scheduler に渡しているかを検証するため)。
vi.mock('../../adapters/scheduler/index.js', () => ({
  getSchedulerProvider: () => ({ name: 'mock', start: schedulerStart, stop: schedulerStop }),
}));

vi.mock('../../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: (...args: unknown[]) => infoCalls.push(args),
    warn: (...args: unknown[]) => warnCalls.push(args),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { __testing, startCaSecretSync, stopCaSecretSync, syncOnce } from '../ca-secret-sync.js';

const CA_BUFFER = Buffer.from('-----BEGIN CERTIFICATE-----\nFAKEPEM\n-----END CERTIFICATE-----\n', 'utf8');
const CA_BASE64 = CA_BUFFER.toString('base64');

interface TestRuntime {
  coreApi: typeof coreApi;
  config: { namespace: string; secretName: string; sourcePath: string };
  scheduler: { name: string; start: () => void; stop: () => void };
  enoentStreak: number;
  enoentWarned: boolean;
}

function makeRuntime(overrides: Partial<TestRuntime> = {}): TestRuntime {
  return {
    coreApi,
    config: {
      namespace: 'biblio-claw',
      secretName: 'biblio-onecli-ca',
      sourcePath: '/etc/ssl/certs/onecli/ca.pem',
    },
    scheduler: { name: 'noop', start: vi.fn(), stop: vi.fn() },
    enoentStreak: 0,
    enoentWarned: false,
    ...overrides,
  };
}

function makeEnoent(): NodeJS.ErrnoException {
  const e = new Error('ENOENT') as NodeJS.ErrnoException;
  e.code = 'ENOENT';
  return e;
}

function makeApiError(statusCode: number): Error {
  const e = new Error(`HTTP ${statusCode}`) as Error & { statusCode: number };
  e.statusCode = statusCode;
  return e;
}

beforeEach(() => {
  coreApi.readNamespacedSecret.mockReset();
  coreApi.createNamespacedSecret.mockReset().mockResolvedValue({});
  coreApi.replaceNamespacedSecret.mockReset().mockResolvedValue({});
  fsReadFile.mockReset();
  schedulerStart.mockReset();
  schedulerStop.mockReset();
  warnCalls.length = 0;
  infoCalls.length = 0;
});

afterEach(() => {
  stopCaSecretSync();
});

describe('ca-secret-sync syncOnce', () => {
  it('Secret 不在 (404) なら createNamespacedSecret を呼ぶ', async () => {
    fsReadFile.mockResolvedValueOnce(CA_BUFFER);
    coreApi.readNamespacedSecret.mockRejectedValueOnce(makeApiError(404));

    const rt = makeRuntime();
    await syncOnce(rt as unknown as Parameters<typeof syncOnce>[0]);

    expect(coreApi.createNamespacedSecret).toHaveBeenCalledTimes(1);
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled();

    const body = coreApi.createNamespacedSecret.mock.calls[0][0].body;
    expect(body.data['onecli-proxy-ca.pem']).toBe(CA_BASE64);
    expect(body.data['onecli-combined-ca.pem']).toBe(CA_BASE64);
    expect(body.metadata.labels['app.kubernetes.io/managed-by']).toBe('ca-secret-sync');
    expect(body.type).toBe('Opaque');
  });

  it('Secret 存在 + 内容一致なら no-op', async () => {
    fsReadFile.mockResolvedValueOnce(CA_BUFFER);
    coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { name: 'biblio-onecli-ca', namespace: 'biblio-claw', resourceVersion: '42' },
      type: 'Opaque',
      data: {
        'onecli-proxy-ca.pem': CA_BASE64,
        'onecli-combined-ca.pem': CA_BASE64,
      },
    });

    const rt = makeRuntime();
    await syncOnce(rt as unknown as Parameters<typeof syncOnce>[0]);

    expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled();
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled();
  });

  it('Secret 存在 + 内容差分なら replaceNamespacedSecret を呼ぶ', async () => {
    fsReadFile.mockResolvedValueOnce(CA_BUFFER);
    coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { name: 'biblio-onecli-ca', namespace: 'biblio-claw', resourceVersion: '42' },
      type: 'Opaque',
      data: {
        'onecli-proxy-ca.pem': 'AAAA-old-base64',
        'onecli-combined-ca.pem': 'AAAA-old-base64',
      },
    });

    const rt = makeRuntime();
    await syncOnce(rt as unknown as Parameters<typeof syncOnce>[0]);

    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledTimes(1);
    expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled();

    const call = coreApi.replaceNamespacedSecret.mock.calls[0][0];
    expect(call.name).toBe('biblio-onecli-ca');
    expect(call.body.data['onecli-proxy-ca.pem']).toBe(CA_BASE64);
    expect(call.body.metadata.resourceVersion).toBe('42'); // 楽観ロック温存
    expect(call.body.metadata.labels['app.kubernetes.io/managed-by']).toBe('ca-secret-sync');
  });

  it('source file が ENOENT なら API を呼ばず enoentStreak++', async () => {
    fsReadFile.mockRejectedValueOnce(makeEnoent());

    const rt = makeRuntime();
    await syncOnce(rt as unknown as Parameters<typeof syncOnce>[0]);

    expect(coreApi.readNamespacedSecret).not.toHaveBeenCalled();
    expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled();
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled();
    expect(rt.enoentStreak).toBe(1);
    expect(rt.enoentWarned).toBe(false);
    // streak 1 では warn しない (閾値 5 まで silent)
    expect(warnCalls).toHaveLength(0);
  });

  it('ENOENT が閾値 (5) 連続で warn 1 回、解消で streak リセット', async () => {
    const rt = makeRuntime();

    for (let i = 0; i < __testing.ENOENT_WARN_THRESHOLD; i++) {
      fsReadFile.mockRejectedValueOnce(makeEnoent());
      await syncOnce(rt as unknown as Parameters<typeof syncOnce>[0]);
    }
    expect(rt.enoentStreak).toBe(__testing.ENOENT_WARN_THRESHOLD);
    expect(rt.enoentWarned).toBe(true);
    expect(warnCalls).toHaveLength(1);

    // 6 回目も ENOENT だが warn は重複しない
    fsReadFile.mockRejectedValueOnce(makeEnoent());
    await syncOnce(rt as unknown as Parameters<typeof syncOnce>[0]);
    expect(warnCalls).toHaveLength(1);

    // 解消すると streak リセット + 復旧 info ログ
    fsReadFile.mockResolvedValueOnce(CA_BUFFER);
    coreApi.readNamespacedSecret.mockRejectedValueOnce(makeApiError(404));
    await syncOnce(rt as unknown as Parameters<typeof syncOnce>[0]);
    expect(rt.enoentStreak).toBe(0);
    expect(rt.enoentWarned).toBe(false);
  });

  it('readNamespacedSecret が一時失敗したら warn + 次 tick で retry (createNamespacedSecret は呼ばれない)', async () => {
    fsReadFile.mockResolvedValueOnce(CA_BUFFER);
    coreApi.readNamespacedSecret.mockRejectedValueOnce(makeApiError(503));

    const rt = makeRuntime();
    await syncOnce(rt as unknown as Parameters<typeof syncOnce>[0]);

    expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled();
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled();
    expect(warnCalls).toHaveLength(1);

    // 次 tick で recovery: 404 → create
    fsReadFile.mockResolvedValueOnce(CA_BUFFER);
    coreApi.readNamespacedSecret.mockRejectedValueOnce(makeApiError(404));
    await syncOnce(rt as unknown as Parameters<typeof syncOnce>[0]);

    expect(coreApi.createNamespacedSecret).toHaveBeenCalledTimes(1);
  });

  it('createNamespacedSecret が 409 Conflict で失敗しても例外を投げず warn', async () => {
    fsReadFile.mockResolvedValueOnce(CA_BUFFER);
    coreApi.readNamespacedSecret.mockRejectedValueOnce(makeApiError(404));
    coreApi.createNamespacedSecret.mockRejectedValueOnce(makeApiError(409));

    const rt = makeRuntime();
    await expect(syncOnce(rt as unknown as Parameters<typeof syncOnce>[0])).resolves.toBeUndefined();
    expect(warnCalls).toHaveLength(1);
  });

  it('ENOENT 以外の read error (EACCES) は streak を増やさず warn', async () => {
    const eacces = new Error('EACCES') as NodeJS.ErrnoException;
    eacces.code = 'EACCES';
    fsReadFile.mockRejectedValueOnce(eacces);

    const rt = makeRuntime();
    await syncOnce(rt as unknown as Parameters<typeof syncOnce>[0]);

    expect(rt.enoentStreak).toBe(0);
    expect(warnCalls).toHaveLength(1);
    expect(coreApi.readNamespacedSecret).not.toHaveBeenCalled();
  });

  it('source file が空 (空白のみ) なら warn + API を呼ばない (空 base64 上書き防止)', async () => {
    fsReadFile.mockResolvedValueOnce(Buffer.from('   \n\t', 'utf8'));

    const rt = makeRuntime();
    await syncOnce(rt as unknown as Parameters<typeof syncOnce>[0]);

    // 空ファイルは null 扱い → readSecret 以降に進まない (有効 Secret を空で潰さない)
    expect(coreApi.readNamespacedSecret).not.toHaveBeenCalled();
    expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled();
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled();
    expect(warnCalls).toHaveLength(1);
    // 空ファイルは ENOENT とは別扱い: streak は増やさない
    expect(rt.enoentStreak).toBe(0);
  });

  it('replaceNamespacedSecret が 503 で失敗しても例外を投げず warn (create 409 と対称)', async () => {
    fsReadFile.mockResolvedValueOnce(CA_BUFFER);
    coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { name: 'biblio-onecli-ca', namespace: 'biblio-claw', resourceVersion: '99' },
      type: 'Opaque',
      data: { 'onecli-proxy-ca.pem': 'stale', 'onecli-combined-ca.pem': 'stale' },
    });
    coreApi.replaceNamespacedSecret.mockRejectedValueOnce(makeApiError(503));

    const rt = makeRuntime();
    await expect(syncOnce(rt as unknown as Parameters<typeof syncOnce>[0])).resolves.toBeUndefined();
    expect(warnCalls).toHaveLength(1);
  });
});

describe('ca-secret-sync helpers', () => {
  it('encodeSecretData は 2 key 両方に同じ base64 を入れる', () => {
    const data = __testing.encodeSecretData(CA_BUFFER.toString('utf8'));
    expect(data['onecli-proxy-ca.pem']).toBe(CA_BASE64);
    expect(data['onecli-combined-ca.pem']).toBe(CA_BASE64);
  });

  it('sameSecretData は同 keys + 同 value で true、差分で false', () => {
    const a = { x: 'aa', y: 'bb' };
    expect(__testing.sameSecretData(a, { x: 'aa', y: 'bb' })).toBe(true);
    expect(__testing.sameSecretData(a, { x: 'aa', y: 'CC' })).toBe(false);
    expect(__testing.sameSecretData(a, { x: 'aa' })).toBe(false);
    expect(__testing.sameSecretData(a, { x: 'aa', y: 'bb', z: 'cc' })).toBe(false);
  });

  it('isHttpStatus は statusCode / code / response.statusCode を検出', () => {
    expect(__testing.isHttpStatus({ statusCode: 404 }, 404)).toBe(true);
    expect(__testing.isHttpStatus({ code: 404 }, 404)).toBe(true);
    expect(__testing.isHttpStatus({ response: { statusCode: 404 } }, 404)).toBe(true);
    expect(__testing.isHttpStatus({ statusCode: 200 }, 404)).toBe(false);
    expect(__testing.isHttpStatus(null, 404)).toBe(false);
    expect(__testing.isHttpStatus('not an error', 404)).toBe(false);
  });

  it('loadConfig は env で override 可能', () => {
    const orig = {
      ns: process.env.BIBLIO_NAMESPACE,
      name: process.env.ONECLI_CA_SECRET_NAME,
      src: process.env.ONECLI_CA_SOURCE_PATH,
    };
    process.env.BIBLIO_NAMESPACE = 'custom-ns';
    process.env.ONECLI_CA_SECRET_NAME = 'custom-secret';
    process.env.ONECLI_CA_SOURCE_PATH = '/custom/ca.pem';
    try {
      const cfg = __testing.loadConfig();
      expect(cfg.namespace).toBe('custom-ns');
      expect(cfg.secretName).toBe('custom-secret');
      expect(cfg.sourcePath).toBe('/custom/ca.pem');
    } finally {
      if (orig.ns === undefined) delete process.env.BIBLIO_NAMESPACE;
      else process.env.BIBLIO_NAMESPACE = orig.ns;
      if (orig.name === undefined) delete process.env.ONECLI_CA_SECRET_NAME;
      else process.env.ONECLI_CA_SECRET_NAME = orig.name;
      if (orig.src === undefined) delete process.env.ONECLI_CA_SOURCE_PATH;
      else process.env.ONECLI_CA_SOURCE_PATH = orig.src;
    }
  });
});

describe('ca-secret-sync lifecycle', () => {
  it('startCaSecretSync は KubeConfig().loadFromCluster() を呼んで scheduler を start する', async () => {
    fsReadFile.mockResolvedValue(CA_BUFFER);
    coreApi.readNamespacedSecret.mockResolvedValue({
      metadata: { name: 'biblio-onecli-ca', resourceVersion: '1' },
      type: 'Opaque',
      data: { 'onecli-proxy-ca.pem': CA_BASE64, 'onecli-combined-ca.pem': CA_BASE64 },
    });

    await startCaSecretSync();
    expect(kubeConfigCtor).toHaveBeenCalled();
    stopCaSecretSync();
  });

  it('startCaSecretSync を 2 回呼ぶと 2 回目は warn してスキップ', async () => {
    fsReadFile.mockResolvedValue(CA_BUFFER);
    coreApi.readNamespacedSecret.mockResolvedValue({
      metadata: { name: 'biblio-onecli-ca', resourceVersion: '1' },
      type: 'Opaque',
      data: { 'onecli-proxy-ca.pem': CA_BASE64, 'onecli-combined-ca.pem': CA_BASE64 },
    });

    await startCaSecretSync();
    warnCalls.length = 0;
    await startCaSecretSync();
    expect(warnCalls).toHaveLength(1);
    stopCaSecretSync();
  });

  it('scheduler.start に渡したコールバックが syncOnce を発火する (最重要副作用の検証)', async () => {
    fsReadFile.mockResolvedValueOnce(CA_BUFFER);
    coreApi.readNamespacedSecret.mockRejectedValueOnce(makeApiError(404));

    await startCaSecretSync();
    expect(schedulerStart).toHaveBeenCalledTimes(1);

    // scheduler に渡されたコールバックを手動発火 → syncOnce が走り K8s API に到達する。
    // これが無音で no-op に置き換わると CA bundle が更新されず agent TLS が静かに壊れるため、
    // 「コールバック = syncOnce」の契約を明示的に検証する。
    const cb = schedulerStart.mock.calls[0][0] as () => Promise<void>;
    await cb();
    expect(coreApi.createNamespacedSecret).toHaveBeenCalledTimes(1);

    stopCaSecretSync();
    expect(schedulerStop).toHaveBeenCalledTimes(1);
  });
});
