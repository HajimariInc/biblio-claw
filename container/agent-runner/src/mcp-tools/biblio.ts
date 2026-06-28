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
import { log } from '../log.js';

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
      'patron の仕入れ依頼を実行する。外部 public な biblio (Claude Code plugin repo) を取得して quarantine に配置する。`repo` に "owner/repo" 短縮形か GitHub URL を渡す。patron が "owner/repo/skill" のように 3 segments で個別 skill を指定した場合は、skill 部分 (= kebab-case 単一識別子) を別 arg `skill` に分離して渡す (例: `repo: "anthropics/skills"`, `skill: "algorithmic-art"`)。fire-and-forget — 取得結果は後続のメッセージで通知されるので、それを受けて patron に報告すること。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: {
          type: 'string',
          description: '取得対象。"owner/repo" 短縮形 または "https://github.com/owner/repo" URL。',
        },
        skill: {
          type: 'string',
          description:
            '個別 skill 仕入れ指定 (任意)。patron が "owner/repo/skill" 形式で指定した場合、skill 部分 (= 主に kebab-case、許容文字は `[A-Za-z0-9._-]`、先頭は英数の単一識別子) を本 arg に分離して渡す。"owner/repo" 全体仕入れの場合は省略。',
        },
      },
      required: ['repo'],
    },
  },
  async handler(args) {
    const repo = ((args.repo as string) || '').trim();
    const skill = ((args.skill as string) || '').trim() || undefined;
    if (!repo) return err('repo を指定してください ("owner/repo" か GitHub URL)。');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'acquire_biblio',
        repo,
        ...(skill ? { skill } : {}),
      }),
    });

    const target = skill ? `${repo}/${skill}` : repo;
    log.info('mcp.acquire_biblio', {
      event: 'mcp.biblio.acquire',
      request_id: requestId,
      target,
    });
    return ok(`仕入れリクエストを受け付けました: ${target}。取得が完了したら結果を通知します。`);
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

    log.info('mcp.inspect_biblio', {
      event: 'mcp.biblio.inspect',
      request_id: requestId,
      biblio_name: name,
    });
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

    log.info('mcp.categorize_biblio', {
      event: 'mcp.biblio.categorize',
      request_id: requestId,
      biblio_name: name,
    });
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

    log.info('mcp.shelve_biblio', {
      event: 'mcp.biblio.shelve',
      request_id: requestId,
      biblio_name: name,
      category,
    });
    return ok(`陳列リクエストを受け付けました: ${name} → ${category}。PR 作成が完了したら結果を通知します。`);
  },
};

export const shelveBiblioMulti: McpToolDefinition = {
  tool: {
    name: 'shelve_biblio_multi',
    description:
      'Phase 4 — **複数 skill を複数 category に跨って 1 PR で陳列**する。1 仕入れリクエスト内で各 skill のカテゴリ判定が異なるケース (例: 同じ repo 内に dev 系 + art 系が混在) に使う。`items` 配列の各要素に `name` (biblio 名、`<owner>--<repo>` または `<owner>--<repo>--<skill>` 形式) + `category` (biblio-dev|art|bf|ai) + `reason` (per-skill の categorize 判定理由) を渡す。**単一 skill / 単一 category なら `shelve_biblio` を使うこと** (= 既存単一 PR 経路で十分)。**運用上限**: `items` は最大 10 件目安 (= 合算 file 数が `MAX_BLOBS_PER_PR=100` 内に収まる目安。実際の hard limit は blob 数上限のみ、件数 hard limit はなし)。**原子性**: N 件すべて陳列 or 0 件陳列の二択 (= 部分成功なし、重複検知 1 件でも全体 fail)。fire-and-forget — PR URL + 内訳は後続のメッセージで通知されるので、それを patron に渡し「手動 merge をお願いします」と伝える。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        items: {
          type: 'array' as const,
          minItems: 1,
          description: '陳列対象の配列。各 item に name + category + reason を含める (1 件以上、目安 10 件以内)。',
          items: {
            type: 'object' as const,
            properties: {
              name: {
                type: 'string',
                description:
                  '陳列対象の biblio 名 (`<owner>--<repo>` または `<owner>--<repo>--<skill>` 形式、`/data/quarantine/<name>/` 配下に存在すること)。',
              },
              category: {
                type: 'string',
                enum: ['biblio-dev', 'biblio-art', 'biblio-bf', 'biblio-ai'],
                description:
                  '陳列先の 4 namespace のいずれか (= per-skill categorize_biblio の判定結果を patron が承認した値)。',
              },
              reason: {
                type: 'string',
                description: 'per-skill の categorize 判定理由 (= commit/PR body の category 別 section に埋め込まれる)。空でも可。',
              },
            },
            required: ['name', 'category'],
          },
        },
      },
      required: ['items'],
    },
  },
  async handler(args) {
    const rawItems = args.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return err('items を指定してください (1 件以上の {name, category, reason} を含む配列)。');
    }
    // tool 側では shape の基本チェックだけ行い、本格 validate は host 側 delivery action で再実施。
    const items: Array<{ name: string; category: string; reason: string }> = [];
    for (const [i, raw] of rawItems.entries()) {
      if (typeof raw !== 'object' || raw === null) {
        return err(`items[${i}] が object ではありません。`);
      }
      const obj = raw as Record<string, unknown>;
      const name = ((obj.name as string) || '').trim();
      const category = ((obj.category as string) || '').trim();
      const reason = ((obj.reason as string) || '').trim();
      if (!name) return err(`items[${i}].name を指定してください。`);
      if (!category) return err(`items[${i}].category を指定してください (biblio-dev|art|bf|ai のいずれか)。`);
      items.push({ name, category, reason });
    }

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'shelve_biblio_multi', items }),
    });

    const summary = items.map((it) => `${it.name}→${it.category}`).join(', ');
    log.info('mcp.shelve_biblio_multi', {
      event: 'mcp.biblio.shelve_multi',
      request_id: requestId,
      count: items.length,
      summary,
    });
    return ok(
      `複数陳列リクエストを受け付けました: ${items.length} 件 (${summary})。1 PR にまとめて作成が完了したら結果を通知します。`,
    );
  },
};

