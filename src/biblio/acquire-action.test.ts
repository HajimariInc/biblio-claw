/**
 * acquire_biblio delivery handler のユニットテスト。
 *
 * action handler は `writeBackMessage` で patron に応答する形式。
 * `registerDeliveryAction` を mock して module load 時の handler を抜き、直接呼ぶ。
 *
 * カバレッジ (Phase 1):
 *  - 入口 validate (repo 空)
 *  - 既存経路: repo 単独 (skill 未指定) で acquire を `{ repo }` だけで呼ぶ
 *  - 新規経路 (Phase 1): skill 指定で acquire を `{ repo, skill }` で呼び、受領通知文言を返す
 *  - 空文字 skill は undefined 扱い (= 全体仕入れに退化)
 *  - acquire 自体の throw を握って internal エラー文言で writeBack (host を落とさない)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// `registerDeliveryAction(action, handler)` の handler を抜き出すための receiver。
// `vi.mock` は import 前に hoist されるため、receiver は `vi.hoisted` 内で初期化する。
const { registered } = vi.hoisted(() => ({
  registered: new Map<string, (content: Record<string, unknown>, session: unknown, inDb: unknown) => Promise<void>>(),
}));

vi.mock('../delivery.js', () => ({
  registerDeliveryAction: (action: string, handler: (...args: unknown[]) => Promise<void>) => {
    registered.set(action, handler as never);
  },
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const acquireMock = vi.fn();
vi.mock('./acquire.js', () => ({
  acquire: (...args: unknown[]) => acquireMock(...args),
}));

// action-helpers は partial mock — `writeBackMessage` だけ差し替え、`BIBLIO_NAME_RE`
// など他の export はそのまま使えるようにする (= categorize-action.test.ts は
// 一段下の `insertMessage` 経由で capture していたが、acquire-action.ts は
// `writeBackMessage` のみ呼ぶため、上位で 1 段薄く mock する方が単純)。
const writeBackCalls: Array<{ text: string; idPrefix: string; actionName: string }> = [];
vi.mock('./action-helpers.js', async () => {
  const actual = await vi.importActual<typeof import('./action-helpers.js')>('./action-helpers.js');
  return {
    ...actual,
    writeBackMessage: async (_db: unknown, text: string, idPrefix: string, actionName: string) => {
      writeBackCalls.push({ text, idPrefix, actionName });
    },
  };
});

// 副作用 import で `registerDeliveryAction('acquire_biblio', handler)` が走る
import './acquire-action.js';

const handler = registered.get('acquire_biblio');
if (!handler) throw new Error('acquire_biblio handler not registered');

const dummyDb: unknown = {};
const dummySession: unknown = { id: 'sess-x' };

function getWrittenText(): string | undefined {
  return writeBackCalls.at(-1)?.text;
}

beforeEach(() => {
  acquireMock.mockReset();
  writeBackCalls.length = 0;
});

describe('acquire_biblio handler — 入口 validate', () => {
  it('repo が空なら invalid_input 文言を返す (acquire を呼ばない)', async () => {
    await handler({ repo: '' }, dummySession, dummyDb);
    expect(acquireMock).not.toHaveBeenCalled();
    expect(getWrittenText()).toContain('invalid_input');
  });
});

describe('acquire_biblio handler — 既存経路 (skill 未指定)', () => {
  it('repo 単独で acquire を `{ repo }` だけで呼ぶ (skill キーを含めない)', async () => {
    acquireMock.mockResolvedValue({
      ok: true,
      biblioName: 'oct--hi',
      quarantinePath: '/tmp/q/oct--hi',
    });
    await handler({ repo: 'oct/hi' }, dummySession, dummyDb);
    expect(acquireMock).toHaveBeenCalledWith({ repo: 'oct/hi' });
    expect(getWrittenText()).toContain('仕入れ完了');
  });
});

describe('acquire_biblio handler — Phase 1 個別 skill 経路', () => {
  it('skill 指定時に acquire を `{ repo, skill }` で呼び、受領通知文言を返す', async () => {
    acquireMock.mockResolvedValue({
      ok: false,
      reason: 'not_implemented',
      detail: '個別 skill 仕入れは Phase 3 で実装中: anthropics/skills/algorithmic-art',
    });
    await handler({ repo: 'anthropics/skills', skill: 'algorithmic-art' }, dummySession, dummyDb);
    expect(acquireMock).toHaveBeenCalledWith({ repo: 'anthropics/skills', skill: 'algorithmic-art' });
    const text = getWrittenText() ?? '';
    expect(text).toContain('個別 skill 仕入れリクエストを受領');
    expect(text).toContain('anthropics/skills/algorithmic-art');
    // patron UX として「エラー」表記を出さない (= 「受領通知」と分離する設計判断)。
    expect(text).not.toContain('仕入れエラー');
  });

  it('skill 空文字 / 空白のみは undefined 扱い (= 全体仕入れ経路に退化)', async () => {
    acquireMock.mockResolvedValue({
      ok: true,
      biblioName: 'oct--hi',
      quarantinePath: '/tmp/q/oct--hi',
    });
    await handler({ repo: 'oct/hi', skill: '   ' }, dummySession, dummyDb);
    expect(acquireMock).toHaveBeenCalledWith({ repo: 'oct/hi' });
  });
});

describe('acquire_biblio handler — 例外を握って writeBack に倒す', () => {
  it('acquire が throw しても host を巻き込まず internal エラー文言を返す', async () => {
    acquireMock.mockRejectedValue(new Error('boom'));
    await expect(handler({ repo: 'oct/hi' }, dummySession, dummyDb)).resolves.toBeUndefined();
    const text = getWrittenText() ?? '';
    expect(text).toContain('仕入れエラー (internal)');
    expect(text).toContain('boom');
  });
});
