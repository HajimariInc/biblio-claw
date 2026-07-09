/**
 * biblio-claw Drive MCP server — 純粋ロジック (testability 分離)
 *
 * `index.mjs` は本 module を stdio transport で wire するだけの薄い entry point。
 * 全ての fetch 呼出し / エラー整形 / tool 定義 / dispatch は本 module に集約し、
 * `logic.test.mjs` から fake `globalThis.fetch` を差し替えた unit test で検証できる
 * ようにする (host 側 MCP wrapper の testability 分離判断と一貫)。
 *
 * ## 契約
 * - `driveFetch(url)` は Bearer placeholder を送るだけ。実 ADC token 置換は OneCLI
 *   MITM (hostPattern=www.googleapis.com) に委ね、本 module は token を持たない。
 * - `driveFetch()` は `AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS)` を必ず付ける
 *   (他 HTTP client と同流儀の timeout 定数、無期限ハング撲滅)。
 * - `formatError()` は非 2xx / AbortError / network-level (`err.cause` あり) を
 *   分岐して patron 向け日本語 hint に整形。診断 (原因の生 message + cause) は
 *   本 module では stdout / stderr に出さず、呼出側 (index.mjs の catch) で
 *   stderr へ集約する。
 */

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const MAX_BIN_BYTES = 5 * 1024 * 1024; // 5 MiB
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
// 20s: 他 HTTP client と同流儀の timeout 定数。Drive API は通常 sub-second 応答、
// 20s あれば proxy 経路の遅延 + Google 側 slow request も許容。無期限ハング撲滅が主目的。
const DRIVE_FETCH_TIMEOUT_MS = 20_000;

export {
  DRIVE_BASE,
  MAX_BIN_BYTES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DRIVE_FETCH_TIMEOUT_MS,
};

/**
 * Drive API を叩く。実 token は OneCLI MITM が Bearer placeholder に上書き置換する。
 * 非 2xx は `err.status` + `err.driveBody` セットで throw、fetch 自体の失敗
 * (proxy 接続拒否 / DNS / TLS 等) は `err.cause` を保持したまま throw する。
 */
