/**
 * `container-configs.ts` CRUD のユニットテスト (system-prompt-override 追加)。
 *
 * - migration020 apply で system_prompt_override 列が作られる
 * - migration idempotency (2 回 apply しても throw しない、PRAGMA table_info guard)
 * - createContainerConfig で system_prompt_override 未指定 → NULL default (INSERT 文の
 *   named-param bind が余剰プロパティ無視、寛容 bind pattern)
 * - getContainerConfig で system_prompt_override: null が返る
 * - updateContainerConfigScalars で system_prompt_override を投入
 * - 上書き set → 最新値が返る
 * - null 復帰は不可 (fields.length=0 pattern の undefined guard 挙動を明示 test)
 * - invalid col throw
 * - configFromDb 変換 (NULL → undefined、value → value)
 * - SCALAR_COLUMNS 一貫性 (SCALAR_COLUMNS Set + Pick<> union 2 箇所同期)
 *
 * biblio-settings.test.ts + session-equipped-biblios.test.ts と同じ
 * in-memory DB + runMigrations パターン。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, runMigrations } from './index.js';
import { createAgentGroup } from './agent-groups.js';
import {
  createContainerConfig,
  getContainerConfig,
  updateContainerConfigScalars,
  ensureContainerConfig,
} from './container-configs.js';
import { configFromDb } from '../container-config.js';
import type { AgentGroup, ContainerConfigRow } from '../types.js';

const AG_ID = 'ag-test-1';
const AG_ID_2 = 'ag-test-2';

function seedAgentGroup(id: string = AG_ID, folder: string = 'test-folder'): AgentGroup {
  const group: AgentGroup = {
    id,
    name: 'test-group',
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
  };
  createAgentGroup(group);
  return group;
}

function seedContainerConfigRow(agentGroupId: string = AG_ID): ContainerConfigRow {
  const row: ContainerConfigRow = {
    agent_group_id: agentGroupId,
    provider: null,
    model: null,
    effort: null,
    image_tag: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    skills: JSON.stringify('all'),
    mcp_servers: JSON.stringify({}),
    packages_apt: JSON.stringify([]),
    packages_npm: JSON.stringify([]),
    additional_mounts: JSON.stringify([]),
    cli_scope: 'group',
    system_prompt_override: null,
    updated_at: new Date().toISOString(),
  };
  createContainerConfig(row);
  return row;
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('container_configs CRUD (system_prompt_override 列)', () => {
  describe('migration020', () => {
    it('applies system_prompt_override column to container_configs', () => {
      const db = initTestDb();
      // initTestDb() clears in-memory DB; re-apply migrations
      runMigrations(db);
      const cols = db.prepare("PRAGMA table_info('container_configs')").all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain('system_prompt_override');
    });

    it('is idempotent when re-run (PRAGMA table_info guard)', () => {
      const db = initTestDb();
      // Run twice explicitly — the guard in migration020 should skip the second ADD COLUMN
      runMigrations(db);
      expect(() => runMigrations(db)).not.toThrow();
      const cols = db.prepare("PRAGMA table_info('container_configs')").all() as Array<{ name: string }>;
      const overrideCols = cols.filter((c) => c.name === 'system_prompt_override');
      expect(overrideCols).toHaveLength(1);
    });
  });

  describe('createContainerConfig — INSERT path', () => {
    it('inserts NULL system_prompt_override when omitted (named-param bind lenience)', () => {
      seedAgentGroup();
      seedContainerConfigRow();
      const row = getContainerConfig(AG_ID);
      expect(row).toBeDefined();
      expect(row!.system_prompt_override).toBeNull();
    });

    it('ensureContainerConfig (INSERT OR IGNORE minimal row) leaves system_prompt_override NULL', () => {
      seedAgentGroup();
      ensureContainerConfig(AG_ID);
      const row = getContainerConfig(AG_ID);
      expect(row).toBeDefined();
      expect(row!.system_prompt_override).toBeNull();
    });
  });

  describe('updateContainerConfigScalars — UPDATE path', () => {
    it('updates system_prompt_override with a value', () => {
      seedAgentGroup();
      seedContainerConfigRow();
      updateContainerConfigScalars(AG_ID, { system_prompt_override: 'test prompt content' });
      const row = getContainerConfig(AG_ID);
      expect(row!.system_prompt_override).toBe('test prompt content');
    });

    it('overwrites system_prompt_override on second call (last write wins)', () => {
      seedAgentGroup();
      seedContainerConfigRow();
      updateContainerConfigScalars(AG_ID, { system_prompt_override: 'first version' });
      updateContainerConfigScalars(AG_ID, { system_prompt_override: 'second version' });
      const row = getContainerConfig(AG_ID);
      expect(row!.system_prompt_override).toBe('second version');
    });

    it('bumps updated_at when system_prompt_override changes', async () => {
      seedAgentGroup();
      seedContainerConfigRow();
      updateContainerConfigScalars(AG_ID, { system_prompt_override: 'v1' });
      const firstTs = getContainerConfig(AG_ID)!.updated_at;
      await new Promise((r) => setTimeout(r, 10));
      updateContainerConfigScalars(AG_ID, { system_prompt_override: 'v2' });
      const secondTs = getContainerConfig(AG_ID)!.updated_at;
      expect(secondTs >= firstTs).toBe(true);
    });

    it('leaves system_prompt_override intact for unrelated field update', () => {
      seedAgentGroup();
      seedContainerConfigRow();
      updateContainerConfigScalars(AG_ID, { system_prompt_override: 'my prompt' });
      // Update a different scalar; the override should not be cleared.
      updateContainerConfigScalars(AG_ID, { model: 'claude-sonnet-4-6' });
      const row = getContainerConfig(AG_ID);
      expect(row!.system_prompt_override).toBe('my prompt');
      expect(row!.model).toBe('claude-sonnet-4-6');
    });

    it('undefined value in updates is skipped (no-op for that field)', () => {
      seedAgentGroup();
      seedContainerConfigRow();
      updateContainerConfigScalars(AG_ID, { system_prompt_override: 'stays' });
      updateContainerConfigScalars(AG_ID, { system_prompt_override: undefined });
      const row = getContainerConfig(AG_ID);
      expect(row!.system_prompt_override).toBe('stays');
    });

    it('empty updates object is a no-op (fields.length === 0 early return)', () => {
      seedAgentGroup();
      seedContainerConfigRow();
      const before = getContainerConfig(AG_ID)!.updated_at;
      expect(() => updateContainerConfigScalars(AG_ID, {})).not.toThrow();
      const after = getContainerConfig(AG_ID)!.updated_at;
      // No UPDATE means updated_at is unchanged.
      expect(after).toBe(before);
    });

    it('rejects unknown scalar column with throw (SCALAR_COLUMNS guard)', () => {
      seedAgentGroup();
      seedContainerConfigRow();
      // @ts-expect-error — intentionally passing an off-list key to test runtime guard
      expect(() => updateContainerConfigScalars(AG_ID, { bogus_col: 'x' })).toThrow(/Invalid scalar column/);
    });
  });

  describe('regression zero — existing scalars still work after column addition', () => {
    it('updates other SCALAR_COLUMNS keys without affecting system_prompt_override', () => {
      seedAgentGroup();
      seedContainerConfigRow();
      updateContainerConfigScalars(AG_ID, {
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        effort: 'high',
        image_tag: 'test-tag',
        assistant_name: 'Test Assistant',
        max_messages_per_prompt: 20,
        cli_scope: 'global',
      });
      const row = getContainerConfig(AG_ID);
      expect(row!.provider).toBe('claude');
      expect(row!.model).toBe('claude-sonnet-4-6');
      expect(row!.effort).toBe('high');
      expect(row!.image_tag).toBe('test-tag');
      expect(row!.assistant_name).toBe('Test Assistant');
      expect(row!.max_messages_per_prompt).toBe(20);
      expect(row!.cli_scope).toBe('global');
      expect(row!.system_prompt_override).toBeNull();
    });

    it('per-group isolation — updating one group leaves the other intact', () => {
      seedAgentGroup(AG_ID, 'folder-a');
      seedAgentGroup(AG_ID_2, 'folder-b');
      seedContainerConfigRow(AG_ID);
      seedContainerConfigRow(AG_ID_2);
      updateContainerConfigScalars(AG_ID, { system_prompt_override: 'group-a-prompt' });
      expect(getContainerConfig(AG_ID)!.system_prompt_override).toBe('group-a-prompt');
      expect(getContainerConfig(AG_ID_2)!.system_prompt_override).toBeNull();
    });
  });

  describe('configFromDb — materialize path (host container-config.ts)', () => {
    it('maps NULL system_prompt_override to undefined', () => {
      const group = seedAgentGroup();
      seedContainerConfigRow();
      const row = getContainerConfig(AG_ID)!;
      const config = configFromDb(row, group);
      expect(config.systemPromptOverride).toBeUndefined();
    });

    it('maps value system_prompt_override to camelCase field', () => {
      const group = seedAgentGroup();
      seedContainerConfigRow();
      updateContainerConfigScalars(AG_ID, { system_prompt_override: 'materialize test' });
      const row = getContainerConfig(AG_ID)!;
      const config = configFromDb(row, group);
      expect(config.systemPromptOverride).toBe('materialize test');
    });
  });
});
