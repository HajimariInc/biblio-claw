/**
 * Schema 変換ヘルパ — ADK `FunctionDeclaration` (= Gemini 流儀 UPPERCASE Schema) を
 * Anthropic `Tool[]` (= JSON Schema lowercase + `input_schema` 必須) に変換する純粋関数集
 * (M4-B Phase 2)。
 *
 * **背景**:
 *   - ADK 1.3.0 (`@google/adk`) は内部の `simple_zod_to_json.ts` で Zod schema を Gemini 系の
 *     Schema 型に変換する際、`type` フィールドを `"OBJECT"` / `"STRING"` 等の UPPERCASE で吐く
 *     (= `@google/genai` の `Type` enum 流儀)
 *   - Anthropic Messages API の `input_schema` は JSON Schema 流儀の lowercase (`"object"` /
 *     `"string"`) を要求する
 *   - 違いは `type` フィールドの大文字小文字のみで、その他は概ね JSON Schema 互換
 *   - → 受け取った schema を再帰的に `type.toLowerCase()` するだけで Anthropic API に渡せる
 *
 * **設計判断 (Phase 2 plan §意思決定ログ)**:
 *   - 外部 dep (`pailat/adk-llm-bridge` / `zod-to-json-schema`) は追加しない (= ソース写経のみ)
 *   - `normalizeSchema` は `type` のみ正規化 + 残りは pass-through (= 過剰検証を避ける)
 *   - `toAnthropicTools` の name 不在は warn + skip (= silent failure 撲滅)
 *   - `parameters` 不在 / 不正なら `{type:'object'}` の最小スケルトンを返す (= Anthropic は
 *     `input_schema` 必須、空オブジェクトでは 400 エラー)
 *
 * **写経元**:
 *   - `pailat/adk-llm-bridge` `src/converters/schema.ts` (= `normalizeSharedSchema`)
 *   - `pailat/adk-llm-bridge` `src/providers/anthropic/converters/request.ts` (= `convertTools`)
 *   - Anthropic SDK `Tool` 型: `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:1184`
 */
import { log } from '../log.js';

/**
 * Anthropic SDK の `Tool` 型 — subpath export 制限で `@anthropic-ai/sdk` から直接 import 不可
 * (= `@anthropic-ai/vertex-sdk` の transitive dep)。structural narrow で代替する。
 *
 * **`input_schema.type: 'object'` リテラル必須** — SDK の `InputSchema` は `type: 'object'` を
 * 必須としており、`Record<string, unknown>` のままでは `messages.create()` の overload 解決で
 * type narrow に失敗する (= `Property 'type' is missing in type` エラー)。
 */
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
}

/** ADK `config.tools[].functionDeclarations[]` の最小 narrow。 */
interface AdkFunctionDeclaration {
  name?: string;
  description?: string;
  parameters?: unknown;
}

/** ADK `config.tools` のエントリ shape (= `appendTools()` が格納する形)。 */
interface AdkToolEntry {
  functionDeclarations?: AdkFunctionDeclaration[];
}

/**
 * JSON Schema draft 2020-12 で **数値型** が要求される検証メタフィールド。ADK の
 * `simple_zod_to_json.ts` は zod v4 の `.min(n)` / `.max(n)` を **string** として出力する経路が
 * あり (= 例: `minLength: "1"`)、そのまま Anthropic API に渡すと `tools.N.custom.input_schema:
 * JSON schema is invalid` で 400 reject される。本ヘルパで `Number()` 経由で coerce する。
 *
 * 対象フィールド (= draft 2020-12 validator が数値型を要求するもの):
 *   - `minLength` / `maxLength` (= string 長制約)
 *   - `minimum` / `maximum` / `exclusiveMinimum` / `exclusiveMaximum` (= number 範囲制約)
 *   - `minItems` / `maxItems` (= array 長制約)
 *   - `minProperties` / `maxProperties` (= object key 数制約)
 *   - `multipleOf` (= number 倍数制約)
 */
const NUMERIC_META_FIELDS = new Set([
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'multipleOf',
]);

