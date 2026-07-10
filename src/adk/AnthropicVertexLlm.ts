/**
 * AnthropicVertexLlm — ADK `BaseLlm` 継承による Vertex AI × Anthropic Claude wrap。
 *
 * `@google/adk@^1.3.0` は Gemini / Apigee 系の `BaseLlm` 実装のみ同梱しており、Anthropic
 * Claude on Vertex AI 経路は自前 wrap が必要 (adk-js v1.3.0 時点の調査で確認: Gemini 系
 * LLM は同梱、Anthropic 経路は自前 wrap 必須)。本クラスは `LLMRegistry.register()` 経由で
 * `LlmAgent({model: 'claude-sonnet-4-6'})` の文字列モデル ID 解決を成立させる ADK 配下
 * hierarchy への最初の足場。
 *
 * **scope**:
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
 *   既存 undici raw `:rawPredict` 直叩き経路は categorize.ts 等の依存先として並行存続。
 *   段階的に `AnthropicVertexLlm` 経由へ移行する。本 wrap は SDK `AnthropicVertex.messages.create()`
 *   経由 (= 高位 API、anthropic_version: 'vertex-2023-10-16' 等の Vertex 固有 wire 詳細は
 *   SDK 内部に隠蔽される)。
 *
 * **import path 制限の回避** (= adk-js v1.3.0 `package.json` `exports` の `.` のみ制限):
 *   `LlmRequest` / `LlmResponse` 型は `models/` subpath にしか出ておらず、外部から
 *   `import type { LlmRequest } from '@google/adk/models/llm_request'` 経路は使えない。
 *   `Parameters<BaseLlm['generateContentAsync']>[0]` と `AsyncGenerator<infer R, void>` 抽出で
 *   public surface (= `BaseLlm` 抽象 method signature) から逆算する。上流 adk-js が将来
 *   top-level に re-export したら型 alias を差し替える方針 (= drop-in 互換)。
 */
import { createHash } from 'node:crypto';

import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { BaseLlm } from '@google/adk';
import type { BaseLlmConnection } from '@google/adk';
import { GoogleAuth } from 'google-auth-library';

import { log } from '../log.js';
import {
  GEN_AI_OPERATION_CHAT,
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_GCP_VERTEX_AI,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  SERVER_ADDRESS,
  extractVertexUsage,
  type VertexCallUsageFields,
} from '../observability/genai.js';
import { getTracer } from '../observability/index.js';
import { getTraceLogFields } from '../observability/trace-fields.js';
import { getAnthropicVertexRequestContext } from './anthropic-vertex-request-context.js';
import { toAnthropicTools } from './schema-conversion.js';
import { buildVertexForensicPayload } from './vertex-forensic.js';

/**
 * ADK が `generateContentAsync` 抽象 method を export している唯一の型抽出経路。
 * `@google/adk@1.3.0` の `package.json.exports` は `.` のみ許可 (= `models/*` subpath は不可)。
 */
type LlmRequest = Parameters<BaseLlm['generateContentAsync']>[0];
type LlmResponse = ReturnType<BaseLlm['generateContentAsync']> extends AsyncGenerator<infer R, void> ? R : never;

/**
 * `LlmRequest.config` の最小 narrow — `maxOutputTokens` / `systemInstruction` / `tools` の 3 フィールドを
 * structural に抽出する (= `@google/genai` の `GenerateContentConfig` を直接 import すると transitive
 * dep を package.json 直接依存に昇格する必要があるため、`ContentLike` 同様の structural narrow で代替)。
 *
 * `functionDeclarations` 内の個別 entry は `unknown[]` で narrow を緩く保つ (= ADK 1.4.0+ で
 * `parametersJsonSchema` が追加される前方互換性、structural narrow が壊れないように)、実際の型
 * narrow は `schema-conversion.ts` の `AdkFunctionDeclaration` で吸収する。
 *
 * 履歴:
 *   - `maxOutputTokens` / `systemInstruction` を先行実装
 *   - `tools?` を追加。ADK runner が `appendTools()` で格納する
 *     `Array<{ functionDeclarations: FunctionDeclaration[] }>` を narrow し、
 *     `generateContentAsync` 内で `toAnthropicTools(config.tools)` → `messages.create({tools})`
 *     経路で LLM に tool 定義を届ける
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
 * | Message`)。non-streaming 経路のみで `Message` 側を期待するため、`content`
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
 * **functionCall / functionResponse 対応**: multi-turn round-trip 経路で ADK は前回 LLM 応答
 * (= functionCall part) と tool 実行結果 (= functionResponse part) を `contents` に追加してくる。
 * これらを Anthropic API の `tool_use` / `tool_result` block に変換しないと LLM は tool 結果を読まずに
 * 同じ tool を何度も呼ぶ無限ループに陥る。
 */
