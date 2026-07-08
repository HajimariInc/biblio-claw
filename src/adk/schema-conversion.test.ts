/**
 * schema-conversion のユニットテスト。
 *
 * `normalizeSchema` + `toAnthropicTools` の純粋関数 2 つを検証する。`@google/adk` の
 * `simple_zod_to_json.ts` が出す UPPERCASE Schema → Anthropic Messages API の lowercase
 * `input_schema` 変換が壊れていないこと、不正入力で silent failure に倒れないこと、
 * tool name 不在で warn + skip 経路が走ることを確認する。
 *
 * **vi.mock パターン**:
 *   - `log.js` を stub して `log.warn` 呼び出しを assert (= `llm-registry-setup.test.ts` 流儀)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { normalizeSchema, toAnthropicTools } from './schema-conversion.js';
import { log } from '../log.js';

beforeEach(() => {
  vi.mocked(log.debug).mockReset();
  vi.mocked(log.info).mockReset();
  vi.mocked(log.warn).mockReset();
  vi.mocked(log.error).mockReset();
});

describe('normalizeSchema — UPPERCASE → lowercase 再帰正規化', () => {
  it('単純な OBJECT + STRING property を lowercase 化する', () => {
    const input = {
      type: 'OBJECT',
      properties: { repo: { type: 'STRING' } },
    };
    expect(normalizeSchema(input)).toEqual({
      type: 'object',
      properties: { repo: { type: 'string' } },
    });
  });

  it('nested OBJECT (= properties 内の OBJECT) を再帰的に lowercase 化する', () => {
    const input = {
      type: 'OBJECT',
      properties: {
        nested: {
          type: 'OBJECT',
          properties: { inner: { type: 'INTEGER' } },
        },
      },
    };
    expect(normalizeSchema(input)).toEqual({
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: { inner: { type: 'integer' } },
        },
      },
    });
  });

  it('ARRAY + items の OBJECT を再帰的に lowercase 化する', () => {
    const input = {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { id: { type: 'STRING' } },
      },
    };
    expect(normalizeSchema(input)).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' } },
      },
    });
  });

  it('enum / required / description は pass-through (= 大文字小文字以外は触らない)', () => {
    const input = {
      type: 'STRING',
      enum: ['acquire', 'inspect', 'shelve'],
      description: 'biblio operation type',
    };
    expect(normalizeSchema(input)).toEqual({
      type: 'string',
      enum: ['acquire', 'inspect', 'shelve'],
      description: 'biblio operation type',
    });
  });

  it('required 配列 + properties 混在を保ったまま type のみ lowercase 化する', () => {
    const input = {
      type: 'OBJECT',
      properties: {
        repo: { type: 'STRING' },
        category: { type: 'STRING', enum: ['tools', 'docs'] },
      },
      required: ['repo'],
    };
    expect(normalizeSchema(input)).toEqual({
      type: 'object',
      properties: {
        repo: { type: 'string' },
        category: { type: 'string', enum: ['tools', 'docs'] },
      },
      required: ['repo'],
    });
  });

  it('不正入力 (null / undefined / string / number) は空オブジェクト {} を返す', () => {
    expect(normalizeSchema(null)).toEqual({});
    expect(normalizeSchema(undefined)).toEqual({});
    expect(normalizeSchema('not a schema')).toEqual({});
    expect(normalizeSchema(42)).toEqual({});
  });

  it('type が大文字小文字混在 ("Object") でも一律 lowercase 化する', () => {
    const input = { type: 'Object', properties: { x: { type: 'String' } } };
    expect(normalizeSchema(input)).toEqual({
      type: 'object',
      properties: { x: { type: 'string' } },
    });
  });

  it('minLength / maxLength が string で来たとき数値型に coerce (= ADK simple_zod_to_json bug 対応)', () => {
    const input = {
      type: 'STRING',
      minLength: '1',
      maxLength: '200',
    };
    expect(normalizeSchema(input)).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 200,
    });
  });

  it('数値メタフィールド (minimum / maximum / minItems / maxItems / multipleOf) も string → number coerce', () => {
    const input = {
      type: 'OBJECT',
      properties: {
        n: { type: 'NUMBER', minimum: '0', maximum: '100', multipleOf: '5' },
        arr: { type: 'ARRAY', minItems: '1', maxItems: '10' },
      },
    };
    const r = normalizeSchema(input);
    const n = (r.properties as Record<string, Record<string, unknown>>).n;
    const arr = (r.properties as Record<string, Record<string, unknown>>).arr;
    expect(n).toEqual({ type: 'number', minimum: 0, maximum: 100, multipleOf: 5 });
    expect(arr).toEqual({ type: 'array', minItems: 1, maxItems: 10 });
  });

  it('数値メタフィールドが既に数値型なら pass-through', () => {
    const input = { type: 'STRING', minLength: 1, maxLength: 200 };
    expect(normalizeSchema(input)).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 200,
    });
  });

  it('不正な数値 string ("abc") は pass-through (= Anthropic 側 validator に判断委譲)', () => {
    const input = { type: 'STRING', minLength: 'abc' };
    expect(normalizeSchema(input)).toEqual({
      type: 'string',
      minLength: 'abc',
    });
  });
});

describe('toAnthropicTools — ADK config.tools → Anthropic Tool[] 変換', () => {
  it('単一 functionDeclaration を変換 (= name / description / input_schema)', () => {
    const input = [
      {
        functionDeclarations: [
          {
            name: 'acquire_biblio',
            description: 'Acquire a skill',
            parameters: {
              type: 'OBJECT',
              properties: { repo: { type: 'STRING' } },
            },
          },
        ],
      },
    ];
    expect(toAnthropicTools(input)).toEqual([
      {
        name: 'acquire_biblio',
        description: 'Acquire a skill',
        input_schema: {
          type: 'object',
          properties: { repo: { type: 'string' } },
        },
      },
    ]);
  });

  it('複数 functionDeclarations を 1 entry 内で並列変換 (= 3 つ全て返る)', () => {
    const input = [
      {
        functionDeclarations: [
          { name: 'acquire_biblio', description: 'A', parameters: { type: 'OBJECT' } },
          { name: 'inspect_biblio', description: 'B', parameters: { type: 'OBJECT' } },
          { name: 'shelve_biblio', description: 'C', parameters: { type: 'OBJECT' } },
        ],
      },
    ];
    const result = toAnthropicTools(input);
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.name)).toEqual(['acquire_biblio', 'inspect_biblio', 'shelve_biblio']);
    expect(result.every((t) => t.input_schema.type === 'object')).toBe(true);
  });

  it('複数 entry (= 2 grouping) もまとめて変換', () => {
    const input = [
      {
        functionDeclarations: [{ name: 'a', parameters: { type: 'OBJECT' } }],
      },
      {
        functionDeclarations: [{ name: 'b', parameters: { type: 'OBJECT' } }],
      },
    ];
    const result = toAnthropicTools(input);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('name 不在の entry は warn + skip (= silent failure 撲滅)', () => {
    const input = [
      {
        functionDeclarations: [
          { description: 'no name', parameters: { type: 'OBJECT' } },
          { name: 'valid_tool', parameters: { type: 'OBJECT' } },
        ],
      },
    ];
    const result = toAnthropicTools(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('valid_tool');
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: 'adk.tool_conversion.skip_no_name',
        outcome: 'skipped',
      }),
    );
  });

  it('name が string でない (= number) entry も warn + skip', () => {
    const input = [
      {
        functionDeclarations: [{ name: 42 as unknown as string, parameters: { type: 'OBJECT' } }],
      },
    ];
    expect(toAnthropicTools(input)).toEqual([]);
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
  });

  it('parameters 不在 → input_schema が {type: "object"} 最小スケルトンで fallback', () => {
    const input = [
      {
        functionDeclarations: [{ name: 'no_params' }],
      },
    ];
    const result = toAnthropicTools(input);
    expect(result).toHaveLength(1);
    expect(result[0].input_schema).toEqual({ type: 'object' });
  });

  it('parameters が不正な型 (= string) でも {type: "object"} で fallback + log.warn (silent failure 撲滅)', () => {
    const input = [
      {
        functionDeclarations: [{ name: 'bad_params', parameters: 'not a schema' }],
      },
    ];
    const result = toAnthropicTools(input);
    expect(result[0].input_schema).toEqual({ type: 'object' });
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: 'adk.tool_conversion.invalid_parameters',
        outcome: 'fallback_empty_schema',
        tool_name: 'bad_params',
        parameters_type: 'string',
      }),
    );
  });

  it('description が string でないとき omit される (= Anthropic 仕様で optional)', () => {
    const input = [
      {
        functionDeclarations: [
          {
            name: 'no_description',
            description: 42 as unknown as string,
            parameters: { type: 'OBJECT' },
          },
        ],
      },
    ];
    const result = toAnthropicTools(input);
    expect(result[0]).not.toHaveProperty('description');
    expect(result[0].name).toBe('no_description');
  });

  it('入力が配列でない (= null / undefined / object) → 空配列', () => {
    expect(toAnthropicTools(null)).toEqual([]);
    expect(toAnthropicTools(undefined)).toEqual([]);
    expect(toAnthropicTools({})).toEqual([]);
  });

  it('functionDeclarations が空 / 未定義 → 該当 entry は skip (= 結果空)', () => {
    expect(toAnthropicTools([{}])).toEqual([]);
    expect(toAnthropicTools([{ functionDeclarations: [] }])).toEqual([]);
    expect(toAnthropicTools([{ functionDeclarations: undefined }])).toEqual([]);
  });

  it('nested object parameters を再帰的に lowercase 化', () => {
    const input = [
      {
        functionDeclarations: [
          {
            name: 'nested_param',
            parameters: {
              type: 'OBJECT',
              properties: {
                config: {
                  type: 'OBJECT',
                  properties: { level: { type: 'INTEGER' } },
                },
              },
            },
          },
        ],
      },
    ];
    const result = toAnthropicTools(input);
    expect(result[0].input_schema).toEqual({
      type: 'object',
      properties: {
        config: {
          type: 'object',
          properties: { level: { type: 'integer' } },
        },
      },
    });
  });
});