export async function driveFetch(url) {
  const res = await fetch(url, {
    headers: { Authorization: 'Bearer placeholder' },
    signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    let preview = '';
    try {
      const body = await res.text();
      preview = body.slice(0, 300);
    } catch (readErr) {
      // body 読取失敗 (stream 中断等) を silent に握りつぶすと debug 不能になる。
      // 呼出側で catch されるが preview 空文字化の理由が残らないため、error 経由で
      // 情報を保持する (呼出側 catch で stderr に出る = 追跡可能)。
      preview = `<body read failed: ${readErr instanceof Error ? readErr.message : String(readErr)}>`;
    }
    const err = new Error(`Drive API ${res.status}: ${preview}`);
    err.status = res.status;
    err.driveBody = preview;
    throw err;
  }
  return res;
}

/**
 * 患者向けエラー整形。status 別の日本語 hint + `err.cause` の system error code を
 * 追記する (Node native fetch は proxy/DNS/TLS 失敗を `err.cause` に system error
 * として格納する = `code: 'ECONNREFUSED'/'ENOTFOUND'/'CERT_HAS_EXPIRED'` 等)。
 */
export function formatError(err) {
  const status = err && typeof err === 'object' ? err.status : undefined;
  const isAbort
    = err && typeof err === 'object' && (err.name === 'AbortError' || err.name === 'TimeoutError');
  let hint = null;
  if (isAbort) {
    hint = `Drive API 応答なし (${DRIVE_FETCH_TIMEOUT_MS}ms タイムアウト)。OneCLI proxy 到達性 or www.googleapis.com 側遅延の可能性 (drive-token-rotator sidecar のログを確認)。`;
  } else if (status === 401) {
    hint
      = 'Drive token 未注入。OneCLI 経由の Bearer 注入が失敗している可能性 '
      + '(drive-token-rotator sidecar のログを確認)。';
  } else if (status === 403) {
    const gcpProjectId = process.env.GCP_PROJECT_ID || '<gcp-project-id>';
    hint
      = 'Drive フォルダの共有設定を確認。GSA '
      + `\`biblio-orchestrator@${gcpProjectId}.iam.gserviceaccount.com\` に `
      + '「閲覧者」権限が付いていないと 403 になる。patron に Drive の共有追加を依頼して。';
  } else if (status === 404) {
    hint = 'ファイル / フォルダが存在しない (削除済 or 存在しない ID)。共有ドライブの場合は Drive フォルダの共有先に SA が含まれているか確認。';
  }
  const base = err instanceof Error ? err.message : String(err);
  // err.cause (Node native fetch の system error) を末尾に追記して patron / 呼出側の
  // debug 材料を残す。cause がなければ base だけ。
  const causeCode = extractCauseCode(err);
  const withCause = causeCode ? `${base} (cause: ${causeCode})` : base;
  return hint ? `${withCause}\n${hint}` : withCause;
}

/**
 * `err.cause` を安全に取り出す (存在しなければ undefined)。formatError の
 * cause code 抽出と index.mjs の stderr 診断 dump の両方で 4 条件ガード
 * (`err` が object かつ `cause` プロパティを持ち、それが truthy) が重複するのを
 * 単一 helper に集約する。
 */
export function getCause(err) {
  if (!err || typeof err !== 'object' || !('cause' in err) || !err.cause) return undefined;
  return err.cause;
}

function extractCauseCode(err) {
  const cause = getCause(err);
  if (!cause) return null;
  if (typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string') {
    return cause.code;
  }
  return null;
}

export const TOOL_LIST = {
  drive_list_files: {
    name: 'drive_list_files',
    description:
      '共有された Google Drive フォルダのファイル一覧を返す。'
      + 'folder_id を指定すると当該フォルダ配下のみ、未指定なら共有中の全 file (上限 page_size)。'
      + 'Read-only。403 が返ったらフォルダの共有設定を確認せよ。',
    inputSchema: {
      type: 'object',
      properties: {
        folder_id: {
          type: 'string',
          description:
            'Drive フォルダ ID (URL `https://drive.google.com/drive/folders/<ID>` の `<ID>` 部分)。'
            + '未指定なら共有中の全 file を返す。',
        },
        page_size: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_PAGE_SIZE,
          default: DEFAULT_PAGE_SIZE,
          description: `1 リクエストで返す件数上限 (1-${MAX_PAGE_SIZE}、default ${DEFAULT_PAGE_SIZE})。`,
        },
      },
      additionalProperties: false,
    },
  },
  drive_get_file: {
    name: 'drive_get_file',
    description:
      'Google Drive ファイルの内容を取得する。'
      + 'Google Docs 系 (Docs/Sheets/Slides) は自動的に text 化される、'
      + 'Binary ファイルは 5 MiB まで (text-like は utf-8、それ以外は base64 で返す)。',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description:
            'Drive file ID (drive_list_files 応答の files[].id、または URL `/d/<ID>/` 部分)。',
        },
        export_mime: {
          type: 'string',
          default: 'text/plain',
          description:
            'Google Docs export の MIME type (default `text/plain`、Sheets を CSV で取るなら `text/csv` 等)。'
            + 'Binary ファイルには効かない (alt=media の raw download 経路になる)。',
        },
      },
      required: ['file_id'],
      additionalProperties: false,
    },
  },
};

/**
 * NOTE: inputSchema (`additionalProperties: false` / `minimum` / `maximum` / `required`
 * 等) は LLM 向けの説明メタデータであり、MCP SDK の低レベル `Server` API 経由では
 * 実行時強制されない。実際の gate は下記 `listFiles` / `getFile` 内の手書き check
 * (`Number.isInteger(args.page_size)` の clamp、`file_id` の required check) が担う。
 * 将来 schema にフィールドを足す際は、必ず対応する手書き check も同時に追加する。
 */
