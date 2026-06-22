/**
 * categorize_biblio delivery handler のユニットテスト。
 *
 * action handler は writeBack (= insertMessage) を 1 度叩いて patron に応答する形式。
 * `registerDeliveryAction` を mock して module load 時の handler を抜き、直接呼ぶ。
 *
 * カバレッジ:
 *  - 入口 validate (name 欠落 / `<owner>--<name>` 形式違反)
 *  - happy path (categorize 成功 → writeBack で「カテゴリ判定: ...」テキスト)
 *  - fail path (categorize の ok=false → writeBack で「カテゴライズ失敗 ...」)
 *  - categorize 自体の throw を握って writeBack (host を巻き込まない)
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

const insertMessageMock = vi.fn();
vi.mock('../db/session-db.js', () => ({
  insertMessage: (db: unknown, msg: unknown) => insertMessageMock(db, msg),
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const categorizeMock = vi.fn();
vi.mock('./categorize.js', () => ({
  categorize: (...args: unknown[]) => categorizeMock(...args),
}));

// 副作用 import で `registerDeliveryAction('categorize_biblio', handler)` が走る
import './categorize-action.js';

const handler = registered.get('categorize_biblio');
if (!handler) throw new Error('categorize_biblio handler not registered');

// Database / Session の具体型は session-db.js / session-manager.js 内で private に閉じている。
// handler 入口は型を見ない (= dummy object で通る) ため unknown で渡す。
const dummyDb: unknown = {};
const dummySession: unknown = { id: 'sess-x' };

function getWrittenText(): string | undefined {
  const lastCall = insertMessageMock.mock.calls.at(-1);
  if (!lastCall) return undefined;
  const msg = lastCall[1] as { content: string };
  return (JSON.parse(msg.content) as { text: string }).text;
}

beforeEach(() => {
  insertMessageMock.mockReset();
  categorizeMock.mockReset();
});

describe('categorize_biblio handler — 入口 validate', () => {
  it('name 欠落で「name が指定されていません」を返す (categorize は呼ばない)', async () => {
    await handler({}, dummySession, dummyDb);
    expect(categorizeMock).not.toHaveBeenCalled();
    expect(getWrittenText()).toContain('name が指定されていません');
  });

  it('owner--name 形式違反で「`owner--name` 形式ではありません」を返す', async () => {
    await handler({ name: 'just-a-name' }, dummySession, dummyDb);
    expect(categorizeMock).not.toHaveBeenCalled();
    expect(getWrittenText()).toContain('`owner--name` 形式ではありません');
  });
});

describe('categorize_biblio handler — happy path', () => {
  it('categorize 成功でカテゴリ判定 + 「進めますか?」を返す', async () => {
    categorizeMock.mockResolvedValue({
      ok: true,
      biblioName: 'owner--repo',
      category: 'biblio-dev',
      reason: 'TS refactor 補助',
    });
    await handler({ name: 'owner--repo' }, dummySession, dummyDb);
    expect(categorizeMock).toHaveBeenCalledWith({ biblioName: 'owner--repo' }, expect.anything());
    const text = getWrittenText() ?? '';
    expect(text).toContain('カテゴリ判定: `biblio-dev`');
    expect(text).toContain('TS refactor 補助');
    expect(text).toContain('進めますか');
  });
});

describe('categorize_biblio handler — fail path', () => {
  it('categorize の ok=false 時にカテゴライズ失敗テキストを返す', async () => {
    categorizeMock.mockResolvedValue({
      ok: false,
      biblioName: 'owner--repo',
      reason: 'parse_error',
      detail: 'LLM 応答崩れ',
    });
    await handler({ name: 'owner--repo' }, dummySession, dummyDb);
    const text = getWrittenText() ?? '';
    expect(text).toContain('カテゴライズ失敗 (parse_error)');
    expect(text).toContain('LLM 応答崩れ');
  });

  it('categorize 自体が throw しても host を巻き込まず writeBack に倒す', async () => {
    categorizeMock.mockRejectedValue(new Error('unexpected'));
    await expect(handler({ name: 'owner--repo' }, dummySession, dummyDb)).resolves.toBeUndefined();
    const text = getWrittenText() ?? '';
    expect(text).toContain('カテゴライズエラー (internal)');
    expect(text).toContain('unexpected');
  });
});
