/**
 * AnthropicVertexLlm — ADK `BaseLlm` 継承による Vertex AI × Anthropic Claude wrap (M4-B Phase 0)。
 *
 * `@google/adk@^1.3.0` は Gemini / Apigee 系の `BaseLlm` 実装のみ同梱しており、Anthropic
 * Claude on Vertex AI 経路は自前 wrap が必要 ([[notes-adk-samples]] §wrap 必要性 確証完了)。
 * 本クラスは `LLMRegistry.register()` 経由で `LlmAgent({model: 'claude-sonnet-4-6'})` の
 * 文字列モデル ID 解決を成立させる ADK 配下 hierarchy への最初の足場 (Phase 1 sub-agent 化の前提)。
 *
 * **scope (Phase 0)**:
 *   - `generateContentAsync` の最小実装 (text part のみ抽出、非 streaming): MVP 1 命令完遂の前提
 *   - `connect()` (streaming) は throw NotImplemented (= PRD §作らないもの と整合)
 *   - 自前 span 計装 (= `src/biblio/vertex-client.ts:417-525` の写経): M4-A 観測経路 (1 trace 串刺し +
 *     `gen_ai.*` semconv) を ADK 経由でも継続させる
 *   - keyless ADC 経路: constructor に `accessToken` / `googleAuth` / `authClient` を明示渡さず、
 *     `@anthropic-ai/vertex-sdk` 内部の `google-auth-library@9.x` ADC 解決に委譲
 *     (= PRD 成功指標 §keyless 4 面アサート PASS の前提)
 *
 * **既存 `callVertexAnthropic` との関係** (= `src/biblio/vertex-client.ts:402-527`):
 *   既存 undici raw `:rawPredict` 直叩き経路は M3 機能本体 (categorize.ts 等) の依存先として
 *   Phase 0 では touch しない (= 並行存続)。Phase 1 以降で sub-agent 化に伴い `AnthropicVertexLlm`
 *   経由へ段階的に移行する。本 wrap は SDK `AnthropicVertex.messages.create()` 経由 (= 高位 API、
 *   anthropic_version: 'vertex-2023-10-16' 等の Vertex 固有 wire 詳細は SDK 内部に隠蔽される)。
 *
 * **import path 制限の回避** (= adk-js v1.3.0 `package.json` `exports` の `.` のみ制限):
 *   `LlmRequest` / `LlmResponse` 型は `models/` subpath にしか出ておらず、外部から
 *   `import type { LlmRequest } from '@google/adk/models/llm_request'` 経路は使えない。
 *   `Parameters<BaseLlm['generateContentAsync']>[0]` と `AsyncGenerator<infer R, void>` 抽出で
 *   public surface (= `BaseLlm` 抽象 method signature) から逆算する。上流 adk-js が将来
 *   top-level に re-export したら型 alias を差し替える方針 (= drop-in 互換)。
 */
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { BaseLlm } from '@google/adk';
import type { BaseLlmConnection } from '@google/adk';

import { log } from '../log.js';
import {
  GEN_AI_OPERATION_CHAT,
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_GCP_VERTEX_AI,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  SERVER_ADDRESS,
  extractVertexUsage,
} from '../observability/genai.js';
import { getTracer } from '../observability/index.js';

/**
 * ADK が `generateContentAsync` 抽象 method を export している唯一の型抽出経路。
 * `@google/adk@1.3.0` の `package.json.exports` は `.` のみ許可 (= `models/*` subpath は不可)。
 */
type LlmRequest = Parameters<BaseLlm['generateContentAsync']>[0];
type LlmResponse = ReturnType<BaseLlm['generateContentAsync']> extends AsyncGenerator<infer R, void> ? R : never;

/** region 既定値 — `vertex-client.ts:50` と同値 (CLOUD_ML_REGION 未設定なら global)。 */
const DEFAULT_REGION = 'global';

/**
 * Anthropic SDK `messages.create` の戻り値 — Phase 0 で参照する最小フィールドのみ narrow して保持。
 *
 * `content[].type === 'text'` の最初の要素から `.text` を取り出して `LlmResponse.content.parts[0].text`
 * に詰める (= 既存 `callVertexAnthropic:489` 流儀)。`usage.{input,output,cache_read_input}_tokens` は
 * `extractVertexUsage(_, 'anthropic')` で gen_ai semconv usage 属性に変換する。SDK の型を直接 import
 * すると `MessagesResource` の型変動を吸い込むため、最小 narrow で版差絶縁する。
 */
