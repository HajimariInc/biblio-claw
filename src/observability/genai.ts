// gen_ai.* semconv (semantic-conventions@1.41.1 incubating、定数 hardcode で /incubating import 不使用)
// 参照: https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/
//       https://opentelemetry.io/docs/specs/semconv/gen-ai/anthropic/
export const GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
export const GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name';
export const GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
export const GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
export const GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS = 'gen_ai.usage.cache_read.input_tokens';
export const SERVER_ADDRESS = 'server.address';

// Vertex AI 経由 = gcp.vertex_ai (= 直接 API anthropic とは区別、公式 Anthropic semconv 準拠)
export const GEN_AI_PROVIDER_GCP_VERTEX_AI = 'gcp.vertex_ai';
export const GEN_AI_OPERATION_CHAT = 'chat';

export interface GenAIUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}

/** vertex response から semconv usage を抽出 (Gemini/Anthropic 両対応) */
export function extractVertexUsage(json: unknown, provider: 'gemini' | 'anthropic'): GenAIUsage {
  if (provider === 'gemini') {
    const meta = (json as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } })
      .usageMetadata;
    return { input_tokens: meta?.promptTokenCount, output_tokens: meta?.candidatesTokenCount };
  }
  const u = (
    json as {
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
    }
  ).usage;
  return {
    input_tokens: u?.input_tokens,
    output_tokens: u?.output_tokens,
    cache_read_input_tokens: u?.cache_read_input_tokens,
  };
}
