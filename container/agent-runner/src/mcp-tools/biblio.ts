/**
 * biblio MCP tools — acquire_biblio (仕入れ).
 *
 * patron の「仕入れて owner/repo」依頼を捉え、outbound.db に system action を
 * 書いて即返す (fire-and-forget)。実際の取得 (gh / git clone / quarantine 配置) は
 * host 側 (`src/biblio/acquire.ts`) が delivery action `acquire_biblio` で実行し、
 * 結果を inbound.db に書き戻す。agent はそのメッセージで起こされ patron に応答する。
 *
 * = install_packages (self-mod.ts) と同じ「ツールは意図を outbound に書くだけ」パターン。
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const acquireBiblio: McpToolDefinition = {
  tool: {
    name: 'acquire_biblio',
    description:
      'patron の仕入れ依頼を実行する。外部 public な biblio (Claude Code plugin repo) を取得して quarantine に配置する。`repo` に "owner/repo" 短縮形か GitHub URL を渡す。fire-and-forget — 取得結果は後続のメッセージで通知されるので、それを受けて patron に報告すること。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: {
          type: 'string',
          description: '取得対象。"owner/repo" 短縮形 または "https://github.com/owner/repo" URL。',
        },
      },
      required: ['repo'],
    },
  },
  async handler(args) {
    const repo = ((args.repo as string) || '').trim();
    if (!repo) return err('repo を指定してください ("owner/repo" か GitHub URL)。');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'acquire_biblio', repo }),
    });

    log(`acquire_biblio: ${requestId} → ${repo}`);
    return ok(`仕入れリクエストを受け付けました: ${repo}。取得が完了したら結果を通知します。`);
  },
};

registerTools([acquireBiblio]);
