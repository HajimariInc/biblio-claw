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
 * TODO(M4-B Phase 2): `tools?: unknown[]` を追加し、`generateContentAsync` 内で `config.tools` を読んで
 * `messages.create()` に転送する経路を実装する。Phase 1 完了時点で本フィールド未対応により ADK runner
 * から渡される `FunctionDeclaration[]` が Anthropic API に届かず、Claude は `acquire_biblio` /
 * `inspect_biblio` / `shelve_biblio` の存在を知らないまま応答する状態 (= LLM 自律 tool 呼出経路が
 * 構造的に成立しない)。詳細は M4-B PRD §「Phase 1 完了時の発見 (= Phase 2 必須前提)」§未対応 1 参照、
 * code-reviewer C1 (PR #91) を出典。
 */
type LlmRequestConfig = { maxOutputTokens?: number; systemInstruction?: unknown };

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
 * `LlmRequest.contents` の最小 narrow — text part のみ抽出する Phase 0 用 (multi-modal は Phase 1+ で拡張)。
 * `@google/genai` の `Content` / `Part` 型を直接 import すると transitive dep を package.json 直接依存に
 * 昇格する必要があるため (= plan §Out of Scope と PRD §作らないもの に整合)、構造的 narrow で代替。
 */
interface ContentLike {
  role?: string;
  parts?: Array<{ text?: string }>;
}

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
      // TODO(M4-B Phase 2): config.tools (= ADK runner が appendTools で格納する FunctionDeclaration[]) を
      // 読み取り、Anthropic `messages.create({tools: [...]})` 形式に変換して下の SDK 呼出に渡す。
      // 現状は本変換が無いため Claude は tool 定義を受け取らず LLM 自律 tool 呼出が成立しない。
      // 詳細は M4-B PRD §「Phase 1 完了時の発見」§未対応 1。

      // SDK は abortSignal を `fetchOptions` 経由で受ける設計 (`@anthropic-ai/sdk` 流儀)、
      // `messages.create` の第 2 引数で渡す。`maxRetries` は SDK default (2) に任せる
      // (= 既存 `callVertexAnthropic` は retry なし、Phase 0 は SDK default 流儀に倒す)。
      //
      // `system: ''` は OneCLI proxy 経路で 400 を引き起こすため flatten 後ガードで除外
      // (= `vertex-client.ts:445` と同じ防御パターン)。
      const response: SdkMessageResponse = await context.with(spanCtx, () =>
        this.client.messages.create(
          {
            model: this.model,
            max_tokens: maxTokens,
            messages,
            ...(flatSystem ? { system: flatSystem } : {}),
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
   * `@google/genai` の `Content[]` (= `[{role, parts: [{text}]}]`) を Anthropic SDK が
   * 要求する `[{role, content}]` に変換する最小実装。
   *
   * Phase 0 scope:
   *   - text part のみ抽出 (= multi-modal / function_call は Phase 1+ で sub-agent 化に伴い拡張)
   *   - `role: 'model'` (= Gemini 流儀) は `'assistant'` にマップ、`'user'` はそのまま
   *   - 未知ロール (`'tool'` / `'function'` / `'system'` / undefined) は `'user'` に fallback
   *     しつつ `log.warn` で可視化 (Phase 1+ で role mapping table の拡張が必要)
   *   - parts が複数あれば改行で join (= 1 turn 1 文字列が Anthropic 流儀)
   *   - text が空文字 / 不在の turn は skip (= 空 messages で SDK が 400 を返す経路を避ける)
   */
  private convertContentsToAnthropicMessages(
    llmRequest: LlmRequest,
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    const contents = (llmRequest as { contents?: ContentLike[] }).contents ?? [];
    const result: Array<{ role: 'user' | 'assistant'; content: string }> = [];
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
      const text = (c.parts ?? [])
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .filter((t) => t.length > 0)
        .join('\n');
      if (text) result.push({ role: mappedRole, content: text });
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
    // TODO(M4-B Phase 2): tool_use block の ADK functionCall 変換を本メソッドの先頭に追加すること。
    // 現状 text block のみ抽出するため、Claude が tool_use を返しても EMPTY_TEXT 経路に倒れ、
    // ADK の functionCall event 経路が起動しない (= LLM 自律 tool 呼出経路の構造的未成立)。
    // 期待する追加コード:
    //   const toolUseBlock = response.content?.find((c) => c?.type === 'tool_use');
    //   if (toolUseBlock && 'id' in toolUseBlock) {
    //     return { content: { role: 'model', parts: [{ functionCall: { name: toolUseBlock.name, args: toolUseBlock.input } }] } } as LlmResponse;
    //   }
    // 詳細は M4-B PRD §「Phase 1 完了時の発見」§未対応 2、code-reviewer C1 (PR #91) を出典。
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
