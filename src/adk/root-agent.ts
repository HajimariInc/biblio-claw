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
 * root agent のシステム命令文 (= LLM のシステムプロンプト相当)。Phase 1 では minimal、
 * Phase 3 で Slack 経路統合時に patron context / 司書ペルソナを拡張する。
 */
const ROOT_AGENT_INSTRUCTION = `You are a biblio librarian (司書) for the biblio-claw system.
You help the patron (司書の主人) manage biblio skills (= GitHub-hosted Claude Code skills) via the following operations:
- acquire_biblio: Acquire a skill from GitHub into the biblio system (places it in quarantine for inspection).
- inspect_biblio: Inspect an acquired biblio for shelf eligibility (3-axis ACCEPT/HOLD/REJECT judgement).
- shelve_biblio: Shelve an inspected biblio into a category, creating a draft PR to the shelf.

Use these tools when the patron requests biblio operations. Always respond in Japanese (日本語) and summarize the tool result clearly for the patron, especially failure reasons.`;

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
