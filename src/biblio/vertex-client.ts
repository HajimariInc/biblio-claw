/**
 * Vertex AI × Gemini 呼び出しクライアント — 検品 dangerous 軸の判定に使う。
 *
 * Phase 2 検品の dangerous 軸は host (Node 22) から Vertex の `:generateContent`
 * (Gemini Vertex API) を直接叩く。OneCLI MITM proxy が Authorization を wire で本物の
 * ADC Bearer に書き換えるため、host 側は `Bearer placeholder` を載せて proxy + 自前 CA に
 * 到達できれば良い。Anthropic ではなく Google 1st party モデル (publishers/google) なので、
 * Vertex AI API が enable 済の project (= biblio-claw が agent で利用中) で追加の Marketplace
 * enable は不要 (= local/GKE 共にメンテナの GCP 作業ゼロで動く)。
 *
 * モデルは `.env` の `INSPECT_DANGEROUS_MODEL` で指定する (例: `gemini-2.5-flash`)。
 * 既定値はあえて持たない: 検品ロジックをハードコードしたモデル ID に縛り付けない方針
 * (メンテナ判断)。未設定なら起動時に warn + 検品時 throw → inspect() が fail-closed (HOLD)。
 *
 * Node built-in fetch は `dispatcher` オプションを公開しないため (nodejs/node#43187)、
 * `undici` を依存に追加し `ProxyAgent` を `setGlobalDispatcher` で global 適用する。
 * agent (claude-code) 経路は providers/claude.ts + secret/onecli.ts が env で配線するが、
 * host fetch はこのクライアントが proxy + CA を ProxyAgent で動的に効かせる。
 *
 * 用途規約 (CLAUDE.md 参照): host ネイティブ + Claude 特性不要な host 側補助推論 (= 本クライアント)
 * には Google モデル可、skill 発動に絡む推論 (カテゴライズ等) は Anthropic 必須。検品 dangerous
 * 軸はこの第 1 例。
 *
 * 失敗 (`!res.ok` / fetch throw / `candidates[0].content.parts[0].text` 不在) は throw —
 * 呼び出し側 (`inspect()`) が catch して fail-closed (HOLD/inspect_error) に倒す。
 */
import fs from 'node:fs';

import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { EnvHttpProxyAgent, fetch, setGlobalDispatcher } from 'undici';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  SERVER_ADDRESS,
  GEN_AI_PROVIDER_GCP_VERTEX_AI,
  GEN_AI_OPERATION_CHAT,
  extractVertexUsage,
} from '../observability/genai.js';
import { getTracer } from '../observability/index.js';
import { getProxyState } from './host-proxy.js';

/** region 既定値 — providers/claude.ts と同値 (CLOUD_ML_REGION 未設定なら global)。 */
const DEFAULT_REGION = 'global';

/**
 * Vertex × Gemini 呼び出しのハードタイムアウト (ms)。
 *
 * acquire.ts の GH_TIMEOUT_MS = 30s / CLONE_TIMEOUT_MS = 120s と同じ思想で、
 * OneCLI proxy のコールドスタート (GKE Native sidecar 起動遅延) や proxy ハング時に
 * delivery poll thread を無期限ブロックさせないために必須。`AbortSignal.timeout()` 経由で
 * fetch を `AbortError` で reject させ、`inspect()` の catch が HOLD/inspect_error に倒す。
 *
 * 60s は検品 1 件の患者向け応答 (Slack) の体感上限。Vertex × Gemini Flash の通常応答
 * (= 数百 ms) の数十倍の余裕。
 */
const VERTEX_TIMEOUT_MS = 60_000;

/** Vertex 呼び出しの host (region によって変わる)。 */
function vertexHost(region: string): string {
  return region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
}

/**
 * Vertex URL を組む。
 *
 * - `publisher='google'` + `endpoint='generateContent'` (既定) は Gemini 1st party 経路。
 * - `publisher='anthropic'` + `endpoint='rawPredict'` は Claude on Vertex 経路 (Marketplace enable 必要)。
 *
 * 既定値で `callVertexGemini` の旧呼び出しを温存しつつ、Phase 3 の `callVertexAnthropic` 用に
 * 引数化した (= 関心事分離より「最小拡張」を選ぶ。同形を 2 関数で重複コピーすると tokei が増えるだけ)。
 */
