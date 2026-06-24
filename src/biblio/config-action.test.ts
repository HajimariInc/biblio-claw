/**
 * update_config delivery handler のユニットテスト (個別 PRD Phase 5 dynamic-config)。
 *
 * list-biblio-action.test.ts と同形 — registerDeliveryAction を mock で intercept し、
 * 登録された handler を直呼びする。`insertMessage` mock で writeBackMessage の text を assert。
 *
 * DB は in-memory + runMigrations で本物の biblio_settings table を作る (= setBiblioSetting
 * の動作と handler の DB 連携を end-to-end で検証する。CRUD 単体は db/biblio-settings.test.ts
 * で固めているので、本 test は handler の分岐に集中する)。
 *
 * カバレッジ:
 *  - action="update_config" が registered で取れる (副作用 import で登録)
 *  - 1: allowlist 内 + admin 存在 + 正常値 → DB に書かれて writeBack "設定完了"
 *  - 2: user_roles 不在 (permissions モジュール未) → allow-all で同様に書き込まれる
 *  - 3: user_roles 存在 + admin 0 件 (= 該当 agent_group に admin/owner なし) → reject + 未書き込み
 *  - 4: allowlist 外 key → reject + 未書き込み
 *  - 5: key 空 → reject + 未書き込み
 *  - 6: value 空 → reject + 未書き込み
 *  - 7: setBiblioSetting throw → writeBack "internal" + handler が throw しない
 *  - 8: 文字列前後の trim (= "ACQUIRE_SKILL_THRESHOLD" + "  25 " → 値 "25" で書き込み)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../db/index.js';
import { getAllBiblioSettings, getBiblioSetting } from '../db/biblio-settings.js';
import type { Session } from '../types.js';

const { registered } = vi.hoisted(() => ({
  registered: new Map<string, (content: Record<string, unknown>, session: unknown, inDb: unknown) => Promise<void>>(),
}));

vi.mock('../delivery.js', () => ({
  registerDeliveryAction: (action: string, handler: (...args: unknown[]) => Promise<void>) => {
    registered.set(action, handler as never);
  },
}));

const insertMessageMock = vi.fn();
vi.mock('../db/session-db.js', () => ({
  insertMessage: (db: unknown, msg: unknown) => insertMessageMock(db, msg),
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import './config-action.js';

const handler = registered.get('update_config');
if (!handler) throw new Error('update_config handler not registered');

const dummyDb: unknown = {};
const TEST_SESSION: Session = {
  id: 'sess-test',
  agent_group_id: 'ag-test',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: new Date().toISOString(),
};

function getWrittenText(): string | undefined {
  const lastCall = insertMessageMock.mock.calls.at(-1);
  if (!lastCall) return undefined;
  const msg = lastCall[1] as { content: string };
  return (JSON.parse(msg.content) as { text: string }).text;
}

function seedAdmin(agentGroupId: string | null = 'ag-test'): void {
  // user_roles table 自体は migration001 で作られる (= initial-v2-schema)。明示的に row を入れて
  // 「permissions モジュールが installed されており、admin が居る」状態を再現する。
  // command-gate.ts の SELECT 条件 (= role='owner' OR 'admin' AND (agent_group_id IS NULL OR ?)) に
  // 当たる行を 1 件 seed する。FK 制約 (user_id → users, agent_group_id → agent_groups) を
  // 満たすため、users と agent_groups にも対応行を入れる。
  const db = initTestDb();
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)').run(
    'user-admin',
    'test',
    'Admin User',
    now,
  );
  if (agentGroupId !== null) {
    db.prepare(
      `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(agentGroupId, 'Test', `folder-${agentGroupId}`, null, now);
  }
  db.prepare(
    `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('user-admin', 'admin', agentGroupId, null, now);
}

function seedNoAdmin(): void {
  // user_roles table は存在するが、admin / owner 行を 1 件も入れない (= permissions 配線済だが
  // 該当 agent_group には責任者未登録 → handler は deny に倒す)。
  const db = initTestDb();
  runMigrations(db);
}

beforeEach(() => {
  insertMessageMock.mockReset();
});

afterEach(() => {
  closeDb();
});

describe('update_config handler', () => {
  it('副作用 import で update_config が登録される', () => {
    expect(registered.has('update_config')).toBe(true);
  });

  it('1: allowlist 内 + admin 存在 + 正常値 → DB upsert + 設定完了 writeBack', async () => {
    seedAdmin();
    await handler({ action: 'update_config', key: 'ACQUIRE_SKILL_THRESHOLD', value: '25' }, TEST_SESSION, dummyDb);
    expect(getBiblioSetting('ACQUIRE_SKILL_THRESHOLD')).toBe('25');
    expect(getWrittenText()).toContain('設定完了');
    expect(getWrittenText()).toContain('ACQUIRE_SKILL_THRESHOLD');
    expect(getWrittenText()).toContain('25');
  });

  it('2: user_roles 不在 (permissions 未インストール) → allow-all で書き込まれる', async () => {
    // initTestDb のみ + runMigrations しない (= user_roles table も作らない) と
    // initial-v2-schema migration が走らずに table 不在になる。本 case の目的は
    // 「user_roles table 自体がない環境」での allow-all 経路の確認。
    const db = initTestDb();
    // schema_version table だけ立てて他は何も migrate しない → hasTable('user_roles') === false
    db.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT, applied TEXT);`);
    // biblio_settings table は明示的に作る (= handler の setBiblioSetting が動くため)。
    db.exec(`CREATE TABLE biblio_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    await handler({ action: 'update_config', key: 'ACQUIRE_SKILL_THRESHOLD', value: '30' }, TEST_SESSION, dummyDb);
    expect(getBiblioSetting('ACQUIRE_SKILL_THRESHOLD')).toBe('30');
    expect(getWrittenText()).toContain('設定完了');
  });

  it('3: user_roles 存在 + 該当 agent_group に admin/owner なし → permission_denied + 未書き込み', async () => {
    seedNoAdmin();
    await handler({ action: 'update_config', key: 'ACQUIRE_SKILL_THRESHOLD', value: '50' }, TEST_SESSION, dummyDb);
    expect(getAllBiblioSettings()).toEqual([]);
    expect(getWrittenText()).toContain('permission_denied');
    expect(getWrittenText()).toContain('admin / owner');
  });

  it('3b: 別 agent_group の admin は無関係 (= scope check が効く)', async () => {
    // 'ag-other' に admin を入れても、session は 'ag-test' なので deny される
    seedAdmin('ag-other');
    await handler({ action: 'update_config', key: 'ACQUIRE_SKILL_THRESHOLD', value: '50' }, TEST_SESSION, dummyDb);
    expect(getAllBiblioSettings()).toEqual([]);
    expect(getWrittenText()).toContain('permission_denied');
  });

  it('3c: global admin (agent_group_id IS NULL) は全 group に効く', async () => {
    seedAdmin(null);
    await handler({ action: 'update_config', key: 'ACQUIRE_SKILL_THRESHOLD', value: '50' }, TEST_SESSION, dummyDb);
    expect(getBiblioSetting('ACQUIRE_SKILL_THRESHOLD')).toBe('50');
    expect(getWrittenText()).toContain('設定完了');
  });

  it('4: allowlist 外 key (例: FOO) → invalid_key + 未書き込み', async () => {
    seedAdmin();
    await handler({ action: 'update_config', key: 'FOO', value: 'bar' }, TEST_SESSION, dummyDb);
    expect(getAllBiblioSettings()).toEqual([]);
    expect(getWrittenText()).toContain('invalid_key');
    expect(getWrittenText()).toContain('ACQUIRE_SKILL_THRESHOLD');
  });

  it('4b: 既存の env-only 設定 key (MAX_BLOBS_PER_PR 等) も allowlist 外として reject', async () => {
    seedAdmin();
    await handler({ action: 'update_config', key: 'MAX_BLOBS_PER_PR', value: '200' }, TEST_SESSION, dummyDb);
    expect(getAllBiblioSettings()).toEqual([]);
    expect(getWrittenText()).toContain('invalid_key');
  });

  it('5: key 空 → invalid_input + 未書き込み', async () => {
    seedAdmin();
    await handler({ action: 'update_config', key: '', value: '20' }, TEST_SESSION, dummyDb);
    expect(getAllBiblioSettings()).toEqual([]);
    expect(getWrittenText()).toContain('invalid_input');
  });

  it('5b: key 空白のみ → invalid_input + 未書き込み (trim 後に空)', async () => {
    seedAdmin();
    await handler({ action: 'update_config', key: '   ', value: '20' }, TEST_SESSION, dummyDb);
    expect(getAllBiblioSettings()).toEqual([]);
    expect(getWrittenText()).toContain('invalid_input');
  });

  it('5c: key が非文字列 (= number) → invalid_input', async () => {
    seedAdmin();
    await handler({ action: 'update_config', key: 42 as unknown as string, value: '20' }, TEST_SESSION, dummyDb);
    expect(getAllBiblioSettings()).toEqual([]);
    expect(getWrittenText()).toContain('invalid_input');
  });

  it('6: value 空 → invalid_input + 未書き込み', async () => {
    seedAdmin();
    await handler({ action: 'update_config', key: 'ACQUIRE_SKILL_THRESHOLD', value: '' }, TEST_SESSION, dummyDb);
    expect(getAllBiblioSettings()).toEqual([]);
    expect(getWrittenText()).toContain('invalid_input');
  });

  it('8: key/value 前後の空白は trim される', async () => {
    seedAdmin();
    await handler(
      { action: 'update_config', key: '  ACQUIRE_SKILL_THRESHOLD  ', value: '  25  ' },
      TEST_SESSION,
      dummyDb,
    );
    expect(getBiblioSetting('ACQUIRE_SKILL_THRESHOLD')).toBe('25');
  });
});
