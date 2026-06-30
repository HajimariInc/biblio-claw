/**
 * AnthropicVertexLlm — ADK `BaseLlm` 継承による Vertex AI × Anthropic Claude wrap (M4-B Phase 0)。
 *
 * `@google/adk@^1.3.0` は Gemini / Apigee 系の `BaseLlm` 実装のみ同梱しており、Anthropic
 * Claude on Vertex AI 経路は自前 wrap が必要 (adk-js v1.3.0 時点の調査で確認: Gemini 系
 * LLM は同梱、Anthropic 経路は自前 wrap 必須)。本クラスは `LLMRegistry.register()` 経由で
 * `LlmAgent({model: 'claude-sonnet-4-6'})` の文字列モデル ID 解決を成立させる ADK 配下
 * hierarchy への最初の足場 (Phase 1 sub-agent 化の前提)。
 *
 * **scope (Phase 0)**:
 *   - `generateContentAsync` の最小実装 (text part のみ抽出、非 streaming): MVP 1 命令完遂の前提
 *   - `connect()` (streaming) は throw NotImplemented (= PRD §作らないもの と整合)
 *   - 自前 span 計装 (= `src/biblio/vertex-client.ts:417-527` の属性設計を踏襲):
 *     - span 名 `chat <model>`、`gen_ai.*` semconv 属性、`extractVertexUsage` 共有は同一
 *     - context propagation: `tracer.startSpan` + `context.with(trace.setSpan(...), ...)` で
 *       SDK 内部の HTTP 自動計装 span が本 span の子として trace 構造に組み込まれる
 *       (= M4-A の「1 trace 串刺し + log↔trace リンク」を ADK 経由でも継続させる)。
 *       writer 元 `callVertexAnthropic` は `tracer.startActiveSpan` を使うが、async generator
 *       内では `startActiveSpan` のコールバック内で `yield` できないため、`startSpan` +
 *       `context.with` の手動経路を採る (= 同等の context propagation を実現)
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
import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
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
import { toAnthropicTools } from './schema-conversion.js';

/**
 * ADK が `generateContentAsync` 抽象 method を export している唯一の型抽出経路。
 * `@google/adk@1.3.0` の `package.json.exports` は `.` のみ許可 (= `models/*` subpath は不可)。
 */
type LlmRequest = Parameters<BaseLlm['generateContentAsync']>[0];
type LlmResponse = ReturnType<BaseLlm['generateContentAsync']> extends AsyncGenerator<infer R, void> ? R : never;

/**
 * `LlmRequest.config` の最小 narrow — Phase 0 では `maxOutputTokens` / `systemInstruction` のみ参照
 * (= `ContentLike` と同じ「Phase 0 で必要なフィールドだけ structural 抽出」流儀)。
 *
 * **Phase 2 で `tools?` 追加** (= 旧 TODO 消化、code-reviewer C1 PR #91 出典):
 *   ADK runner が `appendTools()` で格納する `Array<{ functionDeclarations: FunctionDeclaration[] }>`
 *   の最小 narrow。`generateContentAsync` 内で `toAnthropicTools(config.tools)` を呼んで
 *   Anthropic `Tool[]` に変換し、`messages.create({tools})` へ転送する。これにより LLM が
 *   `acquire_biblio` / `inspect_biblio` / `shelve_biblio` を自律呼出できる経路が成立する。
 *
 *   ADK 1.4.0+ で `parametersJsonSchema` が追加される可能性に備え、`functionDeclarations` 内の
 *   個別 entry は `unknown[]` で narrow を緩く保つ (= structural narrow が壊れないように)、
 *   実際の型 narrow は `schema-conversion.ts` の `AdkFunctionDeclaration` で吸収する。
 */
type LlmRequestConfig = {
  maxOutputTokens?: number;
  systemInstruction?: unknown;
  tools?: Array<{ functionDeclarations?: unknown[] }>;
};