export const enkinBiblio: McpToolDefinition = {
  tool: {
    name: 'enkin_biblio',
    description:
      '禁書: 棚から biblio を除去するが装備源 (`/workspace/biblios/<name>/` の本物実体) は残置する (= 再装備可)。`name` (biblio 名 `<owner>--<repo>`) + `category` (biblio-dev|art|bf|ai、shelve 時に決めた値) を渡す。**破壊操作なので host 側で admin (DEN) 承認を経由する** — 承認後に shelf 側へ削除方向の draft PR が立ち、PR URL が後続のメッセージで通知される。fire-and-forget。装備リストの変更は本 tool では行わない (= 禁書後も装備源 dir が残るため次 spawn でも biblio は装備される。物理削除して再装備不可にしたい場合は shokyaku_biblio を使うこと)。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: '禁書対象の biblio 名 (`<owner>--<repo>` 形式、棚に陳列済であること)。',
        },
        category: {
          type: 'string',
          enum: ['biblio-dev', 'biblio-art', 'biblio-bf', 'biblio-ai'],
          description: '禁書対象の category (= shelve 時の値、shelf 上の path 計算に必要)。',
        },
      },
      required: ['name', 'category'],
    },
  },
  async handler(args) {
    const name = ((args.name as string) || '').trim();
    const category = ((args.category as string) || '').trim();
    if (!name) return err('name を指定してください (禁書対象の biblio 名)。');
    if (!category) return err('category を指定してください (biblio-dev|art|bf|ai のいずれか)。');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'enkin_biblio', name, category }),
    });

    log.info('mcp.enkin_biblio', {
      event: 'mcp.biblio.enkin',
      request_id: requestId,
      biblio_name: name,
      category,
    });
    return ok(`禁書リクエストを受け付けました: ${name} (${category})。admin 承認後に PR が立ったら通知します。`);
  },
};

export const shokyakuBiblio: McpToolDefinition = {
  tool: {
    name: 'shokyaku_biblio',
    description:
      '焼却: 棚から biblio を除去し、装備源 (`/workspace/biblios/<name>/` の本物実体) も物理削除する (= 再装備不可)。`name` (biblio 名 `<owner>--<repo>`) + `category` (biblio-dev|art|bf|ai、shelve 時に決めた値) を渡す。**破壊操作なので host 側で admin (DEN) 承認を経由する** — 承認後に shelf 側へ削除方向の draft PR が立ち + host の装備源 dir が `fs.rmSync` で物理削除される。装備リストからも全 session で個別削除される (= 次回 spawn 以降の warn ノイズ抑制)。fire-and-forget — PR URL は後続のメッセージで通知される。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: '焼却対象の biblio 名 (`<owner>--<repo>` 形式、棚に陳列済であること)。',
        },
        category: {
          type: 'string',
          enum: ['biblio-dev', 'biblio-art', 'biblio-bf', 'biblio-ai'],
          description: '焼却対象の category (= shelve 時の値、shelf 上の path 計算に必要)。',
        },
      },
      required: ['name', 'category'],
    },
  },
  async handler(args) {
    const name = ((args.name as string) || '').trim();
    const category = ((args.category as string) || '').trim();
    if (!name) return err('name を指定してください (焼却対象の biblio 名)。');
    if (!category) return err('category を指定してください (biblio-dev|art|bf|ai のいずれか)。');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'shokyaku_biblio', name, category }),
    });

    log.info('mcp.shokyaku_biblio', {
      event: 'mcp.biblio.shokyaku',
      request_id: requestId,
      biblio_name: name,
      category,
    });
    return ok(`焼却リクエストを受け付けました: ${name} (${category})。admin 承認後に PR が立ったら通知します。`);
  },
};