interface AnthropicVertexMessage {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * `LlmRequest.contents` の最小 narrow — text part のみ抽出する Phase 0 用 (multi-modal は Phase 1+ で拡張)。
 * `@google/genai` の `Content` / `Part` 型を直接 import すると transitive dep を package.json 直接依存に
 * 昇格する必要があるため (= plan §Out of Scope と PRD §作らないもの に整合)、構造的 narrow で代替。
 */
interface ContentLike {
  role?: string;
  parts?: Array<{ text?: string }>;
}

/**
 * `BaseLlm` 継承による Anthropic Claude on Vertex AI ADK wrap。
 *
 * `LLMRegistry.register(AnthropicVertexLlm)` 後、`LlmAgent({model: 'claude-sonnet-4-6'})` の
 * 文字列モデル ID 解決経路で本クラスが instantiate される (= `LLMRegistry.resolve` の
 * `^claude-.*$` regex フルマッチ)。
 */
export class AnthropicVertexLlm extends BaseLlm {
  /**
   * `^claude-.*$` フルマッチで `claude-sonnet-4-6` / `claude-opus-4-X` 等の Anthropic on Vertex
   * モデル ID 全部を受ける (= `LLMRegistry.resolve` の正規表現フルマッチ仕様 `^pattern$`)。
   * `claude-` で始まらない Vertex モデル (= Gemini 系) は別 `BaseLlm` 実装に委ねる
   * (= ADK の `Gemini` クラスが `^gemini-.*$` を取る分業)。
   */
  static override readonly supportedModels: Array<string | RegExp> = [/^claude-.*/];

  private readonly client: AnthropicVertex;
  private readonly region: string;

  constructor({ model }: { model: string }) {
    super({ model });
    this.region = process.env.CLOUD_ML_REGION ?? DEFAULT_REGION;
    // keyless 4 面アサート PASS の前提: accessToken / googleAuth / authClient は明示渡さず
    // SDK 内部の `google-auth-library@9.x` の ADC 解決経路に委譲。`projectId` は env 直渡し
    // (未設定でも SDK 側で `google-auth-library` の `getProjectId()` が走る = local では
    // `gcloud config get core/project` 等から解決される)。
    this.client = new AnthropicVertex({
      region: this.region,
      projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID ?? null,
    });
    log.info('AnthropicVertexLlm initialized', {
      event: 'adk.anthropic_vertex_llm.init',
      model: this.model,
      region: this.region,
      project_id: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
    });
  }

