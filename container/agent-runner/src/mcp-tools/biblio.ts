/**
 * biblio MCP tools — acquire_biblio (仕入れ) / inspect_biblio (検品).
 *
 * patron の「仕入れて owner/repo」/「検品して」依頼を捉え、outbound.db に system action
 * を書いて即返す (fire-and-forget)。実際の処理 (acquire は gh/git clone + quarantine 配置 /
 * inspect は 3 軸判定) は host 側 (`src/biblio/acquire.ts` / `src/biblio/inspect.ts`) が
 * delivery action で実行し、結果を inbound.db に書き戻す。agent はそのメッセージで
 * 起こされ patron に応答する。
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

export const inspectBiblio: McpToolDefinition = {
  tool: {
    name: 'inspect_biblio',
    description:
      'quarantine に置かれた biblio を 3 軸 (schema → license → dangerous) で検品する。`name` に acquire_biblio が返した biblio 名 (= `<owner>--<repo>` 形式) を渡す。fire-and-forget — 判定結果 (ACCEPT / HOLD / REJECT + 理由) は後続のメッセージで通知されるので、それを受けて patron に報告すること。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: '検品対象の biblio 名 (`/data/quarantine/<name>/` 配下に存在すること)。',
        },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = ((args.name as string) || '').trim();
    if (!name) return err('name を指定してください (検品対象の biblio 名)。');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'inspect_biblio', name }),
    });

    log(`inspect_biblio: ${requestId} → ${name}`);
    return ok(`検品リクエストを受け付けました: ${name}。判定が完了したら結果を通知します。`);
  },
};

export const categorizeBiblio: McpToolDefinition = {
  tool: {
    name: 'categorize_biblio',
    description:
      '検品 ACCEPT 済の biblio を 4 namespace (biblio-dev/art/bf/ai) に分類する。`name` に biblio 名 (`<owner>--<repo>` 形式) を渡す。fire-and-forget — 判定結果 (カテゴリ + 理由) は後続のメッセージで通知されるので、それを受けて patron に「カテゴリは X、進めますか?」を確認すること。patron から「はい」または別カテゴリ指定が返ってきたら shelve_biblio を呼ぶ。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'カテゴライズ対象の biblio 名 (`/data/quarantine/<name>/` 配下に存在すること)。',
        },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = ((args.name as string) || '').trim();
    if (!name) return err('name を指定してください (カテゴライズ対象の biblio 名)。');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'categorize_biblio', name }),
    });

    log(`categorize_biblio: ${requestId} → ${name}`);
    return ok(`カテゴライズリクエストを受け付けました: ${name}。判定が完了したら結果を通知します。`);
  },
};

export const shelveBiblio: McpToolDefinition = {
  tool: {
    name: 'shelve_biblio',
    description:
      'カテゴライズ承認済の biblio を棚リポ HajimariInc/biblio-shelf に陳列する。`name` (biblio 名 `<owner>--<repo>`) + `category` (biblio-dev|art|bf|ai) + `reason` (カテゴライズ判定理由 = commit/PR body に埋め込まれる) を渡す。fire-and-forget — 物理移動 + draft PR 作成が完了したら後続のメッセージで PR URL が通知されるので、それを patron に渡し「手動 merge をお願いします」と伝える。重複検知 (既存 entry あり) なら `already shelved` 応答が返る。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: '陳列対象の biblio 名 (`/data/quarantine/<name>/` 配下に存在すること、`<owner>--<repo>` 形式)。',
        },
        category: {
          type: 'string',
          enum: ['biblio-dev', 'biblio-art', 'biblio-bf', 'biblio-ai'],
          description: '陳列先の 4 namespace のいずれか (categorize_biblio の判定結果を patron が承認 or 変更したもの)。',
        },
        reason: {
          type: 'string',
          description: 'カテゴライズ判定の理由 (= commit/PR body に埋め込まれる)。空でも可。',
        },
      },
      required: ['name', 'category'],
    },
  },
  async handler(args) {
    const name = ((args.name as string) || '').trim();
    const category = ((args.category as string) || '').trim();
    const reason = ((args.reason as string) || '').trim();
    if (!name) return err('name を指定してください (陳列対象の biblio 名)。');
    if (!category) return err('category を指定してください (biblio-dev|art|bf|ai のいずれか)。');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'shelve_biblio', name, category, reason }),
    });

    log(`shelve_biblio: ${requestId} → ${name} / ${category}`);
    return ok(`陳列リクエストを受け付けました: ${name} → ${category}。PR 作成が完了したら結果を通知します。`);
  },
};

registerTools([acquireBiblio, inspectBiblio, categorizeBiblio, shelveBiblio]);
