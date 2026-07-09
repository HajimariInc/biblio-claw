// gen_ai.* semconv 定数 (hardcode)。
//
// @opentelemetry/semantic-conventions/incubating の export は **マイナーリリースで
// 破壊的変更** が入る可能性があり (= GenAI semconv は Development ステータス)、SDK の
// 1.41.1 で動いた import path が 1.42.0 で消える経路がある。文字列 hardcode +
// 本コメントの公式参照で「将来 spec 変更を踏んだら定数文字列を直に書き換える」
// 追従義務を明示する方が、import で silent に破壊変更を吸い込むより安全。
//
// 参照: https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/
//       https://opentelemetry.io/docs/specs/semconv/gen-ai/anthropic/
export const GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
export const GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name';
export const GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
export const GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
export const GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS = 'gen_ai.usage.cache_read.input_tokens';
export const GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS = 'gen_ai.usage.cache_creation.input_tokens';
export const SERVER_ADDRESS = 'server.address';

// Vertex AI 経由 = gcp.vertex_ai (= 直接 API anthropic とは区別、公式 Anthropic semconv 準拠)
export const GEN_AI_PROVIDER_GCP_VERTEX_AI = 'gcp.vertex_ai';
export const GEN_AI_OPERATION_CHAT = 'chat';

export interface GenAIUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** vertex response から semconv usage を抽出 (Gemini/Anthropic 両対応) */
export function extractVertexUsage(json: unknown, provider: 'gemini' | 'anthropic'): GenAIUsage {
  // 型署名 `unknown` が「何でも来うる」と約束しているのに型アサーションで直接 property access
  // していたため、`null` や非オブジェクトで TypeError になっていた。
  // 呼び出し元は fetch 成功後の JSON だが、型の約束を満たして防御完結する。
  if (typeof json !== 'object' || json === null) return {};
  if (provider === 'gemini') {
    const meta = (json as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } })
      .usageMetadata;
    return { input_tokens: meta?.promptTokenCount, output_tokens: meta?.candidatesTokenCount };
  }
  const u = (
    json as {
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    }
  ).usage;
  return {
    input_tokens: u?.input_tokens,
    output_tokens: u?.output_tokens,
    cache_read_input_tokens: u?.cache_read_input_tokens,
    cache_creation_input_tokens: u?.cache_creation_input_tokens,
  };
}
