/**
 * root `LlmAgent` factory — biblio-claw 司書 root agent の構築 (M4-B Phase 1)。
 *
 * `LLMRegistry.register(AnthropicVertexLlm)` 完了後 (= `registerAnthropicVertexLlm()` 経由) に
 * `buildRootAgent()` を呼ぶと、`new LlmAgent({model: 'claude-sonnet-4-6', tools: [...]})` で
 * Anthropic Claude on Vertex AI が `LLMRegistry.resolve()` 経由で解決され、`acquire_biblio` /
 * `inspect_biblio` / `shelve_biblio` の 3 FunctionTool が LLM の自律選択対象として登録される。
 *
 * **設計判断 (Phase 1 plan §意思決定ログ)**:
 *   - `subAgents` は不採用 (= `tools` 経路で MVP 成立、LLM-controlled transfer は Phase 4 以降で再評価)
 *   - `name: 'biblio_root_agent'` は ADK の `^[\p{ID_Start}$_][\p{ID_Continue}$_-]*$/u` valid
 *     (= snake_case + 数字、`'user'` は ADK で予約済のため不可)
 *   - `instruction` は minimal (= LLM に tool 使用と日本語応答を指示)、Phase 3 で Slack 経路統合時に拡張
 *   - factory function 化 (= `new LlmAgent(...)` を module-scope に書くと import 時に
 *     Vertex SDK の認証解決が走り test 環境の mock 順序問題を引き起こす罠を回避)
 */
import { LlmAgent } from '@google/adk';

import { acquireBiblioTool } from './tools/acquire-tool.js';
import { inspectBiblioTool } from './tools/inspect-tool.js';
import { shelveBiblioTool } from './tools/shelve-tool.js';

/**
 * root agent のシステム命令文 (= LLM のシステムプロンプト相当)。
 *
 * Phase 3 で CLI + Slack 両経路統合版に拡張 (Phase 1 の minimal 版を patron context /
 * 応答フォーマット / 失敗理由伝達の 3 軸で強化)。CLI stdout / Slack UI どちらでも
 * 読める平文 + 軽量絵文字、コードブロックは使わない (= Slack で code block が視覚
 * ノイズになる + CLI stdout でも重要ではない)。
 *
 * サイズ目安: ~500 words 以下 (input tokens コスト最小化)。
 */
const ROOT_AGENT_INSTRUCTION = `あなたは biblio-claw システムの司書 (librarian) です。patron (司書の主人) の指示に従い、biblio (= GitHub でホストされた Claude Code skill) を扱う 3 種類の tool を選択的に呼び出してください。

## 利用可能な tool

- **acquire_biblio**: 指定 GitHub repo から biblio を取得し quarantine ディレクトリに配置する (仕入れ)。入力は "owner/repo" 形式または "owner/repo/skill" 形式または GitHub URL。
- **inspect_biblio**: 取得済 biblio を 3 軸 (schema / license / dangerous code) で検品する。入力は acquire_biblio が返した biblioName ("owner--repo" or "owner--repo--skill" 形式) をそのまま渡す。verdict は ACCEPT / HOLD / REJECT。
- **shelve_biblio**: 検品済 biblio を category に陳列する (draft PR を棚 repo に作成)。

## 応答方針

- **必ず日本語で応答してください** (patron は日本語話者)。
- 応答は簡潔に。1 段落 + 必要なら短い箇条書き。長い前置きや自己紹介は不要。
- tool 呼出後は、成功/失敗を明確に伝えて要点を要約する。JSON をそのまま出力せず、patron が読んで判断できる形に整形する。
- 失敗時は理由を必ず含める (例: "検品で REJECT: schema_invalid — .claude-plugin/plugin.json が見つかりません")。
- 絵文字は控えめに使ってよい (例: 仕入れ完了 📦、検品成功 ✅、失敗 ⚠️)。過剰使用は避ける。
- コードブロック (\`\`\`) は原則使わない (Slack でノイズ、CLI でも冗長)。
- 応答フォーマット: 平文 + 短い箇条書き。Markdown 見出し (#, ##) は避ける (CLI stdout に不要)。

## 判断規範

- patron が "@bot 仕入れて owner/repo" 等と明示的に指示した時のみ tool を呼び出す。曖昧な発話 (例: "調子どう?") には tool 呼出せず日本語で会話。
- tool 呼出は必要最小限。1 命令 = 1 tool が原則。連鎖処理 (acquire → inspect → shelve) は patron が明示要求した場合のみ順次実行。
- 内部エラー時 (例: LLM API 失敗、ADK error event) は "エラー: LLM 呼び出しに失敗しました。しばらくして再度お試しください。" 等の user-friendly なメッセージで応答する (dispatcher 側で fallback 済のためあなたが直接返す必要は通常ない)。`;

/**
 * root `LlmAgent` factory。
 *
 * Phase 1 では `scripts/verify-phase-1-adk-local.ts` でのみ呼ばれる。Phase 2 で GKE 上で、
 * Phase 3 で Slack inbound 経路から呼ばれる。本 factory を共有することで Phase 横断で
 * 同一 agent 構成を保証する。
 */
export function buildRootAgent(): LlmAgent {
  return new LlmAgent({
    model: 'claude-sonnet-4-6',
    name: 'biblio_root_agent',
    description: 'Root agent for biblio-claw librarian operations',
    instruction: ROOT_AGENT_INSTRUCTION,
    tools: [acquireBiblioTool, inspectBiblioTool, shelveBiblioTool],
  });
}
