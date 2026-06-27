import { describe, expect, it } from 'vitest';
import { extractVertexUsage } from '../genai.js';

describe('extractVertexUsage', () => {
  it('Gemini response から usageMetadata を抽出する', () => {
    const json = { usageMetadata: { promptTokenCount: 123, candidatesTokenCount: 456 } };
    const usage = extractVertexUsage(json, 'gemini');
    expect(usage.input_tokens).toBe(123);
    expect(usage.output_tokens).toBe(456);
    expect(usage.cache_read_input_tokens).toBeUndefined();
  });

  it('Gemini response で usageMetadata 不在時は全て undefined', () => {
    const usage = extractVertexUsage({}, 'gemini');
    expect(usage.input_tokens).toBeUndefined();
    expect(usage.output_tokens).toBeUndefined();
  });

  it('Anthropic response から usage 3 種を抽出する', () => {
    const json = {
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
    };
    const usage = extractVertexUsage(json, 'anthropic');
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(20);
    expect(usage.cache_read_input_tokens).toBe(5);
  });

  it('Anthropic response で cache_read_input_tokens 不在時は undefined', () => {
    const json = { usage: { input_tokens: 10, output_tokens: 20 } };
    const usage = extractVertexUsage(json, 'anthropic');
    expect(usage.cache_read_input_tokens).toBeUndefined();
  });

  it('Anthropic response で cache_read_input_tokens=0 は 0 を返す', () => {
    const json = { usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0 } };
    const usage = extractVertexUsage(json, 'anthropic');
    expect(usage.cache_read_input_tokens).toBe(0);
  });
});
