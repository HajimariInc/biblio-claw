#!/usr/bin/env node
/**
 * biblio-claw Drive MCP server (M4-F Phase 3: life-capabilities)
 *
 * agent-container 内で spawn される独立 Node 22 stdio MCP server。
 * agent-runner (Bun) 内で fetch() を叩かない設計 (= oven-sh/bun#30381 の
 * HTTPS-over-CONNECT-proxy バグ回避) の一環として、Drive API への到達を
 * 本 server (Node 22) に集約する。
 *
 * ## 認可の集約 (命題 2: secret は wire 上でだけ実体を持つ)
 * 実 ADC token は **持たない**。全リクエストに `Authorization: Bearer placeholder`
 * ヘッダを付けて `https://www.googleapis.com/drive/v3/*` に fetch し、
 * OneCLI MITM proxy (hostPattern=www.googleapis.com) が実 ADC token に
 * 置換する。ADC token は orchestrator Pod 内の drive-token-rotator sidecar が
 * 40min 周期で OneCLI に投入する (Vertex/GH と同流儀)。
 *
 * ## 2 tool (read-only)
 *   - drive_list_files(folder_id?, page_size?) — フォルダ配下 or 共有中の全 file
 *   - drive_get_file(file_id, export_mime?) — Google Docs は text 化、Binary は 5 MiB まで
 *
 * ## エラーメッセージ (silent failure 撲滅)
 * 401/403/404 に対して patron が理解できる日本語 hint を content で返す
 * (agent 側 LLM が summary/reply に組み込む)。log は stderr のみ (stdout は
 * MCP JSON-RPC 専用、汚染すると protocol 破損)。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const MAX_BIN_BYTES = 5 * 1024 * 1024; // 5 MiB (patron 誤発話で巨大 mp4 等を要求されない防衛線)
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

async function driveFetch(url) {
  const res = await fetch(url, {
    headers: { Authorization: 'Bearer placeholder' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const preview = body.slice(0, 300);
    const err = new Error(`Drive API ${res.status}: ${preview}`);
    err.status = res.status;
    err.driveBody = preview;
    throw err;
  }
  return res;
}

function formatError(err) {
  const status = err && typeof err === 'object' ? err.status : undefined;
  let hint = null;
  if (status === 401) {
    hint =
      'Drive token 未注入。OneCLI 経由の Bearer 注入が失敗している可能性 '
      + '(drive-token-rotator sidecar のログを確認、`kubectl logs biblio-orchestrator-0 -c drive-token-rotator`)。';
  } else if (status === 403) {
    hint =
      'Drive フォルダの共有設定を確認。GSA '
      + '`biblio-orchestrator@hajimari-ai-hackathon-2026.iam.gserviceaccount.com` に '
      + '「閲覧者」権限が付いていないと 403 になる。DEN さんに Drive の共有追加を依頼して。';
  } else if (status === 404) {
    hint = 'ファイル / フォルダが存在しない (削除済 or 存在しない ID)。';
  }
  const base = err instanceof Error ? err.message : String(err);
  return hint ? `${base}\n${hint}` : base;
}

const TOOL_LIST = {
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

async function listFiles(args) {
  const folderId
    = typeof args.folder_id === 'string' && args.folder_id.length > 0 ? args.folder_id : null;
  let pageSize = Number.isInteger(args.page_size) ? args.page_size : DEFAULT_PAGE_SIZE;
  if (pageSize < 1) pageSize = 1;
  if (pageSize > MAX_PAGE_SIZE) pageSize = MAX_PAGE_SIZE;

  const params = new URLSearchParams({
    pageSize: String(pageSize),
    fields: 'files(id,name,mimeType,modifiedTime,size),nextPageToken',
  });
  if (folderId) {
    // Drive の q 記法: `'<parent-id>' in parents and trashed=false`
    params.set('q', `'${folderId}' in parents and trashed=false`);
  } else {
    params.set('q', 'trashed=false');
  }
  const url = `${DRIVE_BASE}/files?${params.toString()}`;
  const res = await driveFetch(url);
  return await res.json();
}

async function getFile(args) {
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

  const metaUrl = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`;
  const metaRes = await driveFetch(metaUrl);
  const meta = await metaRes.json();

  const isGoogleDoc
    = typeof meta.mimeType === 'string' && meta.mimeType.startsWith('application/vnd.google-apps.');
  if (isGoogleDoc) {
    const exportUrl = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`;
    const exportRes = await driveFetch(exportUrl);
    const content = await exportRes.text();
    return { ...meta, content, encoding: 'text' };
  }

  // Binary: alt=media で download、5 MiB 制限。
  // meta.size は string で返る (Drive API 仕様)。数値化して guard。
  const size = typeof meta.size === 'string' ? Number(meta.size) : NaN;
  if (Number.isFinite(size) && size > MAX_BIN_BYTES) {
    throw new Error(
      `File size ${size} bytes exceeds 5 MiB limit `
        + `(mimeType=${meta.mimeType})。Google Docs なら export_mime='text/plain' を試すか、`
        + `patron に小さいファイルの指定を依頼せよ。`,
    );
  }
  const downloadUrl = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?alt=media`;
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

async function dispatch(name, args) {
  if (name === 'drive_list_files') return listFiles(args);
  if (name === 'drive_get_file') return getFile(args);
  throw new Error(`Unknown tool: ${name}`);
}

async function main() {
  const server = new Server(
    { name: 'biblio-claw-drive-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.values(TOOL_LIST),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const result = await dispatch(name, args ?? {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const msg = formatError(err);
      // stdio 汚染防止: 診断は stderr のみ、agent への応答は content 経由。
      console.error(`[drive-mcp] ${name} failed: ${msg}`);
      return {
        content: [{ type: 'text', text: msg }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 起動ログは stderr (stdio 汚染防止)。
  console.error('[drive-mcp] Ready (2 tools: drive_list_files, drive_get_file)');
}

main().catch((err) => {
  console.error('[drive-mcp] fatal:', err);
  process.exit(1);
});