interface PartLike {
  text?: string;
  /**
   * ADK/genai `Part.functionCall` (= `@google/genai::FunctionCall`) の structural mirror。
   * `id` と `name` は `convertContentsToAnthropicMessages` の functionCall 分岐で
   * `tool_use` block への必須 field として参照、`args` は tool 入力 payload。
   * id/name 欠けは silent failure 撲滅のため log.warn + skip
   * (event: `adk.anthropic_vertex_llm.skip_invalid_function_call`)。
   */
  functionCall?: { id?: string; name?: string; args?: unknown };
  /**
   * ADK/genai `Part.functionResponse` (= `@google/genai::FunctionResponse`, `genai.d.ts:4315-4329`) の
   * structural mirror。`id` と `response` は `convertContentsToAnthropicMessages` の
   * functionResponse 分岐で `tool_result` block のコア field として参照
   * (id → tool_use_id、response → content)。**`name` はコア変換パスでは未参照だが**、
   * id 欠け skip 時の log.warn payload で「どの tool の functionResponse が drop されたか」の
   * 可観測性のために参照する (event: `adk.anthropic_vertex_llm.skip_invalid_function_response`、
   * silent failure 撲滅、debug hint)。
   */
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
 * ロールマッピング表 — ADK の `Content.role` は将来 `'tool'` /
 * `'function'` / `'system'` 等の拡張が入りうるが、Anthropic Messages API は `'user'` / `'assistant'`
 * の 2 ロールのみを受け付け、かつ連続同一ロールを 400 で拒否する (= "roles must alternate")。
 * 未知ロールは `'user'` に fallback するが、その瞬間 log.warn で可視化し、
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
  private readonly googleAuth: GoogleAuth;

  constructor({ model }: { model: string }) {
    super({ model });
    this.region = process.env.CLOUD_ML_REGION ?? DEFAULT_REGION;

    // issue #136 A3-a (Step 3-a/3-b): keyless ADC 経路を維持しつつ Authorization capture を
    // 可能にする。GoogleAuth インスタンスを明示的に構築し、SDK 内部の getRequestHeaders()
    // cache 経路を共有することで pre-flight capture (generateContentAsync 内) が観察する token
    // と SDK が実際に送る token を同一にする (= observability 目的達成の前提)。
    //
    // 前提: pnpm.overrides で google-auth-library@9.15.1 を単一化済 (`pnpm-workspace.yaml`)。
    // 2 バージョン共存だと `AnthropicVertex.ClientOptions.googleAuth` の型が別 version の
    // GoogleAuth を指して TS2322 (`#private` field 不一致) で拒否される罠を回避。
    //
    // 公式契約 (context7 `@anthropic-ai/vertex-sdk` README):
    //   `new AnthropicVertex({ googleAuth: new GoogleAuth({...}) })` は Custom GoogleAuth
    //   configuration の公式経路。scopes は string 単体が README 例、array も許容。
    //
    // cache 動作 (google-auth-library v9.15.1 oauth2client.ts:897-919):
    //   - `credentials.access_token` を instance field に保持
    //   - `isTokenExpiring()` = expiry_date <= now + eagerRefreshThresholdMillis
    //   - `DEFAULT_EAGER_REFRESH_THRESHOLD_MILLIS = 5 * 60 * 1000` (5 分前倒し refresh)
    //   - 並行呼出は refreshTokenPromises Map dedup で 1 in-flight promise に収束
    const googleAuth = new GoogleAuth({
      scopes: 'https://www.googleapis.com/auth/cloud-platform',
      projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID ?? undefined,
    });

    this.client = new AnthropicVertex({
      region: this.region,
      projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID ?? null,
      googleAuth,
    });
    this.googleAuth = googleAuth;

    log.info('AnthropicVertexLlm initialized', {
      event: 'adk.anthropic_vertex_llm.init',
      model: this.model,
      region: this.region,
      project_id: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
    });
  }

