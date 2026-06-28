/**
 * MCP server bootstrap + tool self-registration.
 *
 * Each tool module calls `registerTools([...])` at import time. The
 * barrel (`index.ts`) imports every tool module for side effects, then
 * calls `startMcpServer()` which uses whatever was registered.
 *
 * Default when only `core.ts` is imported: the core `send_message` /
 * `send_file` / `edit_message` / `add_reaction` tools are available.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { McpToolDefinition } from './types.js';
import { log } from '../log.js';

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();

/**
 * Dispatch a single tool call with uniform error containment.
 *
 * Exported as a narrow API so unit tests can exercise the catch path
 * without setting up the full stdio MCP server. handler が throw した場合は
 * `isError: true` の MCP レスポンスへ変換し、agent (Claude) へ診断情報を返す
 * (= patron 経路は agent reply 側で間接通知される、SDK 側へは例外を伝播しない)。
 */
export async function dispatchTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const tool = toolMap.get(name);
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }
  try {
    return await tool.handler(args);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error('mcp tool handler threw', { tool: name, detail });
    return {
      content: [{ type: 'text', text: `内部エラー: ${detail}` }],
      isError: true,
    };
  }
}

/** Test-only: clear registered tools between cases. */
export function _resetToolsForTest(): void {
  allTools.length = 0;
  toolMap.clear();
}

export function registerTools(tools: McpToolDefinition[]): void {
  for (const t of tools) {
    if (toolMap.has(t.tool.name)) {
      log.warn(`tool "${t.tool.name}" already registered, skipping duplicate`);
      continue;
    }
    allTools.push(t);
    toolMap.set(t.tool.name, t);
  }
}

export async function startMcpServer(): Promise<void> {
  const server = new Server({ name: 'nanoclaw', version: '2.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return dispatchTool(name, args ?? {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`MCP server started with ${allTools.length} tools: ${allTools.map((t) => t.tool.name).join(', ')}`);
}