/**
 * ADK / Gemini 流儀 UPPERCASE Schema (= `{type: "OBJECT", ...}`) を JSON Schema 流儀
 * lowercase (= `{type: "object", ...}`) に再帰的に正規化する。
 *
 * 既知の UPPERCASE 値: `"OBJECT"` / `"ARRAY"` / `"STRING"` / `"NUMBER"` / `"INTEGER"` /
 * `"BOOLEAN"` / `"NULL"` (= `@google/genai` Schema 型の `Type` enum + ADK の
 * `simple_zod_to_json.ts` 出力に基づく)。
 *
 * 動作:
 *   - 入力が object でないなら `{}` を返す (= 不正入力の silent failure 撲滅 fallback)
 *   - `type` が string なら `.toLowerCase()` で正規化 (= `"Object"` のような混在も吸収)
 *   - `properties` (object) は各値を再帰
 *   - `items` (object) は再帰 (= array の要素 schema)
 *   - **`minLength` / `maxLength` 等の数値メタフィールドが string で来たとき数値型に coerce**
 *     (= ADK の simple_zod_to_json.ts が `.min(1).max(200)` を `minLength: "1"` で出力するため、
 *     Anthropic の draft 2020-12 validator が reject するのを防ぐ)
 *   - 残りのフィールド (= `enum` / `required` / `description` 等) は pass-through で保持
 */
export function normalizeSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null) return {};
  const s = schema as Record<string, unknown>;
  const result: Record<string, unknown> = { ...s };
  if (typeof s.type === 'string') {
    result.type = s.type.toLowerCase();
  }
  if (s.properties && typeof s.properties === 'object') {
    const props = s.properties as Record<string, unknown>;
    const normalizedProps: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(props)) {
      normalizedProps[key] = normalizeSchema(val);
    }
    result.properties = normalizedProps;
  }
  if (s.items && typeof s.items === 'object') {
    result.items = normalizeSchema(s.items);
  }
  // draft 2020-12 数値メタフィールドの string → number coerce。
  // `Number('1') === 1` だが `Number('abc') === NaN` のため、有限数のときだけ書き戻す
  // (= 不正値は pass-through で Anthropic 側 validator に判断を委ねる、silent failure 撲滅)。
  for (const field of NUMERIC_META_FIELDS) {
    const v = s[field];
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) {
        result[field] = n;
      }
    }
  }
  return result;
}

/**
 * ADK runner が `appendTools()` で `LlmRequest.config.tools` に格納する
 * `Array<{ functionDeclarations: FunctionDeclaration[] }>` を Anthropic `Tool[]` に変換する。
 *
 * **エッジケース対応**:
 *   - 入力が配列でない (= `null` / `undefined` / object) → 空配列
 *   - `functionDeclarations` が空 / 未定義 → 該当 entry は skip (= 何も追加しない)
 *   - tool `name` が string でない / 空 → warn + skip (= silent failure 撲滅)
 *   - `parameters` が不正で `normalizeSchema` が `{}` を返す → `{type:'object'}` で fallback
 *     (= Anthropic は `input_schema` 必須、空オブジェクトのままだと 400 エラー)
 *   - `description` が string でない → omit (= Anthropic 仕様で description は optional)
 *
 * **Anthropic 仕様の制約 (Phase 2 では SDK 側に委任)**:
 *   - `name` regex `^[a-zA-Z0-9_-]{1,64}$` のチェックは行わず Anthropic API 側に任せる
 *     (= biblio-claw が登録する acquire_biblio / inspect_biblio / shelve_biblio は全て OK)
 *
 * **Phase 2 で対応しない事項** (= Phase 3+ で再評価):
 *   - `parametersJsonSchema` フィールド (= ADK 1.4.0+ で追加候補) は読まない、`parameters`
 *     のみ採用
 *   - `type` フィールドの大文字小文字以外の schema 差分 (= `format` 等のメタフィールド) も
 *     pass-through で扱う (= 追加の正規化は不要)
 */
export function toAnthropicTools(adkTools: unknown): AnthropicTool[] {
  if (!Array.isArray(adkTools)) return [];
  const result: AnthropicTool[] = [];
  for (const entry of adkTools as AdkToolEntry[]) {
    const fns = entry?.functionDeclarations ?? [];
    if (!Array.isArray(fns)) continue;
    for (const fn of fns) {
      if (!fn?.name || typeof fn.name !== 'string') {
        log.warn('toAnthropicTools: tool with missing name skipped', {
          event: 'adk.tool_conversion.skip_no_name',
          outcome: 'skipped',
        });
        continue;
      }
      const normalized = normalizeSchema(fn.parameters);
      // Anthropic は `input_schema.type: 'object'` 必須 (= SDK の `InputSchema` 型リテラル制約)。
      // `normalizeSchema` の結果が他 type / 不在のときは強制的に `'object'` に倒す
      // (= `parameters` 不在 / 不正経路の最小スケルトン fallback、silent failure 撲滅)。
      const inputSchema: AnthropicTool['input_schema'] = {
        ...normalized,
        type: 'object',
      };
      const tool: AnthropicTool = {
        name: fn.name,
        input_schema: inputSchema,
      };
      if (typeof fn.description === 'string') {
        tool.description = fn.description;
      }
      result.push(tool);
    }
  }
  return result;
}