  /**
   * 非 streaming 単発生成。`@google/genai` 型の `LlmRequest` を Anthropic `messages.create` 形式に
   * 変換し、`LlmResponse` に詰めて 1 yield する。変換対象は以下の 4 経路:
   *   - contents の text part → `{role, content: string}`
   *   - contents の functionCall part → `{role: 'assistant', content: [{type: 'tool_use', ...}]}`
   *     (= multi-turn round-trip で前回 LLM 応答を持ち回る経路)
   *   - contents の functionResponse part → `{role: 'user', content: [{type: 'tool_result', ...}]}`
   *     (= 前回 tool 実行結果を LLM に渡す経路)
   *   - config.tools の FunctionDeclaration → Anthropic Tool (`toAnthropicTools`)
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
    // issue #136 Step 0-d: AsyncLocalStorage 経由で dispatcher → LLM 呼出の request 相関を回収。
    // undefined 時は空文字 fallback + `context_missing:true` を emit で「AsyncLocalStorage の
    // 外から呼ばれた」を可観測にする (silent 化しない、biblio-claw §silent failure 撲滅方針)。
    const reqCtx = getAnthropicVertexRequestContext();
    const ctxFields: Record<string, unknown> = reqCtx
      ? { request_id: reqCtx.requestId, session_id: reqCtx.sessionId, channel_type: reqCtx.channelType }
      : { request_id: '', session_id: '', channel_type: '', context_missing: true };
    // M4-C Phase 1: `vertex.call` の Cloud Logging emit を成功経路で発火する
    // (= `src/biblio/vertex-client.ts:508-517` の pattern 写経、latency_ms 計上のため t0 を setup)。
    // src/reporting/sql/llm-cost.sql が本 event を GROUP BY jsonPayload.model で集計。
    // ADK チャット本体経路 (CLI/Slack/Fugue ask) の Vertex 呼出は helper axis (categorize/inspect/gate) と
    // 別で、以前は span 属性のみで Cloud Logging に emit されていなかった (M4-C review で発見)。
    const t0 = performance.now();
    // issue #136 Step 5-b: pre-flight capture 結果を catch (401 forensic dump) から参照するため
    // try の外側 (関数スコープ) に上げる。try 内で書き込み、catch で読み取る双方向 flow。
    let authTokenIat: number | null = null;
    let authTokenExp: number | null = null;
    let authTokenHash = '';
    let authCaptureError = '';
    try {
      const messages = this.convertContentsToAnthropicMessages(llmRequest);

      // 空 messages ガード (= 全 turns の blocks が 0 件のとき発火)。
      // Phase 2 で有効な `functionCall` / `functionResponse` は blocks に積まれるため、本経路が
      // 実際に踏まれるのは (a) image/audio のみの turn、(b) 無効な functionCall/Response (= id/name
      // 欠け) のみの turn で全 turns 構成されるケース。Anthropic API は空 messages を 400 で
      // 拒否するため、SDK を呼ぶ前に EMPTY_MESSAGES で fail-fast し span にも ERROR を立てる
      // (= silent failure 撲滅)。
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
      // `schema-conversion.ts:toAnthropicTools` に集約 (= 純粋関数、unit test で境界ケース群検証済)。
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

      // issue #136 A3-b (Step 3-b): SDK 呼出直前に Authorization header を capture して
      // JWT decode (JWT 形式の場合) + hash (opaque でも常に有効)。
      //   - googleAuth.getClient().getRequestHeaders() は SDK 内部 #adaptRequest と同一の
      //     AuthClient instance を叩き (constructor で同じ GoogleAuth を渡している)、
      //     google-auth-library が cache 済 token を返す (期限切れなら metadata server refresh)。
      //     二重 refresh レースは refreshTokenPromises Map dedup で 1 in-flight 収束
      //   - fail-open: capture 失敗しても LLM 呼出自体は続行 (biblio-claw silent failure 撲滅
      //     方針の degraded fallback、observability だけ空値 + capture_error 明示)
      //   - ADC token は opaque `ya29.*` が主流 (Google Cloud docs 明示、metadata server 発行)。
      //     parts.length===3 guard で JWT 形式のみ iat/exp を取り出す。opaque では null で、
      //     auth_token_hash が主戦力 (BQ 相関 SQL の A 分類判定は hash 一致で成立)
      //   - 変数は関数スコープに宣言済 (catch 節から参照するため、Step 5-b)。
      try {
        const authClient = await this.googleAuth.getClient();
        const authHeaders = await authClient.getRequestHeaders();
        const bearer =
          (authHeaders as Record<string, string>)?.Authorization ??
          (authHeaders as Record<string, string>)?.authorization ??
          '';
        const jwtMatch = /^Bearer\s+(.+)$/.exec(bearer);
        const rawToken = jwtMatch?.[1] ?? '';
        if (rawToken) {
          authTokenHash = createHash('sha256').update(rawToken).digest('hex').slice(0, 12);
          const parts = rawToken.split('.');
          if (parts.length === 3 && parts[1]) {
            try {
              const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
              const payload = JSON.parse(payloadJson) as { iat?: number; exp?: number };
              if (typeof payload.iat === 'number') authTokenIat = payload.iat;
              if (typeof payload.exp === 'number') authTokenExp = payload.exp;
            } catch {
              // opaque (ya29.*) or decode 失敗 = iat/exp なし、hash のみ有効
            }
          }
        } else {
          authCaptureError = 'no_bearer_in_headers';
        }
      } catch (err) {
        authCaptureError = err instanceof Error ? err.message : String(err);
        log.warn('AnthropicVertexLlm: pre-flight auth capture failed (fail-open)', {
          event: 'vertex.sdk.request_header.capture_failed',
          outcome: 'degraded',
          ...ctxFields,
          err: authCaptureError,
        });
      }

      // pre-flight capture 結果を単独 event として emit (401 発生時の forensic dump 用)。
      // 直前 capture の state が BQ で参照可能になる = 401 発生 request と直近 capture の
      // trace_id / request_id で JOIN 可能。
      log.info('vertex.sdk.request_header captured', {
        event: 'vertex.sdk.request_header',
        outcome: authCaptureError ? 'degraded' : 'success',
        ...ctxFields,
        ...getTraceLogFields(span),
        auth_token_iat: authTokenIat,
        auth_token_exp: authTokenExp,
        auth_token_hash: authTokenHash,
        auth_capture_error: authCaptureError || null,
        age_since_iat_sec: authTokenIat != null ? Math.floor(Date.now() / 1000) - authTokenIat : null,
      });

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
      // usage 欠落 (SDK バージョン差 / 部分応答) の warn を vertex-client.ts:498 と
      // 対称に追加。SDK 応答から usage オブジェクト自体が消えた case を patron に可視化する。
      if (!(response as { usage?: unknown }).usage) {
        log.warn('vertex.call: usage absent', {
          event: 'adk.anthropic_vertex_llm.usage_absent',
          model: this.model,
        });
      }
      if (usage.input_tokens != null) span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, usage.input_tokens);
      if (usage.output_tokens != null) span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, usage.output_tokens);
      if (usage.cache_read_input_tokens != null) {
        span.setAttribute(GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, usage.cache_read_input_tokens);
      }
      if (usage.cache_creation_input_tokens != null) {
        span.setAttribute(GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS, usage.cache_creation_input_tokens);
      }
      // M4-C Phase 1: 成功経路で `vertex.call` event を Cloud Logging に emit
      // (= vertex-client.ts:508-527 の pattern 対称化、llm-cost.sql の集計対象を
      // ADK チャット本体経路 (CLI/Slack/Fugue ask) にも拡張)。
      // M4-C Phase 2: cache_read/cache_creation を unconditional emit (?? 0) して
      // llm-cost.sql の SUM 対象を有効化 + cost-calculator の warnings 消失。
      // cache_captured を独立 boolean で emit することで「未捕捉 (SDK 差)」と
      // 「実測 0 (cache 未使用)」を BQ 集計で区別可能に。cost 過小推定の可視化。
      // 共有 interface (`VertexCallUsageFields`) 経由で vertex-client.ts と同 shape に強制。
      // 新 field 追加時に両 emit が compile error で検知される (SQL 側 drift の抑止 anchor)。
      const cacheCaptured = usage.cache_read_input_tokens != null && usage.cache_creation_input_tokens != null;
      const usageFields: VertexCallUsageFields = {
        outcome: 'success',
        tokens_in: usage.input_tokens ?? 0,
        tokens_out: usage.output_tokens ?? 0,
        cache_read: usage.cache_read_input_tokens ?? 0,
        cache_creation: usage.cache_creation_input_tokens ?? 0,
        cache_captured: cacheCaptured,
        latency_ms: Math.round(performance.now() - t0),
      };
      // issue #136 Step 0-d: 成功パスの構造化 log を trace 相関可能に emit。
      // `context.with(spanCtx, ...)` の callback 外側で emit するため active span 経由の相関は
      // 空になる (= WHY 1-a)。`getTraceLogFields(span)` に明示 span 引数を渡し脱出する。
      // ctxFields は AsyncLocalStorage 経由で dispatcher から流れる request_id / session_id /
      // channel_type。両者揃うと BQ で `router.dispatch.adk` (patron 発話入口) と本 log を
      // 横串で結合できる (= WHY 1-b 是正)。
      // usageFields (M4-C Phase 1/2 経路、`VertexCallUsageFields` interface で強制) は
      // outcome / tokens_in / tokens_out / cache_read / cache_creation / cache_captured /
      // latency_ms を集約、llm-cost.sql の GROUP BY jsonPayload.model 集計を成立させる。
      log.info('vertex.call', {
        event: 'vertex.call',
        model: this.model,
        ...ctxFields,
        ...getTraceLogFields(span),
        ...usageFields,
      });

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

      // issue #136 Step 5-b: 401 検知 → forensic dump 発火 (channel='adk')。
      // 判定は @anthropic-ai/sdk の AuthenticationError name / status 401 / message regex の
      // 3 経路 OR = SDK 版差で shape が微妙に違うため future-proofing (silent fail 時は
      // is_401=false の通常 error log に落ちる = 観察漏れは runbook §Cloud Trace UI で fallback)。
      const is401 =
        (err as { status?: number })?.status === 401 ||
        (err as { name?: string })?.name === 'AuthenticationError' ||
        /401|ACCESS_TOKEN_EXPIRED|invalid authentication credentials/i.test(errorRecord.message);
      if (is401) {
        log.error(
          'vertex.401 forensic dump (channel=adk)',
          buildVertexForensicPayload({
            channel: 'adk',
            requestId: reqCtx?.requestId ?? '',
            sessionId: reqCtx?.sessionId ?? '',
            channelType: reqCtx?.channelType ?? '',
            authTokenIat,
            authTokenExp,
            authTokenHash,
            authCaptureError: authCaptureError || null,
            httpStatus: 401,
            err: errorRecord,
            span,
          }),
        );
      }

      // OTel が degraded fallback (= `instrumentation.ts` の init failure 経路) のとき
      // `span.recordException` / `setStatus` は全部 no-op になるため、構造化ログにも残す
      // (= biblio-claw §silent failure 撲滅方針: 失敗は必ず log、握り潰さない)。
      // issue #136 Step 0-d: ctxFields + getTraceLogFields(span) で trace / request 相関を保持。
      log.error('AnthropicVertex SDK call failed', {
        event: 'adk.anthropic_vertex_llm.generate',
        outcome: 'failure',
        model: this.model,
        ...ctxFields,
        ...getTraceLogFields(span),
        latency_ms: Math.round(performance.now() - t0),
        is_401: is401,
        err: errorRecord.message,
      });
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * streaming 経路は scope 外 (= PRD §作らないもの「`AnthropicVertexLlm.connect()` (streaming)
   * 実装」)。MVP 1 命令完遂は `generateContentAsync` で成立するため、ここは throw で
   * silent failure を防ぐ (= 起動時に呼ばれて握り潰されると後続の UX 改善が無音に失敗する)。
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
   * **multi-turn round-trip 対応**:
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
   *   - 未知ロールは `'user'` に fallback + warn log (= role mapping table の拡張の signal)
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
      for (const p of c.parts ?? []) {
        if (!p || typeof p !== 'object') continue;
        if (typeof p.text === 'string' && p.text.length > 0) {
          blocks.push({ type: 'text', text: p.text });
        } else if (p.functionCall) {
          const fc = p.functionCall;
          if (typeof fc.id === 'string' && typeof fc.name === 'string') {
            blocks.push({ type: 'tool_use', id: fc.id, name: fc.name, input: fc.args ?? {} });
          } else {
            // multi-turn round-trip の生命線を守るため、id/name 不在の functionCall は warn で可視化。
            // 静かに drop すると LLM は前回 tool 呼出履歴を失い、同じ tool を無限リトライする
            // (= silent failure 撲滅)。
            log.warn('AnthropicVertexLlm: functionCall part has no valid id/name, skipped', {
              event: 'adk.anthropic_vertex_llm.skip_invalid_function_call',
              outcome: 'skipped',
              id_type: typeof fc.id,
              name_type: typeof fc.name,
            });
          }
        } else if (p.functionResponse) {
          const fr = p.functionResponse;
          if (typeof fr.id === 'string') {
            // tool_result の content は string (= Anthropic 仕様で `string | ContentBlock[]`)。
            // `response` は ADK 経路で任意 object なので JSON.stringify で string 化する
            // (= silent failure 撲滅、構造を壊さず LLM に渡す)。
            const content = typeof fr.response === 'string' ? fr.response : JSON.stringify(fr.response ?? null);
            blocks.push({ type: 'tool_result', tool_use_id: fr.id, content });
          } else {
            // functionResponse の id 不在は tool_use_id 対応関係を壊す最悪経路。ADK は通常
            // toLlmResponse の `functionCall.id` を引き継いで生成するため、通常経路では踏まない
            // が、warn で可視化して LLM 無限ループ retry の原因追跡を可能にする
            // (= silent failure 撲滅)。
            log.warn('AnthropicVertexLlm: functionResponse part has no valid id, skipped', {
              event: 'adk.anthropic_vertex_llm.skip_invalid_function_response',
              outcome: 'skipped',
              id_type: typeof fr.id,
              name: typeof fr.name === 'string' ? fr.name : '(unknown)',
            });
          }
        }
      }
      if (blocks.length === 0) continue;
      // text-only message は string content に簡素化 (= 既存 test の compat 維持)。
      // 判定はループ外に切り出し、blocks 状態を単一情報源にする (= textOnly / hasNonText の
      // 二重状態管理を除去)。
      const isTextOnly = blocks.every((b) => b.type === 'text');
      if (isTextOnly) {
        const text = (blocks as Array<{ type: 'text'; text: string }>).map((b) => b.text).join('\n');
        result.push({ role: mappedRole, content: text });
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
   * 型 narrow で string / Content like / array を分岐、parts の text を join。
   * unknown へ落ちる経路は `JSON.stringify` でフォールバック (= silent に空文字を返すと
   * patron 命令の system context が喪失する罠を避ける)。
   */
  private flattenSystemInstruction(systemInstruction: unknown): string {
    if (typeof systemInstruction === 'string') return systemInstruction;
    if (Array.isArray(systemInstruction)) {
      // 空 string を filter してから join (= 全要素が空のとき `'\n'` 等の偽 truthy 文字列を
      // 返すと caller の 空 string ガードを通過して `system: '\n'` が SDK に渡る経路を防ぐ)。
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
   * SDK 戻り値 (`@anthropic-ai/sdk` の `Message` 型) を ADK の `LlmResponse`
   * (= `@google/genai` の `Content` 型相当) に詰める。
   *
   * **tool_use 優先** (= LLM 自律 tool 呼出経路の生命線):
   *   - `tool_use` block が 1 件以上あれば → `functionCall` parts として return
   *     (= ADK runner の `functionCall` event dispatch を成立させる)
   *   - `tool_use` が 0 件のとき → `text` block を採用 (= fallback 経路)
   *   - text も不在 → `errorCode: 'EMPTY_TEXT'` で return、caller が span ERROR を立てる
   *
   * `id/name` が string でない `tool_use` block は filter で skip、全て filter drop された場合は
   * `event: 'adk.anthropic_vertex_llm.tool_use_dropped'` の warn で可視化する (= silent failure
   * 撲滅、tool_use と text 応答を外部から区別可能にする)。
   * テキスト不在自体の `log.warn` も本メソッド末尾で吐く (= biblio-claw §silent failure 撲滅: 成功 HTTP 応答だが
   * 意味的失敗のケースを構造化ログで可視化、OTel degraded 状態でも追跡可能)。
   */
  private toLlmResponse(response: SdkMessageResponse): LlmResponse {
    // tool_use block の ADK `functionCall` part 変換を先頭で実施する。
    // text block 抽出に先んじて tool_use を見ることで、Claude が tool 呼出を返したときに
    // EMPTY_TEXT 経路に倒れず ADK runner の `functionCall` event dispatch を成立させる。
    //
    // 設計判断:
    //   - **`id` 保持必須**: Anthropic の multi-turn round-trip では `tool_use_id` を `tool_result`
    //     に紐付ける契約 (= `tool_use_id` 不一致は API 400 で拒否される)。ADK の `functionCall.id`
    //     経路で持ち回ることで multi-turn 経路が成立可能
    //   - **multi-block 対応**: Claude は 1 turn で複数 tool を同時呼出する経路があるため、
    //     `find()` で先頭 1 件ではなく `filter() + map()` で全 block を `parts` 配列で返す
    //   - type predicate で `id` が string でない block は filter で skip (= silent failure 撲滅)
    // SDK 0.107.0 の `ToolUseBlock` 型は `caller` フィールド必須化があり structural type
    // predicate と型レベルで衝突する (= biblio-claw 視点では `caller` は使わない)。SDK 型と
    // 切り離した structural narrow + 末尾 `as` cast で `id` / `name` / `input` の最小フィールド
    // のみ抽出する (= silent failure 撲滅のため `id` / `name` が string でないものは filter で skip)。
    type ExtractedToolUse = { type: 'tool_use'; id: string; name: string; input: unknown };
    const rawContent = (response.content ?? []) as unknown[];
    // 生の tool_use ブロック数を filter 前に記録。これで「tool_use が来たが全 filter drop された」経路
    // と「そもそも tool_use が来ていなかった (text 応答のみ)」を後段で区別できる
    // (= silent failure 撲滅)。
    const rawToolUseCount = rawContent.filter(
      (c) => typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'tool_use',
    ).length;
    const toolUseBlocks = rawContent.filter((c): c is ExtractedToolUse => {
      if (typeof c !== 'object' || c === null) return false;
      const block = c as { type?: unknown; id?: unknown; name?: unknown };
      return block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string';
    });
    if (rawToolUseCount > 0 && toolUseBlocks.length === 0) {
      // Anthropic API が tool_use ブロックを返したが id/name が全て string でなかった経路。
      // text 経路に fall-through すると tool 呼出の意図が silent に消え、tool_use と text 応答を
      // 外部から区別できなくなる。warn で可視化して SDK バージョン差 / API 不整合を検知可能にする。
      log.warn('AnthropicVertexLlm: tool_use blocks present but all dropped (invalid id/name)', {
        event: 'adk.anthropic_vertex_llm.tool_use_dropped',
        outcome: 'all_dropped',
        raw_count: rawToolUseCount,
        stop_reason: response.stop_reason ?? 'unknown',
      });
    }
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