function vertexUrl(
  project: string,
  region: string,
  modelId: string,
  publisher: 'google' | 'anthropic' = 'google',
  endpoint: 'generateContent' | 'rawPredict' = 'generateContent',
): string {
  return (
    `https://${vertexHost(region)}/v1/projects/${project}/locations/${region}` +
    `/publishers/${publisher}/models/${modelId}:${endpoint}`
  );
}

/**
 * host からの fetch を OneCLI MITM proxy + 自前 CA 経由にする。
 *
 * - `getProxyState()` から proxy URL と CA path を取り、両方解決済みなら
 *   `EnvHttpProxyAgent({ httpsProxy, noProxy, requestTls: { ca }, proxyTls: { ca } })` を global dispatcher に。
 * - `NODE_EXTRA_CA_CERTS` は undici ProxyAgent の TLS には**効かない**ため、PEM を
 *   `requestTls.ca` + `proxyTls.ca` に明示的に渡す必要がある (plan GOTCHA)。
 * - proxy 未解決 (fail-open) はスキップ — fetch は直接 Vertex に向かい、TLS / 認可で
 *   失敗 (もしくは `VERTEX_TIMEOUT_MS` で AbortError) して呼び出し側で fail-closed に倒れる。
 *   timeout なしだと TCP 接続成立後の応答待ちで delivery poll thread が無期限ブロック
 *   する経路があったため、`callVertexGemini` 側で `AbortSignal.timeout()` を必ず付ける。
 *
 * **localhost bypass (= noProxy)**: OneCLI 管理 API (`127.0.0.1:10254`) への fetch は
 * proxy (`:10255`) を **必ず bypass** する必要がある。OneCLI SDK の `AgentsClient.createAgent`
 * が agent コンテナ spawn 時に内部 fetch で OneCLI REST を叩くが、global dispatcher が
 * proxy 経由にすると proxy (`:10255`) が管理 API (`:10254`) に到達できず `fetch failed` で
 * 戻り、agent コンテナが永久に spawn されなくなる経路があった (= proxy 自身は管理 API への
 * forwarding 経路を持たない設計のため、self-target host への request は接続失敗で倒れる)。
 * `EnvHttpProxyAgent` の `noProxy` で `127.0.0.1,localhost` を明示的に除外し、
 * 既存 `NO_PROXY` 環境変数があれば union を取る (GKE で K8s 内部 DNS bypass を入れているケース等)。
 * undici の `noProxy` parser は `,` だけでなく空白でも split する (= `env-http-proxy-agent.js`
 * 内部 `#parseNoProxy` が `/[,\s]/` 正規表現を使う) ため、`NO_PROXY` が空白区切りで設定された
 * 環境でも union 動作は壊れない。
 *
 * 冪等: 多重呼び出ししても最後に設定した dispatcher が有効になるだけ。host 起動時に
 * `initHostProxy()` の直後で 1 回呼ぶ想定 (= `opts.noProxy` を渡しているため、undici は
 * dispatcher 生成後の `NO_PROXY` env 変化を追跡しない設計。複数回呼ぶ経路を将来作る場合は
 * 起動時固定で問題ない用途かを確認すること)。
 */
export function setupVertexProxy(): void {
  const { httpsProxy, caPath } = getProxyState();
  if (!httpsProxy || !caPath) {
    log.warn('vertex-client: proxy or CA not resolved — fetch will go direct (will fail at TLS/auth)', {
      hasProxy: Boolean(httpsProxy),
      hasCa: Boolean(caPath),
    });
    return;
  }
  let ca: string;
  try {
    ca = fs.readFileSync(caPath, 'utf-8');
  } catch (err) {
    // CA file が消えていたら proxy も無効化扱い (silent failure 防止のため warn)。
    log.warn('vertex-client: CA file unreadable — skipping ProxyAgent setup', { caPath, err });
    return;
  }
  const noProxyParts = new Set<string>(['127.0.0.1', 'localhost']);
  for (const part of (process.env.NO_PROXY || process.env.no_proxy || '').split(',')) {
    const trimmed = part.trim();
    if (trimmed) noProxyParts.add(trimmed);
  }
  const noProxy = [...noProxyParts].join(',');
  const dispatcher = new EnvHttpProxyAgent({
    httpsProxy,
    noProxy,
    requestTls: { ca },
    proxyTls: { ca },
  });
  setGlobalDispatcher(dispatcher);
  log.info('vertex-client: EnvHttpProxyAgent installed as global dispatcher (localhost bypass)', {
    httpsProxy,
    caPath,
    noProxy,
  });
}

