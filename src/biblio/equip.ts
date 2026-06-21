/**
 * 装備機構の物理配置解決 (M3 Phase 2)。
 *
 * 装備リストは session 単位で `session_equipped_biblios` (central DB) に永続化される。
 * 本関数は session の装備リストを `order_index` ASC で読み、各 biblio name について
 * `BIBLIO_NAME_RE` 検証 + 物理 dir 存在確認を行い、通ったものだけ `EquippedBiblio[]` で
 * 返す。signature は Phase 1 から不変なので、`buildMounts` の呼び出しは無変更で動く。
 *
 * env `BIBLIO_EQUIPPED_NAMES` は Phase 1 で導入した stub だが、Phase 2 では DB lookup の
 * **オーバーライドとしてのみ有効** (= env が明示的にセットされている場合のみ env 経路を
 * 取る)。これはテストで agent_group / session を持たずに装備リストを差し込めるバック
 * ドアとして残置する。本番経路 (= host で env をセットしない) では常に DB lookup。
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { getEquippedBibliosBySession } from '../db/session-equipped-biblios.js';
import { log } from '../log.js';
import type { Session } from '../types.js';

import { BIBLIO_NAME_RE } from './action-helpers.js';
import type { EquippedBiblio } from './types.js';

/**
 * テスト override 用の env 名。`undefined` のみ DB lookup へフォールスルーする
 * (= 空文字セット時は env 経路に入り csv 解析で 0 件評価 = 結果的に DB を bypass)。
 * 「未定義」と「空文字」を意図的に区別する設計で、テストは vi.stubEnv('', '') で
 * 「env を空にしたい (= DB を読まない)」ケースを表現できる。
 */
const ENV_NAME = 'BIBLIO_EQUIPPED_NAMES';

/** テスト用フック: const 束縛された DATA_DIR を上書きするために root path を渡す。 */
interface ResolveEquippedBibliosOptions {
  equipmentRoot?: string;
}

/**
 * 装備済み biblio のリストを解決する。
 *
 * 本番経路: `session_equipped_biblios` から session の装備リストを取得し、
 * 各 biblio name について `BIBLIO_NAME_RE` 検証 + 物理 dir 存在確認を行い、通った
 * ものだけ返す。順序は DB の `order_index` ASC (= Phase 1 csv 順序保証と同等)。
 *
 * テスト override: env `BIBLIO_EQUIPPED_NAMES` が明示的にセットされていれば、
 * DB lookup を完全に置き換えて csv 経路を取る。これは DB を持たないユニット
 * テスト用のバックドアで、本番 host では env をセットしない。
 *
 * skip 経路では `log.warn` を出して開発者がリストの欠落に気づける状態にする。
 *
 * `async` signature は呼び出し側 (`buildMounts`) の変更を避けるためで、
 * 本実装は内部で await しない (DB は better-sqlite3 で同期 API)。
 */
export async function resolveEquippedBiblios(
  session: Session,
  opts?: ResolveEquippedBibliosOptions,
): Promise<EquippedBiblio[]> {
  const root = opts?.equipmentRoot ?? path.join(DATA_DIR, 'biblio-equipped');

  const envRaw = process.env[ENV_NAME];
  const names =
    envRaw !== undefined
      ? envRaw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : getEquippedBibliosBySession(session.id).map((row) => row.biblio_name);

  const result: EquippedBiblio[] = [];
  for (const name of names) {
    if (!BIBLIO_NAME_RE.test(name)) {
      log.warn('equip: invalid biblio name, skipping', {
        sessionId: session.id,
        name,
      });
      continue;
    }
    const sourcePath = path.join(root, name);
    if (!fs.existsSync(sourcePath)) {
      log.warn('equip: equipped biblio dir not found, skipping', {
        sessionId: session.id,
        name,
        sourcePath,
      });
      continue;
    }
    result.push({
      name,
      sourcePath,
      mountPath: `/workspace/biblios/${name}`,
    });
  }
  return result;
}