  /**
   * 非 streaming 単発生成。`@google/genai` 型の `LlmRequest.contents` を Anthropic `messages` 形式
   * (`[{role, content}]`) に最小変換し、SDK `messages.create` を叩き、`LlmResponse` に詰めて 1 yield する。
   *
   * span 計装は既存 `callVertexAnthropic:417-525` と同じ structure (= `chat <model>` 名、
   * `gen_ai.operation.name` / `provider.name` / `request.model` / `server.address` 属性、
   * usage 取得は `extractVertexUsage(_, 'anthropic')` 共有)。失敗時は span.recordException +
   * setStatus(ERROR) + rethrow で M4-A の Cloud Trace × Logging リンクを継続させる。
   */
  override async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const tracer = getTracer();
    const span = tracer.startSpan(`${GEN_AI_OPERATION_CHAT} ${this.model}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        [GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_CHAT,
        [GEN_AI_PROVIDER_NAME]: GEN_AI_PROVIDER_GCP_VERTEX_AI,
        [GEN_AI_REQUEST_MODEL]: this.model,
        [SERVER_ADDRESS]: this.serverAddress(),
      },
    });
    try {
      const messages = this.convertContentsToAnthropicMessages(llmRequest);
      // `LlmRequest.config` (= `@google/genai` の `GenerateContentConfig`) は version 差で
      // shape が変わるため、structural narrow で取り出す。`maxOutputTokens` は ADK が一般的に
      // expose する field、`systemInstruction` も同様。共に optional。
      const config = (llmRequest as { config?: { maxOutputTokens?: number; systemInstruction?: unknown } }).config;
      const maxTokens = config?.maxOutputTokens ?? 1024;
      const system = config?.systemInstruction;

      // SDK は abortSignal を `fetchOptions` 経由で受ける設計 (`@anthropic-ai/sdk` 流儀)、
      // `messages.create` の第 2 引数で渡す。`maxRetries` は SDK default (2) に任せる
      // (= 既存 `callVertexAnthropic` は retry なし、Phase 0 は SDK default 流儀に倒す)。
      const response = (await this.client.messages.create(
        {
          model: this.model,
          max_tokens: maxTokens,
          messages,
          ...(system ? { system: this.flattenSystemInstruction(system) } : {}),
        },
        { signal: abortSignal },
      )) as unknown as AnthropicVertexMessage;

      const usage = extractVertexUsage(response, 'anthropic');
      if (usage.input_tokens != null) span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, usage.input_tokens);
      if (usage.output_tokens != null) span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, usage.output_tokens);
      if (usage.cache_read_input_tokens != null) {
        span.setAttribute(GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, usage.cache_read_input_tokens);
      }

      yield this.toLlmResponse(response);
    } catch (err) {
      const errorRecord = err instanceof Error ? err : new Error(String(err));
      span.recordException(errorRecord);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorRecord.message });
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * streaming 経路は Phase 0 scope 外 (= PRD §作らないもの「`AnthropicVertexLlm.connect()` (streaming)
   * 実装」)。MVP 1 命令完遂は `generateContentAsync` で成立するため、ここは throw で
   * silent failure を防ぐ (= 起動時に呼ばれて握り潰されると Phase 1+ の UX 改善が無音に失敗する)。
   */
  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('AnthropicVertexLlm.connect() is not implemented (M4-B Phase 0 scope, see PRD §作らないもの)');
  }

  private serverAddress(): string {
    return this.region === 'global' ? 'aiplatform.googleapis.com' : `${this.region}-aiplatform.googleapis.com`;
  }

  /**
   * `@google/genai` の `Content[]` (= `[{role, parts: [{text}]}]`) を Anthropic SDK が
   * 要求する `[{role, content}]` に変換する最小実装。
   *
   * Phase 0 scope:
   *   - text part のみ抽出 (= multi-modal / function_call は Phase 1+ で sub-agent 化に伴い拡張)
   *   - `role: 'model'` (= Gemini 流儀) は `'assistant'` にマップ (= Anthropic Messages API 流儀)
   *   - parts が複数あれば改行で join (= 1 turn 1 文字列が Anthropic 流儀)
   *   - text が空文字 / 不在の turn は skip (= 空 messages で SDK が 400 を返す経路を避ける)
   */
  private convertContentsToAnthropicMessages(
    llmRequest: LlmRequest,
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    const contents = (llmRequest as { contents?: ContentLike[] }).contents ?? [];
    const result: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const c of contents) {
      const role: 'user' | 'assistant' = c.role === 'model' ? 'assistant' : 'user';
      const text = (c.parts ?? [])
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .filter((t) => t.length > 0)
        .join('\n');
      if (text) result.push({ role, content: text });
    }
    return result;
  }

  /**
   * `@google/genai` の `SystemInstruction` (= `string | Content | Content[]`) を Anthropic
   * SDK の `system` 引数 (string) に平坦化する。
   *
   * Phase 0 では型 narrow で string / Content like / array を分岐、parts の text を join。
   * unknown へ落ちる経路は `JSON.stringify` でフォールバック (= silent に空文字を返すと
   * patron 命令の system context が喪失する罠を避ける)。
   */
  private flattenSystemInstruction(systemInstruction: unknown): string {
    if (typeof systemInstruction === 'string') return systemInstruction;
    if (Array.isArray(systemInstruction)) {
      return systemInstruction.map((c) => this.flattenSystemInstruction(c)).join('\n');
    }
    if (typeof systemInstruction === 'object' && systemInstruction !== null) {
      const parts = (systemInstruction as ContentLike).parts;
      if (Array.isArray(parts)) {
        return parts
          .map((p) => (typeof p.text === 'string' ? p.text : ''))
          .filter((t) => t.length > 0)
          .join('\n');
      }
    }
    return JSON.stringify(systemInstruction);
  }

  /**
   * SDK 戻り値の `content[type=text].text` を取り出して `LlmResponse` (= `@google/genai` の `Content`
   * 型相当) に詰める。`type === 'text'` の最初のブロックを採用 (= 既存 `callVertexAnthropic:489`
   * 流儀、`tool_use` 等が混ざる経路への防御)。text 不在は `errorCode/errorMessage` で表現
   * (= ADK の `LlmResponse` 流儀に整合)。
   */
  private toLlmResponse(response: AnthropicVertexMessage): LlmResponse {
    const textBlock = response.content?.find((c) => c?.type === 'text');
    const text = textBlock?.text ?? '';
    if (!text) {
      return {
        errorCode: 'EMPTY_TEXT',
        errorMessage: `AnthropicVertex returned no text content (stop_reason=${response.stop_reason ?? 'unknown'})`,
      } as LlmResponse;
    }
    return {
      content: { role: 'model', parts: [{ text }] },
    } as LlmResponse;
  }
}
