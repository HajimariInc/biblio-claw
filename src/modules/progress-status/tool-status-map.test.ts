/**
 * M4-F Phase 4: tool-status-map の unit test。
 *
 * カバー範囲:
 *   - SDK 組み込み 18 種 (TOOL_ALLOWLIST 全種) の完全 case (PR #145 review IM-10)
 *   - MCP nanoclaw (biblio) 9 種の完全 case
 *   - MCP tavily + drive (M4-F Phase 3 生活機能)
 *   - ADK ネイティブ tool 名 (mcp__ prefix なし) の biblio 9 種
 *   - 未知 SDK / 未知 MCP server / malformed regex の generic fallback (silent 化しない)
 *   - null / undefined / 空文字入力
 */
import { describe, it, expect } from 'vitest';

import { toolNameToStatus } from './tool-status-map.js';

describe('toolNameToStatus (M4-F Phase 4)', () => {
  it('returns null for null / undefined / empty string', () => {
    expect(toolNameToStatus(null)).toBeNull();
    expect(toolNameToStatus(undefined)).toBeNull();
    expect(toolNameToStatus('')).toBeNull();
  });

  describe('SDK built-in tools (TOOL_ALLOWLIST 全 18 種)', () => {
    it.each([
      ['Bash', 'bash 実行中'],
      ['Read', 'ファイル読取中'],
      ['Write', 'ファイル書込中'],
      ['Edit', 'ファイル編集中'],
      ['Glob', 'ファイル検索中'],
      ['Grep', 'コード検索中'],
      ['WebSearch', 'Web 検索中'],
      ['WebFetch', 'Web ページ取得中'],
      ['Task', 'サブエージェント実行中'],
      ['TaskOutput', 'サブエージェント出力取得中'],
      ['TaskStop', 'サブエージェント停止中'],
      ['TeamCreate', 'チーム作成中'],
      ['TeamDelete', 'チーム削除中'],
      ['SendMessage', 'メッセージ送信中'],
      ['TodoWrite', 'タスク管理中'],
      ['ToolSearch', 'ツール検索中'],
      ['Skill', 'スキル呼出中'],
      ['NotebookEdit', 'ノートブック編集中'],
    ])('maps %s -> %s', (tool, expected) => {
      expect(toolNameToStatus(tool)).toBe(expected);
    });
  });

  describe('MCP nanoclaw (biblio) tools', () => {
    it.each([
      ['mcp__nanoclaw__acquire_biblio', '仕入れ中'],
      ['mcp__nanoclaw__inspect_biblio', '検品中'],
      ['mcp__nanoclaw__categorize_biblio', 'カテゴライズ中'],
      ['mcp__nanoclaw__shelve_biblio', '陳列中'],
      ['mcp__nanoclaw__shelve_biblio_multi', '陳列中 (複数)'],
      ['mcp__nanoclaw__enkin_biblio', '禁書処理中'],
      ['mcp__nanoclaw__shokyaku_biblio', '焼却処理中'],
      ['mcp__nanoclaw__list_biblio', '蔵書一覧取得中'],
      ['mcp__nanoclaw__update_config', '設定変更中'],
    ])('maps %s -> %s', (tool, expected) => {
      expect(toolNameToStatus(tool)).toBe(expected);
    });
  });

  describe('ADK native tool names (mcp__ prefix なし = dispatcher.functionCall.name)', () => {
    it.each([
      ['acquire_biblio', '仕入れ中'],
      ['inspect_biblio', '検品中'],
      ['categorize_biblio', 'カテゴライズ中'],
      ['shelve_biblio', '陳列中'],
      ['shelve_biblio_multi', '陳列中 (複数)'],
      ['enkin_biblio', '禁書処理中'],
      ['shokyaku_biblio', '焼却処理中'],
      ['list_biblio', '蔵書一覧取得中'],
      ['update_config', '設定変更中'],
    ])('maps %s -> %s', (tool, expected) => {
      expect(toolNameToStatus(tool)).toBe(expected);
    });
  });

  describe('MCP life tools (Phase 3)', () => {
    it('tavily -> Web 検索中', () => {
      expect(toolNameToStatus('mcp__tavily__tavily_search')).toBe('Web 検索中');
    });
    it('drive -> ファイル参照中', () => {
      expect(toolNameToStatus('mcp__drive__drive_list_files')).toBe('ファイル参照中');
    });
    it('drive with arbitrary sub-tool still routes to ファイル参照中', () => {
      expect(toolNameToStatus('mcp__drive__drive_get_content')).toBe('ファイル参照中');
    });
  });

  describe('generic fallback (silent 化しない)', () => {
    it('unknown SDK tool falls back to 作業中 (${name})', () => {
      // PR #145 review IM-10: 旧 test は `TodoWrite` を「未知 tool」の例として使い
      // 網羅性不足を固定化していたが、TOOL_ALLOWLIST 全 18 種を BUILTIN_STATUS に取り込んだ
      // ため、真に未知の tool 名 (SDK / MCP どちらの管理下にもない) に例を差し替える。
      expect(toolNameToStatus('FutureUnmappedTool')).toBe('作業中 (FutureUnmappedTool)');
    });
    it('unknown MCP server exposes server name', () => {
      expect(toolNameToStatus('mcp__unknown__foo')).toBe('unknown 呼出中 (foo)');
    });
    it('unknown MCP tool under nanoclaw exposes server name', () => {
      expect(toolNameToStatus('mcp__nanoclaw__brand_new_tool')).toBe('nanoclaw 呼出中 (brand_new_tool)');
    });
    it('malformed mcp__ prefix (no server segment) falls to generic', () => {
      expect(toolNameToStatus('mcp____tool')).toBe('作業中 (mcp____tool)');
    });
    it('mcp with underscore in server name falls to generic (regex not matched, server 名側の _ 不許可)', () => {
      // 正規表現 `^mcp__([^_]+)__(.+)$` は server 名側に `_` を含まない = `multi_word` は
      // match せず、全体が generic fallback に落ちる。seedMcpServers() は 3 サーバ (英数のみ)
      // のみ登録 = 実運用では出現しないが regex 動作の記録として保持。
      expect(toolNameToStatus('mcp__multi_word__foo')).toBe('作業中 (mcp__multi_word__foo)');
    });
  });
});