/**
 * Anthropic SDK `messages.create` の戻り値型を抽出 — `@anthropic-ai/sdk` の `Message` 型は
 * subpath export 制限で直接 import 不可 (= `@anthropic-ai/vertex-sdk` 直接依存はあるが
 * `@anthropic-ai/sdk` は transitive)。`Awaited<ReturnType<...>>` 経由で SDK の method
 * signature から型を逆算する (= `LlmRequest` / `LlmResponse` を adk-js の `BaseLlm` 公開面
 * から逆算するのと同じ流儀、`as unknown as` を排除して TypeScript の構造チェックを通す)。
 *
 * SDK overload は streaming/non-streaming で union を返す (= `Stream<RawMessageStreamEvent>
 * | Message`)。Phase 0 は non-streaming 経路のみで `Message` 側を期待するため、`content`
 * フィールドを持つ side だけ `Extract<...>` で narrow する (= Stream には `content` field なし)。
 */
type SdkMessageResponse = Extract<Awaited<ReturnType<AnthropicVertex['messages']['create']>>, { content: unknown }>;

/** region 既定値 — `vertex-client.ts:50` と同値 (CLOUD_ML_REGION 未設定なら global)。 */
const DEFAULT_REGION = 'global';

/**
 * `LlmRequest.contents` の Part 型 — text / functionCall / functionResponse を許容する structural narrow。
 * `@google/genai` の `Part` を直接 import すると transitive dep を package.json 直接依存に昇格する必要が
 * あるため (= plan §Out of Scope)、構造的 narrow で代替。
 *
 * **Phase 2 で functionCall / functionResponse 追加**: multi-turn round-trip 経路で ADK は前回 LLM 応答
 * (= functionCall part) と tool 実行結果 (= functionResponse part) を `contents` に追加してくる。
 * これらを Anthropic API の `tool_use` / `tool_result` block に変換しないと LLM は tool 結果を読まずに
 * 同じ tool を何度も呼ぶ無限ループに陥る。
 */
interface PartLike {
  text?: string;
  functionCall?: { id?: string; name?: string; args?: unknown };
  functionResponse?: { id?: string; name?: string; response?: unknown };
}

interface ContentLike {
  role?: string;
  parts?: PartLike[];
}

/**
 * Anthropic Messages API の content block 形式 (= subpath export 制限で SDK 型を直接 import 不可、
 * structural narrow で代替)。`messages[].content` は `string | ContentBlock[]` の union を許容する。
 */
type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

type AnthropicMessage = { role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] };

/**
 * Phase 1+ で発生する可能性のあるロールマッピング表 — ADK の `Content.role` は将来 `'tool'` /
 * `'function'` / `'system'` 等の拡張が入りうるが、Anthropic Messages API は `'user'` / `'assistant'`
 * の 2 ロールのみを受け付け、かつ連続同一ロールを 400 で拒否する (= "roles must alternate")。
 * 未知ロールは `'user'` に fallback するが、その瞬間 log.warn で可視化し、Phase 1+ で
 * role mapping table の拡張が必要なことを即座に検知できるようにする。
 */