export const updateConfig: McpToolDefinition = {
  tool: {
    name: 'update_config',
    description:
      'biblio 設定値を動的変更する (= 個別 PRD Phase 5 dynamic-config)。**patron が「@bot 設定 KEY VALUE」「設定変更して」「閾値を 20 にして」「ACQUIRE_SKILL_THRESHOLD を 25 に変更」等の自然文で依頼したら呼ぶ**。変更は次の仕入れ依頼 (= `@bot 仕入れて`) から即時反映される (= 再起動不要)。**変更可能 key の allowlist** (whitelist 方式、これ以外は host 側で reject される): `ACQUIRE_SKILL_THRESHOLD` (= 仕入先 repo の skill 数閾値、超過時は patron に個別指定を促す)。`ACQUIRE_SKILL_THRESHOLD` の value は 1 以上の整数 string (例: "25")。**権限**: `user_roles` table が存在する場合は、該当 agent group に admin / owner が紐づくときのみ実行可能 (= 居なければ host 側で reject)。単独運用 / permissions モジュール未インストール環境 (= `user_roles` table 不在) では制限なし (allow-all)。fire-and-forget — 設定完了 or 失敗理由は後続のメッセージで通知されるので、それを patron に渡すこと。**注意**: 他の設定 key (例: `MAX_BLOBS_PER_PR` / `CATEGORIZE_MODEL` 等) は本 tool 経由では変更できない (allowlist 外)。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        key: {
          type: 'string',
          enum: ['ACQUIRE_SKILL_THRESHOLD'],
          description: '変更する設定キー。allowlist 内の値のみ受理 (現状は ACQUIRE_SKILL_THRESHOLD のみ)。',
        },
        value: {
          type: 'string',
          description:
            '設定する値 (文字列。閾値の場合は正整数を string で渡す、例: "25")。空文字 / 空白のみは host 側で reject される。',
        },
      },
      required: ['key', 'value'],
    },
  },
  async handler(args) {
    const key = ((args.key as string) || '').trim();
    const value = ((args.value as string) || '').trim();
    if (!key) return err('key を指定してください (allowlist: ACQUIRE_SKILL_THRESHOLD)。');
    if (!value) return err('value を指定してください (= 空文字 / 空白は不可)。');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'update_config', key, value }),
    });

    log.info('mcp.update_config', {
      event: 'mcp.biblio.config',
      request_id: requestId,
      key,
      value,
    });
    return ok(`設定変更リクエストを受け付けました: ${key} = ${value}。結果が確定したら通知します。`);
  },
};

export const listBiblio: McpToolDefinition = {
  tool: {
    name: 'list_biblio',
    description:
      '棚 (HajimariInc/biblio-shelf) の marketplace.json から蔵書一覧を取得する。**patron が「蔵書」「蔵書一覧」「biblio list」「棚に何が並んでる」「biblio-dev だけ教えて」等の依頼を投げたら呼ぶ**。`category` 引数で 4 namespace (biblio-dev|art|bf|ai) のいずれかに絞り込める (省略時は全件)。fire-and-forget — 蔵書一覧 + カテゴリ別カウントの整形済テキストは後続のメッセージで通知されるので、それを受けて patron に渡すこと (= host 側で整形済なので原則そのまま流せる)。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          enum: ['biblio-dev', 'biblio-art', 'biblio-bf', 'biblio-ai'],
          description: '絞り込み対象の 4 namespace のいずれか。省略時は全件を返す。',
        },
      },
      required: [],
    },
  },
  async handler(args) {
    // category は optional。型ガード後にそのまま action に渡す (= 妥当性は host 側で再 validate)。
    const category = typeof args.category === 'string' ? args.category.trim() : '';
    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'list_biblio', category }),
    });

    log.info('mcp.list_biblio', {
      event: 'mcp.biblio.list',
      request_id: requestId,
      category: category || '(all)',
    });
    return ok(
      `蔵書リクエストを受け付けました${category ? ` (category=${category})` : ''}。一覧が揃ったら結果を通知します。`,
    );
  },
};

registerTools([
  acquireBiblio,
  inspectBiblio,
  categorizeBiblio,
  shelveBiblio,
  shelveBiblioMulti,
  enkinBiblio,
  shokyakuBiblio,
  listBiblio,
  updateConfig,
]);