/**
 * Vertex 呼び出しの追跡 context。
 * axis は inspect 経路の 3 軸判定 (`legal` / `quality` / `dangerous`)、biblioName は対象 biblio。
 */
export interface VertexCallCtx {
  requestId?: string;
  sessionId?: string;
  axis?: string;
  biblioName?: string;
}

/**
 * Vertex 呼び出しログの共通フィールド (= `event` + `model` + ctx 由来 4 件) を集約するヘルパ。
 *
 * 失敗 / 成功 / メタデータ警告で `request_id` / `session_id` / `axis` / `biblio_name` が
 * 4 関数 × 複数箇所で逐語コピーされていた payload を 1 箇所に集約。
 * `extras` で `outcome` / `status` / `latency_ms` / `tokens_*` 等の個別フィールドを
 * 上乗せする。
 */
function vertexLogFields(
  ctx: VertexCallCtx | undefined,
  model: string,
  extras?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    event: 'vertex.call',
    model,
    request_id: ctx?.requestId,
    session_id: ctx?.sessionId,
    axis: ctx?.axis,
    biblio_name: ctx?.biblioName,
    ...extras,
  };
}

/** `callVertexGemini` の引数。 */
export interface VertexCallArgs {
  /** 入力テキスト (system 不要、user 1 turn 想定で十分)。 */
  prompt: string;
  /** 生成上限。dangerous 判定は VERDICT 1 行で十分なので小さく取る。 */
  maxOutputTokens: number;
  /** 決定性目的なら 0。検品は 0 固定で呼ぶ。 */
  temperature: number;
  /** 既定は `.env` の `INSPECT_DANGEROUS_MODEL`。差し替え用 (テストなどで利用)。 */
  modelId?: string;
}

/** Gemini `:generateContent` の応答 (`candidates[0].content.parts[0].text` のみ参照)。 */
interface VertexGeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
      role?: string;
    };
    finishReason?: string;
  }>;
  /** Vertex `:generateContent` は usageMetadata でトークン使用量を返す (BQ cost 集計の基盤)。 */
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

/**
 * Vertex × Gemini を `:generateContent` 経路で叩いて最初のテキストを返す。
 *
 * 失敗ケースは全て throw (呼び出し側 `inspect()` が catch して HOLD に倒す):
 *   - `ANTHROPIC_VERTEX_PROJECT_ID` 未設定 → 設定ミスを即可視化
 *     (env 名は M1 で Vertex × Claude 用に決めた値を流用 — Gemini も同じ project)
 *   - `INSPECT_DANGEROUS_MODEL` 未設定 → 既定値を持たない方針なので必須
 *   - fetch 自体の throw (proxy 未到達 / DNS / TLS) → そのまま伝播
 *   - `!res.ok` (4xx/5xx) → status + body 抜粋を message に含めて throw
 *   - `candidates[0].content.parts[0].text` 不在 → 応答形式崩れ
 */