export async function listFiles(args) {
  const folderIdRaw
    = typeof args.folder_id === 'string' && args.folder_id.length > 0 ? args.folder_id : null;
  // Drive query の `'<id>' in parents` は id 内の `'` で構文を壊せる。実害は「GSA が
  // 既にアクセスできる範囲」を超えないが、defensive にエスケープ。
  const folderId = folderIdRaw ? folderIdRaw.replace(/'/g, "\\'") : null;
  const rawPageSize = Number.isInteger(args.page_size) ? args.page_size : DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(rawPageSize, 1), MAX_PAGE_SIZE);

  const params = new URLSearchParams({
    pageSize: String(pageSize),
    fields: 'files(id,name,mimeType,modifiedTime,size),nextPageToken',
    // Shared Drive 対応: supportsAllDrives が「app が Shared Drive を扱える」宣言、
    // includeItemsFromAllDrives が list 応答に Shared Drive item を含める許可。
    // 両方揃うと corpora=user (default) のまま Shared Drive folder scope 検索が可能
    // (Google 公式 enable-shareddrives guide の query mode 表)。My Drive 経路は
    // corpora 不変のため regression なし。
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  params.set('q', folderId ? `'${folderId}' in parents and trashed=false` : 'trashed=false');
  const url = `${DRIVE_BASE}/files?${params.toString()}`;
  const res = await driveFetch(url);
  return await res.json();
}

export async function getFile(args) {
  const fileId = typeof args.file_id === 'string' ? args.file_id : '';
  if (!fileId) {
    const err = new Error('file_id is required');
    err.status = 400;
    throw err;
  }
  const exportMime
    = typeof args.export_mime === 'string' && args.export_mime.length > 0
      ? args.export_mime
      : 'text/plain';

  const metaUrl = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size&supportsAllDrives=true`;
  const metaRes = await driveFetch(metaUrl);
  const meta = await metaRes.json();

  const isGoogleDoc
    = typeof meta.mimeType === 'string' && meta.mimeType.startsWith('application/vnd.google-apps.');
  if (isGoogleDoc) {
    const exportUrl = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}&supportsAllDrives=true`;
    const exportRes = await driveFetch(exportUrl);
    const content = await exportRes.text();
    return { ...meta, content, encoding: 'text' };
  }

  const size = typeof meta.size === 'string' ? Number(meta.size) : NaN;
  if (Number.isFinite(size) && size > MAX_BIN_BYTES) {
    throw new Error(
      `File size ${size} bytes exceeds 5 MiB limit `
        + `(mimeType=${meta.mimeType})。Google Docs なら export_mime='text/plain' を試すか、`
        + `patron に小さいファイルの指定を依頼せよ。`,
    );
  }
  // meta.size が Drive API で返らない (NaN) 場合は事前 guard を素通りする。
  // post-download の buf.byteLength check が二段防御として残っているが、無駄な
  // 巨大 download を毎回繰り返す可能性を運用側が気づけるように stderr に警告を出す。
  if (!Number.isFinite(size)) {
    console.error(
      `[drive-mcp] meta.size unavailable, falling back to post-download size check `
        + `(fileId=${fileId} mimeType=${meta.mimeType})`,
    );
  }
  const downloadUrl = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const dlRes = await driveFetch(downloadUrl);
  const buf = Buffer.from(await dlRes.arrayBuffer());
  if (buf.byteLength > MAX_BIN_BYTES) {
    throw new Error(
      `Downloaded content ${buf.byteLength} bytes exceeds 5 MiB limit `
        + `(mimeType=${meta.mimeType}、meta.size 空の巨大ファイル)。`,
    );
  }
  const textLike
    = typeof meta.mimeType === 'string'
    && (meta.mimeType.startsWith('text/')
      || meta.mimeType === 'application/json'
      || meta.mimeType === 'application/xml');
  if (textLike) {
    return { ...meta, content: buf.toString('utf8'), encoding: 'text' };
  }
  return { ...meta, content: buf.toString('base64'), encoding: 'base64' };
}

export async function dispatch(name, args) {
  if (name === 'drive_list_files') return listFiles(args);
  if (name === 'drive_get_file') return getFile(args);
  throw new Error(`Unknown tool: ${name}`);
}
