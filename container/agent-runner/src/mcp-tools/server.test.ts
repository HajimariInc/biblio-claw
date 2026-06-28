/**
 * Tests for the MCP server dispatchTool — uniform error containment (issue #51).
 *
 * Contract:
 *   - On success: returns the handler's CallToolResult unchanged.
 *   - On throw: returns { content: [{ type:'text', text:'内部エラー: ...' }], isError: true }
 *     and never re-throws to the SDK.
 *   - On unknown tool: returns a text response without isError.
 */
import { describe, it, expect, afterEach } from 'bun:test';

import { dispatchTool, registerTools, _resetToolsForTest } from './server.js';
import type { McpToolDefinition } from './types.js';

afterEach(() => {
  _resetToolsForTest();
});

describe('dispatchTool — handler error containment', () => {
  it('returns isError response when handler throws', async () => {
    const throwingTool: McpToolDefinition = {
      tool: { name: 'broken_tool', description: '', inputSchema: { type: 'object' } },
      handler: async () => {
        throw new Error('SQLITE_BUSY: database is locked');
      },
    };
    registerTools([throwingTool]);

    const result = await dispatchTool('broken_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    const first = result.content[0] as { type: string; text: string };
    expect(first.type).toBe('text');
    expect(first.text).toContain('内部エラー');
    expect(first.text).toContain('SQLITE_BUSY');
  });

  it('returns normal response when handler succeeds', async () => {
    const okTool: McpToolDefinition = {
      tool: { name: 'ok_tool', description: '', inputSchema: { type: 'object' } },
      handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    };
    registerTools([okTool]);

    const result = await dispatchTool('ok_tool', {});
    expect(result.isError).toBeUndefined();
    const first = result.content[0] as { type: string; text: string };
    expect(first.text).toBe('ok');
  });

  it('returns isError text response for unknown tool', async () => {
    // MCP 仕様: 未知の tool 呼び出しは client error として isError: true を立てる
    // (Claude 側がリカバリ判断できる)。
    const result = await dispatchTool('does_not_exist', {});
    expect(result.isError).toBe(true);
    const first = result.content[0] as { type: string; text: string };
    expect(first.text).toContain('Unknown tool');
    expect(first.text).toContain('does_not_exist');
  });

  it('passes args through to handler unchanged', async () => {
    // dispatchTool が `tool.handler(args)` の args を喪失 (例: `{}` で上書き)
    // するリグレッションを検知する。biblio MCP tool 9 種はすべて args 依存。
    let receivedArgs: Record<string, unknown> | undefined;
    const echoTool: McpToolDefinition = {
      tool: { name: 'echo_tool', description: '', inputSchema: { type: 'object' } },
      handler: async (args) => {
        receivedArgs = args;
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
    };
    registerTools([echoTool]);

    await dispatchTool('echo_tool', { biblio_name: 'foo/bar', category: 'dev' });
    expect(receivedArgs).toEqual({ biblio_name: 'foo/bar', category: 'dev' });
  });

  it('catches non-Error throws (e.g. raw string) without crashing', async () => {
    const stringThrowingTool: McpToolDefinition = {
      tool: { name: 'raw_throw_tool', description: '', inputSchema: { type: 'object' } },
      handler: async () => {
        throw 'raw string failure';
      },
    };
    registerTools([stringThrowingTool]);

    const result = await dispatchTool('raw_throw_tool', {});
    expect(result.isError).toBe(true);
    const first = result.content[0] as { type: string; text: string };
    expect(first.text).toContain('raw string failure');
  });
});
