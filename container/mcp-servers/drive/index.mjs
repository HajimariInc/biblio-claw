#!/usr/bin/env node
/**
 * biblio-claw Drive MCP server (M4-F Phase 3: life-capabilities)
 *
 * agent-container 内で spawn される独立 Node 22 stdio MCP server。
 * agent-runner (Bun) 内で fetch() を叩かない設計 (= oven-sh/bun#30381 の
 * HTTPS-over-CONNECT-proxy バグ回避) の一環として、Drive API への到達を
 * 本 server (Node 22) に集約する。
 *
 * ## 構成
 * 純粋ロジック (driveFetch / formatError / listFiles / getFile / dispatch /
 * TOOL_LIST) は `logic.mjs` に分離。本 file は stdio transport の薄い wiring
 * のみを担う (testability を確保するため、`mcp-env-overlay.ts` と同流儀の分離)。
 * `logic.test.mjs` から fake `globalThis.fetch` を差し替えて 401/403/404 分岐 +
 * timeout + Google Docs / Binary 分岐等を unit test で検証できる。
 *
 * ## 認可の集約 (命題 2)
 * 実 ADC token は持たない。全リクエストに `Authorization: Bearer placeholder`
 * ヘッダを付けて `https://www.googleapis.com/drive/v3/*` に fetch し、
 * OneCLI MITM proxy (hostPattern=www.googleapis.com) が実 ADC token に置換する。
 *
 * ## エラー診断
 * tool-call 単位で失敗した場合、agent 側応答は `content` + `isError:true` で
 * 日本語 hint を返す (patron が対処可能な情報)。診断用の raw error (`err.cause`
 * を含む system error 情報) は stderr に集約する (stdio 汚染防止で stdout は
 * MCP JSON-RPC 専用)。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { TOOL_LIST, dispatch, formatError } from './logic.mjs';

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
      // stderr に raw error + cause を残す (stdout 汚染防止で agent への応答は
      // content 経由のみ、診断は stderr に集約 = 6 ヶ月後の debug で cause 情報を
      // 追跡可能にする)。
      const causeDiag
        = err && typeof err === 'object' && 'cause' in err && err.cause
          ? ` (cause: ${JSON.stringify(err.cause, Object.getOwnPropertyNames(err.cause))})`
          : '';
      console.error(`[drive-mcp] ${name} failed: ${msg}${causeDiag}`);
      return {
        content: [{ type: 'text', text: msg }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[drive-mcp] Ready (2 tools: drive_list_files, drive_get_file)');
}

main().catch((err) => {
  console.error('[drive-mcp] fatal:', err);
  process.exit(1);
});
