/**
 * Vertex AI × Gemini 呼び出しクライアント — 検品 dangerous 軸の判定に使う。
 *
 * Phase 2 検品の dangerous 軸は host (Node 22) から Vertex の `:generateContent`
 * (Gemini Vertex API) を直接叩く。OneCLI MITM proxy が Authorization を wire で本物の
 * ADC Bearer に書き換えるため、host 側は `Bearer placeholder` を載せて proxy + 自前 CA に
 * 到達できれば良い。Anthropic ではなく Google 1st party モデル (publishers/google) なので、
 * Vertex AI API が enable 済の project (= biblio-claw が agent で利用中) で追加の Marketplace
 * enable は不要 (= local/GKE 共に DEN さんの GCP 作業ゼロで動く)。
 *
 * モデルは `.env` の `INSPECT_DANGEROUS_MODEL` で指定する (例: `gemini-2.5-flash`)。
 * 既定値はあえて持たない: 検品ロジックをハードコードしたモデル ID に縛り付けない方針
 * (DEN さん指示)。未設定なら起動時に warn + 検品時 throw → inspect() が fail-closed (HOLD)。
 *
 * Node built-in fetch は `dispatcher` オプションを公開しないため (nodejs/node#43187)、
 * `undici` を依存に追加し `ProxyAgent` を `setGlobalDispatcher` で global 適用する。
 * agent (claude-code) 経路は providers/claude.ts + secret/onecli.ts が env で配線するが、
 * host fetch はこのクライアントが proxy + CA を ProxyAgent で動的に効かせる。
 *
 * 用途規約 (CLAUDE.md / DEN さん指針): NanoClaw ネイティブ + Claude 特性不要な host 側補助
 * 推論 (= 本クライアント) には Google モデル可、skill 発動に絡む推論 (カテゴライズ等) は
 * Anthropic 必須。Phase 2 検品 dangerous 軸はこの第 1 例。
 *
 * 失敗 (`!res.ok` / fetch throw / `candidates[0].content.parts[0].text` 不在) は throw —
 * 呼び出し側 (`inspect()`) が catch して fail-closed (HOLD/inspect_error) に倒す。
 */
import fs from 'node:fs';

import { ProxyAgent, fetch, setGlobalDispatcher } from 'undici';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { getProxyState } from './host-proxy.js';

/** region 既定値 — providers/claude.ts:39 に揃える (CLOUD_ML_REGION 未設定なら global)。 */
const DEFAULT_REGION = 'global';

/** Vertex `:generateContent` 呼び出しの host (region によって変わる)。 */
function vertexHost(region: string): string {
  return region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
}

/** Vertex `:generateContent` URL を組む (`publishers/google/<modelId>` = Google 1st party)。 */
function vertexUrl(project: string, region: string, modelId: string): string {
  return (
    `https://${vertexHost(region)}/v1/projects/${project}/locations/${region}` +
    `/publishers/google/models/${modelId}:generateContent`
  );
}

/**
 * host からの fetch を OneCLI MITM proxy + 自前 CA 経由にする。
 *
 * - `getProxyState()` から proxy URL と CA path を取り、両方解決済みなら
 *   `ProxyAgent({ uri, requestTls: { ca }, proxyTls: { ca } })` を global dispatcher に。
 * - `NODE_EXTRA_CA_CERTS` は undici ProxyAgent の TLS には**効かない**ため、PEM を
 *   `requestTls.ca` + `proxyTls.ca` に明示的に渡す必要がある (plan GOTCHA)。
 * - proxy 未解決 (fail-open) はスキップ — fetch は直接 Vertex に向かい、TLS / 認可で
 *   失敗して呼び出し側で fail-closed に倒れる (ハングしない)。
 *
 * 冪等: 多重呼び出ししても最後に設定した dispatcher が有効になるだけ。host 起動時に
 * `initHostProxy()` の直後で 1 回呼ぶ想定。
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
  const dispatcher = new ProxyAgent({
    uri: httpsProxy,
    requestTls: { ca },
    proxyTls: { ca },
  });
  setGlobalDispatcher(dispatcher);
  log.info('vertex-client: ProxyAgent installed as global dispatcher', { httpsProxy, caPath });
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
export async function callVertexGemini(args: VertexCallArgs): Promise<string> {
  const env = readEnvFile(['ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION', 'INSPECT_DANGEROUS_MODEL']);
  const project = env.ANTHROPIC_VERTEX_PROJECT_ID;
  if (!project) {
    throw new Error('vertex-client: ANTHROPIC_VERTEX_PROJECT_ID is not set (.env / process.env both empty)');
  }
  const region = env.CLOUD_ML_REGION || DEFAULT_REGION;
  const modelId = args.modelId ?? env.INSPECT_DANGEROUS_MODEL;
  if (!modelId) {
    throw new Error('vertex-client: INSPECT_DANGEROUS_MODEL is not set (.env / process.env both empty)');
  }
  const url = vertexUrl(project, region, modelId);

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
  });

  if (!res.ok) {
    let bodyText = '';
    try {
      bodyText = (await res.text()).slice(0, 500);
    } catch {
      // body 読みに失敗してもエラー生成は続ける (silent failure 防止)。
    }
    throw new Error(`vertex-client: generateContent ${res.status} ${res.statusText} — ${bodyText}`);
  }

  const json = (await res.json()) as VertexGeminiResponse;
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error(
      `vertex-client: response missing candidates[0].content.parts[0].text — ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return text;
}
