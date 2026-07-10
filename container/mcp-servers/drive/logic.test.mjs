#!/usr/bin/env node
/**
 * biblio-claw Drive MCP server logic の unit test。
 *
 * Node built-in test runner (`node:test` + `node:assert/strict`) を使用し、
 * 依存ゼロで走る (`node test.mjs` ではなく `node --test logic.test.mjs`)。
 * fake `globalThis.fetch` を差し替えて実 Drive 到達なしで全分岐を検証する
 * (host 側 test の vi.stubGlobal 経路と同思想を、Node 22 では test-scope の
 * manual restore で実現)。
 *
 * 保護対象:
 *   - formatError: 401/403/404 hint + AbortError timeout hint + err.cause 追記 + fallback (status なし)
 *   - driveFetch: 非 2xx で err.status/err.driveBody セット、body 読取失敗の握りつぶし防止
 *   - listFiles: q クエリ組立 (folder_id 有無)、page_size clamping (1-100)、folder_id エスケープ
 *   - getFile: Google Docs export 経路 (text 化) / Binary 5 MiB 制限 (pre + post download 2 段)
 *   - dispatch: 未知 tool 名で throw
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRIVE_FETCH_TIMEOUT_MS,
  MAX_BIN_BYTES,
  driveFetch,
  formatError,
  listFiles,
  getFile,
  dispatch,
} from './logic.mjs';

const originalFetch = globalThis.fetch;

function installFakeFetch(handler) {
  globalThis.fetch = handler;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status, body) {
  return {
    ok: status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
  };
}

function textResponse(status, text) {
  return {
    ok: status < 300,
    status,
    json: async () => ({ __raw__: text }),
    text: async () => text,
    arrayBuffer: async () => Buffer.from(text),
  };
}

function binaryResponse(status, buf) {
  return {
    ok: status < 300,
    status,
    json: async () => ({}),
    text: async () => buf.toString('utf8'),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

// -------- formatError --------------------------------------------------------

test('formatError: 401 は drive-token-rotator hint を含む', () => {
  const err = Object.assign(new Error('Drive API 401: unauthorized'), { status: 401 });
  const msg = formatError(err);
  assert.match(msg, /Drive token 未注入/);
  assert.match(msg, /drive-token-rotator/);
});

test('formatError: 403 は GSA 共有設定 hint を含む (env-driven の project id で組み立て)', () => {
  const savedProjectId = process.env.GCP_PROJECT_ID;
  process.env.GCP_PROJECT_ID = 'test-project-id';
  try {
    const err = Object.assign(new Error('Drive API 403: forbidden'), { status: 403 });
    const msg = formatError(err);
    assert.match(msg, /閲覧者/);
    assert.match(msg, /biblio-orchestrator@test-project-id\.iam\.gserviceaccount\.com/);
  } finally {
    if (savedProjectId === undefined) {
      delete process.env.GCP_PROJECT_ID;
    } else {
      process.env.GCP_PROJECT_ID = savedProjectId;
    }
  }
});

test('formatError: 403 は GCP_PROJECT_ID 未設定なら sentinel placeholder に fallback', () => {
  const savedProjectId = process.env.GCP_PROJECT_ID;
  delete process.env.GCP_PROJECT_ID;
  try {
    const err = Object.assign(new Error('Drive API 403: forbidden'), { status: 403 });
    const msg = formatError(err);
    assert.match(msg, /biblio-orchestrator@<gcp-project-id>\.iam\.gserviceaccount\.com/);
  } finally {
    if (savedProjectId !== undefined) {
      process.env.GCP_PROJECT_ID = savedProjectId;
    }
  }
});

test('formatError: 404 は「存在しない」hint を返す', () => {
  const err = Object.assign(new Error('Drive API 404: not found'), { status: 404 });
  assert.match(formatError(err), /存在しない/);
});

test('formatError: AbortError (timeout) は timeout hint + ms 値を含む', () => {
  const err = new Error('The operation was aborted');
  err.name = 'TimeoutError'; // AbortSignal.timeout() は TimeoutError を投げる
  const msg = formatError(err);
  assert.match(msg, /応答なし/);
  assert.match(msg, new RegExp(String(DRIVE_FETCH_TIMEOUT_MS)));
});

test('formatError: status なしの Error は message + cause code を返す (hint なし fallback)', () => {
  const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const err = new TypeError('fetch failed');
  err.cause = cause;
  const msg = formatError(err);
  assert.match(msg, /fetch failed/);
  assert.match(msg, /ECONNREFUSED/);
});

test('formatError: cause 無しの Error は message だけ返す', () => {
  assert.equal(formatError(new Error('bare failure')), 'bare failure');
});

test('formatError: Error でない値も string 化される', () => {
  assert.equal(formatError('raw string'), 'raw string');
});

// -------- driveFetch ---------------------------------------------------------

test('driveFetch: 200 は Response を素通し (Authorization ヘッダは placeholder)', async () => {
  let capturedInit;
  installFakeFetch(async (url, init) => {
    capturedInit = init;
    return jsonResponse(200, { files: [] });
  });
  const res = await driveFetch('https://www.googleapis.com/drive/v3/files');
  assert.equal(res.status, 200);
  assert.equal(capturedInit.headers.Authorization, 'Bearer placeholder');
  assert.ok(capturedInit.signal, 'signal must be set (AbortSignal.timeout)');
});

test('driveFetch: 非 2xx は err.status / err.driveBody をセットして throw', async () => {
  installFakeFetch(async () => textResponse(403, 'forbidden'));
  await assert.rejects(
    () => driveFetch('https://www.googleapis.com/drive/v3/files'),
    (err) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /Drive API 403/);
      assert.match(err.driveBody, /forbidden/);
      return true;
    },
  );
});

test('driveFetch: 非 2xx で body 読取が失敗しても preview に理由が残る (silent failure 撲滅)', async () => {
  installFakeFetch(async () => ({
    ok: false,
    status: 500,
    text: async () => {
      throw new Error('stream aborted');
    },
  }));
  await assert.rejects(
    () => driveFetch('https://www.googleapis.com/drive/v3/files'),
    (err) => {
      assert.equal(err.status, 500);
      assert.match(err.driveBody, /body read failed: stream aborted/);
      return true;
    },
  );
});

// -------- listFiles ---------------------------------------------------------

function extractQ(url) {
  const [, query] = url.split('?');
  return new URLSearchParams(query).get('q');
}

test('listFiles: folder_id 指定時は q に in parents フィルタが載る', async () => {
  let capturedUrl;
  installFakeFetch(async (url) => {
    capturedUrl = url;
    return jsonResponse(200, { files: [] });
  });
  await listFiles({ folder_id: 'folder-abc' });
  assert.equal(extractQ(capturedUrl), "'folder-abc' in parents and trashed=false");
});

test('listFiles: folder_id 未指定は q=trashed=false のみ', async () => {
  let capturedUrl;
  installFakeFetch(async (url) => {
    capturedUrl = url;
    return jsonResponse(200, { files: [] });
  });
  await listFiles({});
  assert.equal(extractQ(capturedUrl), 'trashed=false');
});

test('listFiles: page_size が範囲外なら clamp (0 → 1、999 → 100)', async () => {
  let urls = [];
  installFakeFetch(async (url) => {
    urls.push(url);
    return jsonResponse(200, { files: [] });
  });
  await listFiles({ page_size: 0 });
  await listFiles({ page_size: 999 });
  assert.match(urls[0], /pageSize=1(&|$)/);
  assert.match(urls[1], /pageSize=100(&|$)/);
});

test('listFiles: page_size default は 20', async () => {
  let capturedUrl;
  installFakeFetch(async (url) => {
    capturedUrl = url;
    return jsonResponse(200, { files: [] });
  });
  await listFiles({});
  assert.match(capturedUrl, /pageSize=20(&|$)/);
});

test('listFiles: folder_id の single quote はエスケープされる (query injection 防止)', async () => {
  let capturedUrl;
  installFakeFetch(async (url) => {
    capturedUrl = url;
    return jsonResponse(200, { files: [] });
  });
  await listFiles({ folder_id: "abc' or 'x'='x" });
  // URLSearchParams.get() は URL エスケープを解いた生の値を返す。
  // 実装は folder_id 内の `'` を `\'` に置換してから `'...' in parents` で包む。
  assert.equal(
    extractQ(capturedUrl),
    "'abc\\' or \\'x\\'=\\'x' in parents and trashed=false",
  );
});

test('listFiles: Shared Drive 対応パラメータ (supportsAllDrives + includeItemsFromAllDrives) が URL に載る', async () => {
  let capturedUrl;
  installFakeFetch(async (url) => {
    capturedUrl = url;
    return jsonResponse(200, { files: [] });
  });
  await listFiles({ folder_id: 'shared-drive-folder-id' });
  const params = new URLSearchParams(capturedUrl.split('?')[1]);
  assert.equal(params.get('supportsAllDrives'), 'true');
  assert.equal(params.get('includeItemsFromAllDrives'), 'true');
});

// -------- getFile -----------------------------------------------------------

test('getFile: file_id 未指定は 400 で throw', async () => {
  await assert.rejects(() => getFile({}), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
});

test('getFile: Google Doc は export 経路で text 化される', async () => {
  const responses = [
    jsonResponse(200, {
      id: 'f1',
      mimeType: 'application/vnd.google-apps.document',
      name: 'doc',
    }),
    textResponse(200, 'plain text content'),
  ];
  let i = 0;
  installFakeFetch(async () => responses[i++]);
  const result = await getFile({ file_id: 'f1' });
  assert.equal(result.encoding, 'text');
  assert.equal(result.content, 'plain text content');
  assert.equal(result.mimeType, 'application/vnd.google-apps.document');
});

test('getFile: meta.size が 5 MiB 超なら pre-download guard で throw', async () => {
  installFakeFetch(async () =>
    jsonResponse(200, {
      id: 'f2',
      mimeType: 'video/mp4',
      size: String(6 * 1024 * 1024),
    }),
  );
  await assert.rejects(() => getFile({ file_id: 'f2' }), /exceeds 5 MiB/);
});

test('getFile: text-like MIME は utf-8 で返る', async () => {
  const responses = [
    jsonResponse(200, {
      id: 'f3',
      mimeType: 'text/plain',
      size: '11',
    }),
    binaryResponse(200, Buffer.from('hello world')),
  ];
  let i = 0;
  installFakeFetch(async () => responses[i++]);
  const result = await getFile({ file_id: 'f3' });
  assert.equal(result.encoding, 'text');
  assert.equal(result.content, 'hello world');
});

test('getFile: 非 text-like MIME は base64 で返る', async () => {
  const responses = [
    jsonResponse(200, {
      id: 'f4',
      mimeType: 'image/png',
      size: '4',
    }),
    binaryResponse(200, Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  ];
  let i = 0;
  installFakeFetch(async () => responses[i++]);
  const result = await getFile({ file_id: 'f4' });
  assert.equal(result.encoding, 'base64');
  assert.equal(result.content, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
});

test('getFile: meta.size 欠落 (NaN) 時は post-download guard で 5 MiB 超を throw', async () => {
  const bigBuf = Buffer.alloc(MAX_BIN_BYTES + 1);
  const responses = [
    jsonResponse(200, {
      id: 'f5',
      mimeType: 'application/octet-stream',
      // size フィールド欠落 (Drive API が返さないケース)
    }),
    binaryResponse(200, bigBuf),
  ];
  let i = 0;
  installFakeFetch(async () => responses[i++]);
  // stderr の warn (meta.size unavailable) を suppress するため vi 系がない Node
  // built-in test では console.error を no-op に差し替え。restore は afterEach 相当。
  const originalErr = console.error;
  console.error = () => {};
  try {
    await assert.rejects(() => getFile({ file_id: 'f5' }), /Downloaded content \d+ bytes exceeds/);
  } finally {
    console.error = originalErr;
  }
});

test('getFile: metadata URL に supportsAllDrives=true が載る (Shared Drive 対応)', async () => {
  let capturedUrls = [];
  installFakeFetch(async (url) => {
    capturedUrls.push(url);
    return jsonResponse(200, { id: 'f-shared', name: 'shared.txt', mimeType: 'text/plain' });
  });
  // meta.size 欠落経路を通るため console.error (`meta.size unavailable`) を no-op に差し替え
  // (既存の `meta.size 欠落 (NaN) 時` test と同流儀 — stderr noise 抑制のためだけの局所差し替え)。
  const originalErr = console.error;
  console.error = () => {};
  try {
    await getFile({ file_id: 'f-shared' });
  } finally {
    console.error = originalErr;
  }
  assert.match(capturedUrls[0], /supportsAllDrives=true/);
});

test('getFile: Google Docs export URL に supportsAllDrives=true が載る', async () => {
  let capturedUrls = [];
  installFakeFetch(async (url) => {
    capturedUrls.push(url);
    if (url.includes('/export')) {
      return textResponse(200, 'exported content');
    }
    return jsonResponse(200, {
      id: 'f-doc',
      name: 'shared-doc',
      mimeType: 'application/vnd.google-apps.document',
    });
  });
  await getFile({ file_id: 'f-doc' });
  const exportUrl = capturedUrls.find((u) => u.includes('/export'));
  assert.ok(exportUrl, 'export URL should be captured');
  assert.match(exportUrl, /supportsAllDrives=true/);
});

test('getFile: alt=media download URL に supportsAllDrives=true が載る', async () => {
  let capturedUrls = [];
  installFakeFetch(async (url) => {
    capturedUrls.push(url);
    if (url.includes('alt=media')) {
      return binaryResponse(200, Buffer.from('binary content'));
    }
    return jsonResponse(200, {
      id: 'f-bin',
      name: 'shared.bin',
      mimeType: 'application/octet-stream',
    });
  });
  const originalErr = console.error;
  console.error = () => {};
  try {
    await getFile({ file_id: 'f-bin' });
  } finally {
    console.error = originalErr;
  }
  const downloadUrl = capturedUrls.find((u) => u.includes('alt=media'));
  assert.ok(downloadUrl, 'download URL should be captured');
  assert.match(downloadUrl, /supportsAllDrives=true/);
});

// -------- dispatch ----------------------------------------------------------

test('dispatch: 未知 tool 名は throw', async () => {
  await assert.rejects(() => dispatch('unknown_tool', {}), /Unknown tool: unknown_tool/);
});

test('dispatch: drive_list_files を listFiles に振り分ける', async () => {
  installFakeFetch(async () => jsonResponse(200, { files: [{ id: 'x' }] }));
  const result = await dispatch('drive_list_files', {});
  assert.deepEqual(result, { files: [{ id: 'x' }] });
});