export async function callVertexGemini(args: VertexCallArgs, ctx?: VertexCallCtx): Promise<string> {
  const env = readEnvFile(['ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION', 'INSPECT_DANGEROUS_MODEL']);
  const project = env.ANTHROPIC_VERTEX_PROJECT_ID;
  if (!project) {
    throw new Error('vertex-client: ANTHROPIC_VERTEX_PROJECT_ID is not set (.env / process.env both empty)');
  }
  const region = env.CLOUD_ML_REGION || DEFAULT_REGION;
  // `||` は空文字も falsy = env にフォールバックさせる。`??` だと `modelId: ''` が
  // env を無視して空文字のまま Vertex に送られ 4xx → HOLD に倒れるが、起動時の
  // env 必須チェック (`if (!modelId)`) で fail-fast にした方が debug 性が高い。
  const modelId = args.modelId || env.INSPECT_DANGEROUS_MODEL;
  if (!modelId) {
    throw new Error('vertex-client: INSPECT_DANGEROUS_MODEL is not set (.env / process.env both empty)');
  }
  const url = vertexUrl(project, region, modelId, 'google', 'generateContent');
  const tracer = getTracer();
  return tracer.startActiveSpan(
    `${GEN_AI_OPERATION_CHAT} ${modelId}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        [GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_CHAT,
        [GEN_AI_PROVIDER_NAME]: GEN_AI_PROVIDER_GCP_VERTEX_AI,
        [GEN_AI_REQUEST_MODEL]: modelId,
        [SERVER_ADDRESS]: vertexHost(region),
        'biblio.request_id': ctx?.requestId,
        'biblio.session_id': ctx?.sessionId,
        'biblio.axis': ctx?.axis,
      },
    },
    async (span) => {
      const t0 = performance.now();
      try {
        // Gemini 2.5 系は thinking がデフォルト ON で `thoughtsTokenCount` に予算を喰われる
        // (= maxOutputTokens を thinking が先食いし、テキスト出力が截切れる)。検品 dangerous 軸の
        // 用途は「VERDICT: DANGEROUS|CLEAN」1 行判定で、推論連鎖は不要なため明示的に OFF にする
        // (`thinkingBudget: 0`)。
        // 参考: cloud.google.com/vertex-ai/generative-ai/docs/thinking
        const body = {
          contents: [{ role: 'user', parts: [{ text: args.prompt }] }],
          generationConfig: {
            temperature: args.temperature,
            maxOutputTokens: args.maxOutputTokens,
            responseMimeType: 'text/plain',
            thinkingConfig: { thinkingBudget: 0 },
          },
        };

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // OneCLI MITM が wire で本物の ADC Bearer に置き換える。host 側は placeholder で良い。
            Authorization: 'Bearer placeholder',
          },
          body: JSON.stringify(body),
          // 無期限ブロック防止 (VERTEX_TIMEOUT_MS 超過で AbortError → 呼び出し側 inspect() が HOLD)。
          signal: AbortSignal.timeout(VERTEX_TIMEOUT_MS),
        });

        if (!res.ok) {
          let bodyText = '';
          try {
            bodyText = (await res.text()).slice(0, 500);
          } catch (bodyErr) {
            // body 読み失敗自体を握り潰すと最終 error message が "— " (空) になり debug 不能。
            // エラー生成は続けるが、何が起きたかは warn で残す (silent failure 防止)。
            log.warn('vertex-client: failed to read error response body', {
              status: res.status,
              bodyErr,
            });
          }
          log.warn(
            'vertex.call failed',
            vertexLogFields(ctx, modelId, {
              outcome: 'failure',
              status: res.status,
              latency_ms: Math.round(performance.now() - t0),
              error_body_preview: bodyText.slice(0, 200),
            }),
          );
          throw new Error(`vertex-client: generateContent ${res.status} ${res.statusText} — ${bodyText}`);
        }

        const json = (await res.json()) as VertexGeminiResponse;
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof text !== 'string' || text.length === 0) {
          throw new Error(
            `vertex-client: response missing candidates[0].content.parts[0].text — ${JSON.stringify(json).slice(0, 300)}`,
          );
        }
        // usageMetadata 不在 (= Vertex API バージョン差 / streaming 経路) は BQ cost 集計が silent
        // に 0 になる罠を生むため warn で可視化。`?? 0` fallback は維持し、ログ集約は崩さない。
        if (!json.usageMetadata) {
          log.warn('vertex.call: usageMetadata absent', vertexLogFields(ctx, modelId));
        }
        log.info(
          'vertex.call',
          vertexLogFields(ctx, modelId, {
            outcome: 'success',
            tokens_in: json.usageMetadata?.promptTokenCount ?? 0,
            tokens_out: json.usageMetadata?.candidatesTokenCount ?? 0,
            latency_ms: Math.round(performance.now() - t0),
          }),
        );
        const usage = extractVertexUsage(json, 'gemini');
        if (usage.input_tokens != null) span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, usage.input_tokens);
        if (usage.output_tokens != null) span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, usage.output_tokens);
        return text;
      } catch (err) {
        // err が non-Error の場合に Cloud Trace の例外イベント / ERROR status の
        // message が undefined にならないよう instanceof guard で分岐。
        const errorRecord = err instanceof Error ? err : new Error(String(err));
        span.recordException(errorRecord);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorRecord.message });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/** `callVertexAnthropic` の引数。 */
export interface VertexAnthropicCallArgs {
  /** user turn のテキスト (system 文は別フィールド)。 */
  prompt: string;
  /**
   * system プロンプト (役割定義など)。null / undefined / 空文字 はいずれも body から
   * `system` フィールドを省く扱い (= 「空 system を渡すと proxy 経路で 400 が出るケースあり」
   * 対策)。「明示的に system を空にする」意味論は想定外なので、必要なら呼び出し側で
   * 非空 system を必ず渡すこと。
   */
  system?: string;
  /** 生成上限。CATEGORY/REASON の 2 行で十分なため小さく取って良い。 */
  maxTokens: number;
  /** 決定性目的なら 0。カテゴライズは 0 固定で呼ぶ想定。 */
  temperature: number;
  /** 既定は `.env` の `CATEGORIZE_MODEL`。差し替え用 (テスト/将来別用途)。 */
  modelId?: string;
}

/**
 * Vertex × Anthropic on Vertex の `:rawPredict` レスポンス。
 *
 * Anthropic は Gemini の `candidates[].content.parts[].text` と全く異なる構造で、
 * `content: Array<{ type: string; text?: string }>` を返す (GOTCHA-3)。`type === 'text'`
 * の要素を見つけてその `text` を取る。`stop_reason: 'max_tokens'` は応答が切れている
 * 兆候なので、呼び出し側で 1 行に収まっているかをチェックする (本クライアントは値を素通し)。
 */
interface VertexAnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  /** Anthropic Messages API は usage.{input,output}_tokens でトークン使用量を返す。 */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

/**
 * Vertex × Anthropic on Vertex を `:rawPredict` 経路で叩いて最初のテキストを返す。
 *
 * `callVertexGemini` と同じく fail-closed は **呼び出し側の責務** (本関数は失敗で必ず throw する):
 *   - `ANTHROPIC_VERTEX_PROJECT_ID` 未設定 / `CATEGORIZE_MODEL` 未設定 → 起動時に検知させる
 *   - fetch 自体の throw (proxy 未到達 / DNS / TLS) → そのまま伝播
 *   - `!res.ok` (4xx/5xx、特に Marketplace enable 未了の 403/404) → status + body 抜粋を message に含めて throw
 *   - `content[]` に `type === 'text'` の要素がない (= 応答形式崩れ) → throw
 */
export async function callVertexAnthropic(args: VertexAnthropicCallArgs, ctx?: VertexCallCtx): Promise<string> {
  const env = readEnvFile(['ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION', 'CATEGORIZE_MODEL']);
  const project = env.ANTHROPIC_VERTEX_PROJECT_ID;
  if (!project) {
    throw new Error('vertex-client: ANTHROPIC_VERTEX_PROJECT_ID is not set (.env / process.env both empty)');
  }
  const region = env.CLOUD_ML_REGION || DEFAULT_REGION;
  // `||` は空文字も falsy 扱い (`??` だと空文字を許容して 4xx → HOLD 経路を増やす罠) =
  // callVertexGemini と同じ方針で fail-fast にする。
  const modelId = args.modelId || env.CATEGORIZE_MODEL;
  if (!modelId) {
    throw new Error('vertex-client: CATEGORIZE_MODEL is not set (.env / process.env both empty)');
  }
  const url = vertexUrl(project, region, modelId, 'anthropic', 'rawPredict');
  const tracer = getTracer();
  return tracer.startActiveSpan(
    `${GEN_AI_OPERATION_CHAT} ${modelId}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        [GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_CHAT,
        [GEN_AI_PROVIDER_NAME]: GEN_AI_PROVIDER_GCP_VERTEX_AI,
        [GEN_AI_REQUEST_MODEL]: modelId,
        [SERVER_ADDRESS]: vertexHost(region),
        'biblio.request_id': ctx?.requestId,
        'biblio.session_id': ctx?.sessionId,
        'biblio.axis': ctx?.axis,
      },
    },
    async (span) => {
      const t0 = performance.now();
      try {
        // Anthropic on Vertex の body 必須フィールド (docs.anthropic.com/en/api/claude-on-vertex-ai):
        //   - anthropic_version: "vertex-2023-10-16" がリリース時点の固定値 (= バージョニング rail)
        //   - messages: 通常の Anthropic Messages API と同形 (user/assistant role の turn 配列)
        //   - system: 任意 (役割定義)。空のときは省略する (空文字を渡すと proxy 経路で 400 が出るケースあり)
        // GOTCHA-3 で書いた通り、response 構造は Gemini と完全に別物 (`candidates[]` ではなく `content[]`)。
        const body: Record<string, unknown> = {
          anthropic_version: 'vertex-2023-10-16',
          messages: [{ role: 'user', content: args.prompt }],
          max_tokens: args.maxTokens,
          temperature: args.temperature,
        };
        if (args.system) {
          body.system = args.system;
        }

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // OneCLI MITM が wire で本物の ADC Bearer に置き換える (callVertexGemini と同じ流儀)。
            Authorization: 'Bearer placeholder',
          },
          body: JSON.stringify(body),
          // 無期限ブロック防止 (callVertexGemini と同じ VERTEX_TIMEOUT_MS を共有)。
          signal: AbortSignal.timeout(VERTEX_TIMEOUT_MS),
        });

        if (!res.ok) {
          let bodyText = '';
          try {
            bodyText = (await res.text()).slice(0, 500);
          } catch (bodyErr) {
            // body 読み失敗自体を握り潰さない (callVertexGemini と同じ silent failure 防止)。
            log.warn('vertex-client: failed to read anthropic error response body', {
              status: res.status,
              bodyErr,
            });
          }
          log.warn(
            'vertex.call failed',
            vertexLogFields(ctx, modelId, {
              outcome: 'failure',
              status: res.status,
              latency_ms: Math.round(performance.now() - t0),
              error_body_preview: bodyText.slice(0, 200),
            }),
          );
          throw new Error(`vertex-client: rawPredict ${res.status} ${res.statusText} — ${bodyText}`);
        }

        const json = (await res.json()) as VertexAnthropicResponse;
        // `content[].type === 'text'` の最初の要素を採用する (`tool_use` 等の非テキスト turn が
        // 混ざる可能性に備える)。`stop_reason: 'max_tokens'` で切れているケースもここでは値を
        // そのまま返し、呼び出し側 (categorize.ts) が CATEGORY/REASON 2 行を抽出できなかった
        // ときに `parse_error` で fail-closed に倒す = 責務分離。
        const textBlock = json.content?.find((c) => c?.type === 'text');
        const text = textBlock?.text;
        if (typeof text !== 'string' || text.length === 0) {
          throw new Error(
            `vertex-client: response missing content[type=text].text — ${JSON.stringify(json).slice(0, 300)}`,
          );
        }
        if (!json.usage) {
          log.warn('vertex.call: usage absent', vertexLogFields(ctx, modelId));
        }
        const usage = extractVertexUsage(json, 'anthropic');
        // M4-C Phase 2: cache_read/cache_creation を log payload に unconditional emit
        // (?? 0) して llm-cost.sql の SUM 対象を有効化 + cost-calculator の warnings 消失。
        // span 属性は既存の conditional pattern を対称化 (= AnthropicVertexLlm.ts:317-325 と同流儀)。
        // review R6 (I2): cache_captured を独立 boolean で emit することで「未捕捉 (SDK 差)」と
        // 「実測 0 (cache 未使用)」を BQ 集計で区別可能に。cost 過小推定の可視化。
        const cacheCaptured = usage.cache_read_input_tokens != null && usage.cache_creation_input_tokens != null;
        log.info(
          'vertex.call',
          vertexLogFields(ctx, modelId, {
            outcome: 'success',
            tokens_in: usage.input_tokens ?? 0,
            tokens_out: usage.output_tokens ?? 0,
            cache_read: usage.cache_read_input_tokens ?? 0,
            cache_creation: usage.cache_creation_input_tokens ?? 0,
            cache_captured: cacheCaptured,
            latency_ms: Math.round(performance.now() - t0),
          }),
        );
        if (usage.input_tokens != null) span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, usage.input_tokens);
        if (usage.output_tokens != null) span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, usage.output_tokens);
        if (usage.cache_read_input_tokens != null) {
          span.setAttribute(GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, usage.cache_read_input_tokens);
        }
        if (usage.cache_creation_input_tokens != null) {
          span.setAttribute(GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS, usage.cache_creation_input_tokens);
        }
        return text;
      } catch (err) {
        // err が non-Error の場合に Cloud Trace の例外イベント / ERROR status の
        // message が undefined にならないよう instanceof guard で分岐。
        const errorRecord = err instanceof Error ? err : new Error(String(err));
        span.recordException(errorRecord);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorRecord.message });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/** `callVertexGeminiJson` の引数。`responseSchema` は Vertex 側 JSON Schema (type UPPERCASE)。 */