const ASSISTANT_ROLES = new Set(['model', 'assistant']);
const USER_ROLES = new Set(['user']);

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
   * span 計装は既存 `callVertexAnthropic:417-527` と同じ属性設計 (= `chat <model>` 名、
   * `gen_ai.operation.name` / `provider.name` / `request.model` / `server.address` 属性、
   * usage 取得は `extractVertexUsage(_, 'anthropic')` 共有)。SDK 呼出を `context.with` で本 span
   * を active context にした状態でラップすることで、SDK 内部の HTTP 自動計装 span が子としてリンクされる。
   * 失敗時は span.recordException + setStatus(ERROR) + `log.error` + rethrow で M4-A の Cloud Trace ×
   * Logging リンクを継続させ、OTel が degraded fallback でも構造化ログに残るようにする
   * (= biblio-claw §silent failure 撲滅方針: 失敗は必ず throw/log、握り潰さない)。
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
    // span を active context に設定 (= SDK 内部の OTel 計装 span が子としてリンクされる前提)。
    const spanCtx = trace.setSpan(context.active(), span);
    try {
      const messages = this.convertContentsToAnthropicMessages(llmRequest);

      // 空 messages ガード (= Phase 1+ で全 parts が image/audio/function-call のみのとき発火)。
      // Anthropic API は空 messages を 400 で拒否するため、SDK を呼ぶ前に EMPTY_MESSAGES で
      // fail-fast し span にも ERROR を立てる (= silent failure 撲滅)。
      if (messages.length === 0) {
        log.warn('AnthropicVertexLlm: no usable text content in request', {
          event: 'adk.anthropic_vertex_llm.empty_messages',
          outcome: 'empty_messages',
          model: this.model,
        });
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'No text content found in request contents',
        });
        yield {
          errorCode: 'EMPTY_MESSAGES',
          errorMessage: 'No text content found in request contents',
        } as LlmResponse;
        return;
      }

      // `LlmRequest.config` (= `@google/genai` の `GenerateContentConfig`) は version 差で
      // shape が変わるため、structural narrow (`LlmRequestConfig`) で取り出す。
      const config = (llmRequest as { config?: LlmRequestConfig }).config;
      const maxTokens = config?.maxOutputTokens ?? 1024;
      const flatSystem = config?.systemInstruction ? this.flattenSystemInstruction(config.systemInstruction) : '';
      // Phase 2: ADK runner が `appendTools()` で `config.tools` に格納した FunctionDeclaration[] を
      // Anthropic Tool[] (= `{name, description, input_schema}`) に変換する。Schema 変換は
      // `schema-conversion.ts:toAnthropicTools` に集約 (= 純粋関数、unit test で 18 ケース検証済)。
      // 空配列 (= LLM call 時に tools を渡さないモード) のときは下の messages.create 呼出で
      // spread から省略する (= 既存経路を破壊しない)。
      const anthropicTools = toAnthropicTools(config?.tools);
      if (anthropicTools.length > 0) {
        log.debug('AnthropicVertexLlm: passing tools to Anthropic SDK', {
          event: 'adk.anthropic_vertex_llm.tools',
          tool_count: anthropicTools.length,
          tool_names: anthropicTools.map((t) => t.name),
          model: this.model,
        });
      }

      // SDK は abortSignal を `fetchOptions` 経由で受ける設計 (`@anthropic-ai/sdk` 流儀)、
      // `messages.create` の第 2 引数で渡す。`maxRetries` は SDK default (2) に任せる
      // (= 既存 `callVertexAnthropic` は retry なし、Phase 0 は SDK default 流儀に倒す)。
      //
      // `system: ''` は OneCLI proxy 経路で 400 を引き起こすため flatten 後ガードで除外
      // (= `vertex-client.ts:445` と同じ防御パターン)。
      // Phase 2: `tools` は anthropicTools 非空時のみ spread (= 0 件のときは引数省略で既存経路保持)。
      const response: SdkMessageResponse = await context.with(spanCtx, () =>
        this.client.messages.create(
          {
            model: this.model,
            max_tokens: maxTokens,
            messages,
            ...(flatSystem ? { system: flatSystem } : {}),
            ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
          },
          { signal: abortSignal },
        ),
      );

      const usage = extractVertexUsage(response, 'anthropic');
      if (usage.input_tokens != null) span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, usage.input_tokens);
      if (usage.output_tokens != null) span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, usage.output_tokens);
      if (usage.cache_read_input_tokens != null) {
        span.setAttribute(GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, usage.cache_read_input_tokens);
      }

      const llmResponse = this.toLlmResponse(response);
      // EMPTY_TEXT 経路で SDK は成功 HTTP 応答を返すが意味的には失敗 = span ERROR を立てて
      // Cloud Trace UI で「正常 SUCCESS」として記録される silent failure を防ぐ。
      const errorCode = (llmResponse as { errorCode?: string }).errorCode;
      if (errorCode) {
        const errorMessage = (llmResponse as { errorMessage?: string }).errorMessage;
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
      }
      yield llmResponse;
    } catch (err) {
      const errorRecord = err instanceof Error ? err : new Error(String(err));
      span.recordException(errorRecord);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorRecord.message });
      // OTel が degraded fallback (= `instrumentation.ts` の init failure 経路) のとき
      // `span.recordException` / `setStatus` は全部 no-op になるため、構造化ログにも残す
      // (= biblio-claw §silent failure 撲滅方針: 失敗は必ず log、握り潰さない)。
      log.error('AnthropicVertex SDK call failed', {
        event: 'adk.anthropic_vertex_llm.generate',
        outcome: 'failure',
        model: this.model,
        err: errorRecord.message,
      });
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
   * `@google/genai` の `Content[]` (= `[{role, parts: [{text|functionCall|functionResponse}]}]`) を
   * Anthropic SDK が要求する `[{role, content}]` に変換する。
   *
   * **Phase 2 で multi-turn round-trip 対応**:
   *   - text part → 既存通り string `content` (= 簡素化、後方互換)
   *   - functionCall part (= `model` role の前回 LLM 応答) → Anthropic `tool_use` content block
   *     (= `{type:'tool_use', id, name, input}`)。assistant role での content 配列に格納
   *   - functionResponse part (= 前回 tool 実行結果、ADK は `user` role で持ち回る) → Anthropic
   *     `tool_result` content block (= `{type:'tool_result', tool_use_id, content: JSON.stringify(response)}`)。
   *     user role の content 配列に格納
   *   - **multi-part 混在**: 1 message に functionCall + functionResponse / text + functionCall 等の
   *     混在もありうる (= ADK の Content[] は parts 配列)。content 配列に並べる
   *   - text のみの message は string content に簡素化 (= 既存 test との互換性 + Anthropic SDK が
   *     string も配列も同等に処理する仕様)
   *
   * **role mapping**:
   *   - `role: 'model'` → `'assistant'`、`'user'` はそのまま
   *   - 未知ロールは `'user'` に fallback + warn log (= Phase 1+ で role mapping table の拡張)
   *
   * **silent failure 撲滅**:
   *   - 全 parts が空 / 不正の turn は skip (= 空 messages で SDK 400 を避ける)
   *   - tool_use の id/name が文字列でない part は skip
   *   - tool_result の id が文字列でない part は skip
   */
  private convertContentsToAnthropicMessages(llmRequest: LlmRequest): AnthropicMessage[] {
    const contents = (llmRequest as { contents?: ContentLike[] }).contents ?? [];
    const result: AnthropicMessage[] = [];
    for (const c of contents) {
      const originalRole = c.role ?? '(undefined)';
      let mappedRole: 'user' | 'assistant';
      if (ASSISTANT_ROLES.has(c.role ?? '')) {
        mappedRole = 'assistant';
      } else if (USER_ROLES.has(c.role ?? '')) {
        mappedRole = 'user';
      } else {
        log.warn('AnthropicVertexLlm: unsupported role mapped to user', {
          event: 'adk.anthropic_vertex_llm.role_mapping',
          outcome: 'unknown_role_mapped_to_user',
          original_role: originalRole,
        });
        mappedRole = 'user';
      }
      const blocks: AnthropicContentBlock[] = [];
      let textOnly = '';
      let hasNonText = false;
      for (const p of c.parts ?? []) {
        if (!p || typeof p !== 'object') continue;
        if (typeof p.text === 'string' && p.text.length > 0) {
          blocks.push({ type: 'text', text: p.text });
          if (!hasNonText) {
            textOnly = textOnly ? `${textOnly}\n${p.text}` : p.text;
          }
        } else if (p.functionCall) {
          const fc = p.functionCall;
          if (typeof fc.id === 'string' && typeof fc.name === 'string') {
            blocks.push({ type: 'tool_use', id: fc.id, name: fc.name, input: fc.args ?? {} });
            hasNonText = true;
          }
        } else if (p.functionResponse) {
          const fr = p.functionResponse;
          if (typeof fr.id === 'string') {
            // tool_result の content は string (= Anthropic 仕様で `string | ContentBlock[]`)。
            // `response` は ADK 経路で任意 object なので JSON.stringify で string 化する
            // (= silent failure 撲滅、構造を壊さず LLM に渡す)。
            const content = typeof fr.response === 'string' ? fr.response : JSON.stringify(fr.response ?? null);
            blocks.push({ type: 'tool_result', tool_use_id: fr.id, content });
            hasNonText = true;
          }
        }
      }
      if (blocks.length === 0) continue;
      // text-only message は string content に簡素化 (= 既存 Phase 0 / Phase 1 test の compat 維持)
      if (!hasNonText && textOnly.length > 0) {
        result.push({ role: mappedRole, content: textOnly });
      } else {
        result.push({ role: mappedRole, content: blocks });
      }
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
      // 空 string を filter してから join (= 全要素が空のとき `'\n'` 等の偽 truthy 文字列を
      // 返すと caller の C1 ガードを通過して `system: '\n'` が SDK に渡る経路を防ぐ)。
      return systemInstruction
        .map((c) => this.flattenSystemInstruction(c))
        .filter((s) => s.length > 0)
        .join('\n');
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
   * SDK 戻り値 (`@anthropic-ai/sdk` の `Message` 型、`content[].type === 'text'` の最初のブロックを
   * 採用) を ADK の `LlmResponse` (= `@google/genai` の `Content` 型相当) に詰める。
   * `type === 'text'` の最初のブロックを採用 (= 既存 `callVertexAnthropic:489` 流儀、`tool_use` 等が
   * 混ざる経路への防御)。text 不在は `errorCode/errorMessage` で表現し、caller 側で span ERROR を
   * 立てる経路 (= `generateContentAsync` 内で errorCode 検知時に `span.setStatus(ERROR)` 呼出) を取る。
   * テキスト不在自体の `log.warn` もここで吐く (= biblio-claw §silent failure 撲滅: 成功 HTTP 応答だが
   * 意味的失敗のケースを構造化ログで可視化、OTel degraded 状態でも追跡可能)。
   */
  private toLlmResponse(response: SdkMessageResponse): LlmResponse {
    // Phase 2: tool_use block の ADK `functionCall` part 変換を先頭で実施する。
    // text block 抽出に先んじて tool_use を見ることで、Claude が tool 呼出を返したときに
    // EMPTY_TEXT 経路に倒れず ADK runner の `functionCall` event dispatch を成立させる。
    //
    // 設計判断 (Phase 2 plan §意思決定ログ):
    //   - **`id` 保持必須**: Anthropic の multi-turn round-trip では `tool_use_id` を `tool_result`
    //     に紐付ける契約 (= `tool_use_id` 不一致は API 400 で拒否される)。ADK の `functionCall.id`
    //     経路で持ち回ることで Phase 3 で multi-turn 経路が成立可能
    //   - **multi-block 対応**: Claude は 1 turn で複数 tool を同時呼出する経路があるため、
    //     `find()` で先頭 1 件ではなく `filter() + map()` で全 block を `parts` 配列で返す
    //   - type predicate で `id` が string でない block は filter で skip (= silent failure 撲滅)
    // SDK 0.107.0 の `ToolUseBlock` 型は `caller` フィールド必須化があり structural type
    // predicate と型レベルで衝突する (= biblio-claw 視点では `caller` は使わない)。SDK 型と
    // 切り離した structural narrow + 末尾 `as` cast で `id` / `name` / `input` の最小フィールド
    // のみ抽出する (= silent failure 撲滅のため `id` / `name` が string でないものは filter で skip)。
    type ExtractedToolUse = { type: 'tool_use'; id: string; name: string; input: unknown };
    const toolUseBlocks = ((response.content ?? []) as unknown[]).filter((c): c is ExtractedToolUse => {
      if (typeof c !== 'object' || c === null) return false;
      const o = c as { type?: unknown; id?: unknown; name?: unknown };
      return o.type === 'tool_use' && typeof o.id === 'string' && typeof o.name === 'string';
    });
    if (toolUseBlocks.length > 0) {
      log.debug('AnthropicVertexLlm: tool_use blocks detected', {
        event: 'adk.anthropic_vertex_llm.tool_use',
        block_count: toolUseBlocks.length,
        tool_names: toolUseBlocks.map((b) => b.name),
        stop_reason: response.stop_reason ?? 'unknown',
      });
      return {
        content: {
          role: 'model',
          parts: toolUseBlocks.map((b) => ({
            functionCall: { id: b.id, name: b.name, args: b.input },
          })),
        },
      } as LlmResponse;
    }
    const textBlock = response.content?.find((c) => c?.type === 'text');
    const text = textBlock && 'text' in textBlock ? textBlock.text : '';
    if (!text) {
      log.warn('AnthropicVertex returned no text content', {
        event: 'adk.anthropic_vertex_llm.empty_text',
        outcome: 'empty_text',
        model: this.model,
        stop_reason: response.stop_reason ?? 'unknown',
      });
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