export interface VertexJsonCallArgs {
  /** 入力テキスト (system 不要、user 1 turn 想定で十分)。 */
  prompt: string;
  /** 生成上限。JSON 応答は 3 分類 + reason 100 chars 目安で 64 tokens で十分。 */
  maxOutputTokens: number;
  /** 決定性目的なら 0。gate 判定は 0 固定で呼ぶ想定。 */
  temperature: number;
  /**
   * Vertex Gemini の `responseSchema` フィールドに直接載せる JSON Schema オブジェクト。
   *
   * **GOTCHA**: Vertex Gemini の `type` は **UPPERCASE** (`OBJECT` /
   * `STRING` / `NUMBER` 等)、Anthropic の JSON Schema は lowercase (`object` / `string`)。
   * ADK 経由の `simple_zod_to_json.ts` (`normalizeSchema`) は逆方向 (UPPERCASE → lowercase)
   * のため**流用しない**。呼び出し側 (Layer 4 evaluator) が Vertex 形式で直接 literal
   * 生成する。TODO: 将来 `responseFormat` (2026-07 時点 deprecated 表記だが機能する
   * `responseSchema` の後継) 移行判断。
   */
  responseSchema: Record<string, unknown>;
  /**
   * ハードタイムアウト (ms)。gate 判定は fast path なので既定 3000ms
   * (fugue/patron 体感悪化を招かないため)。**`GATE_TIMEOUT_MS` env の解決は呼出元
   * (`src/gate/layer4-evaluator.ts:readGateTimeoutMs`) の責務**、本関数は解決済の値を
   * 受け取るのみで env を直接読まない。
   */
  timeoutMs?: number;
  /** 既定は `.env` の `GATE_MODEL` (fallback `gemini-3.1-flash-lite`)。差し替え用 (テストなど)。 */
  modelId?: string;
}

/** JSON schema 強制版 Gemini 応答 (parts[0].text は JSON 文字列)。 */
interface VertexGeminiJsonResponse extends VertexGeminiResponse {}

/**
 * Vertex × Gemini を `:generateContent` 経路で JSON schema 強制で叩き、`JSON.parse` 済 unknown を返す。
 *
 * 既存 `callVertexGemini` (dangerous 軸判定用、text/plain response) は touch しない。M4-F
 * Phase 2 gate Layer 4 evaluator (`src/gate/layer4-evaluator.ts`) 専用の JSON schema 強制版。
 *
 * 応答 shape:
 *   - `generationConfig.responseMimeType: 'application/json'` + `generationConfig.responseSchema`
 *     で Vertex 側が JSON 応答を強制、`candidates[0].content.parts[0].text` に JSON 文字列が入る
 *   - 本関数は `JSON.parse(text)` を実行して unknown を返す (Zod validate は呼び出し側 Layer 4 で)
 *
 * fallback は呼び出し側 (Layer 4 evaluator) の責務: 本関数は失敗で throw する
 * (invalid JSON / 4xx / 5xx / timeout 全て throw)。Layer 4 が catch して
 * `classification: 'biblio-other'` fallback (対話が既定の受け皿) に倒す。
 */
export async function callVertexGeminiJson(args: VertexJsonCallArgs, ctx?: VertexCallCtx): Promise<unknown> {
  const env = readEnvFile(['ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION', 'GATE_MODEL']);
  const project = env.ANTHROPIC_VERTEX_PROJECT_ID;
  if (!project) {
    throw new Error('vertex-client: ANTHROPIC_VERTEX_PROJECT_ID is not set (.env / process.env both empty)');
  }
  const region = env.CLOUD_ML_REGION || DEFAULT_REGION;
  // `GATE_MODEL` の 3 層 fallback: 明示 arg > .env > default 'gemini-3.1-flash-lite'。
  const modelId = args.modelId || env.GATE_MODEL || 'gemini-3.1-flash-lite';
  const timeoutMs = args.timeoutMs ?? 3000;
  const url = vertexUrl(project, region, modelId, 'google', 'generateContent');
  const tracer = getTracer();
  return tracer.startActiveSpan(
    `${GEN_AI_OPERATION_CHAT} ${modelId}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        [GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_CHAT,
        [GEN_AI_PROVIDER_NAME]: GEN_AI_PROVIDER_GCP_VERTEX_AI,
        [GEN_AI_REQUEST_MODEL]: modelId,
        [SERVER_ADDRESS]: vertexHost(region),
        'biblio.request_id': ctx?.requestId,
        'biblio.session_id': ctx?.sessionId,
        'biblio.axis': ctx?.axis ?? 'gate',
      },
    },
    async (span) => {
      const t0 = performance.now();
      try {
        // JSON schema 強制モード + thinking OFF (gate 判定は VERDICT 1 行相当なので thinking 不要)。
        const body = {
          contents: [{ role: 'user', parts: [{ text: args.prompt }] }],
          generationConfig: {
            temperature: args.temperature,
            maxOutputTokens: args.maxOutputTokens,
            responseMimeType: 'application/json',
            responseSchema: args.responseSchema,
            thinkingConfig: { thinkingBudget: 0 },
          },
        };

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer placeholder',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok) {
          let bodyText = '';
          try {
            bodyText = (await res.text()).slice(0, 500);
          } catch (bodyErr) {
            log.warn('vertex-client: failed to read json error response body', {
              status: res.status,
              bodyErr,
            });
          }
          log.warn(
            'vertex.call failed',
            vertexLogFields(ctx, modelId, {
              outcome: 'failure',
              status: res.status,
              latency_ms: Math.round(performance.now() - t0),
              error_body_preview: bodyText.slice(0, 200),
            }),
          );
          throw new Error(`vertex-client: generateContent (json) ${res.status} ${res.statusText} — ${bodyText}`);
        }

        const json = (await res.json()) as VertexGeminiJsonResponse;
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof text !== 'string' || text.length === 0) {
          throw new Error(
            `vertex-client: json response missing candidates[0].content.parts[0].text — ${JSON.stringify(json).slice(0, 300)}`,
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (parseErr) {
          throw new Error(`vertex-client: response text is not valid JSON — text=${text.slice(0, 200)}`, {
            cause: parseErr,
          });
        }
        if (!json.usageMetadata) {
          log.warn('vertex.call: usageMetadata absent (json)', vertexLogFields(ctx, modelId));
        }
        log.info(
          'vertex.call',
          vertexLogFields(ctx, modelId, {
            outcome: 'success',
            tokens_in: json.usageMetadata?.promptTokenCount ?? 0,
            tokens_out: json.usageMetadata?.candidatesTokenCount ?? 0,
            latency_ms: Math.round(performance.now() - t0),
          }),
        );
        const usage = extractVertexUsage(json, 'gemini');
        if (usage.input_tokens != null) span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, usage.input_tokens);
        if (usage.output_tokens != null) span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, usage.output_tokens);
        return parsed;
      } catch (err) {
        const errorRecord = err instanceof Error ? err : new Error(String(err));
        span.recordException(errorRecord);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorRecord.message });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
