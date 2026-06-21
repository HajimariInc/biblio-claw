/**
 * 装備機構の物理配置解決 (M3 Phase 1 stub)。
 * env `BIBLIO_EQUIPPED_NAMES` (csv) を読んで物理 dir を確認し `EquippedBiblio[]` を返す。
 * Phase 2 で session 単位の DB lookup に置換予定 — signature 変更を避けるため `session` を持つ。
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import type { Session } from '../types.js';

import { BIBLIO_NAME_RE } from './action-helpers.js';
import type { EquippedBiblio } from './types.js';

/** `BIBLIO_EQUIPPED_NAMES` を csv parse する際の env name (Phase 1 stub の入口)。 */
const ENV_NAME = 'BIBLIO_EQUIPPED_NAMES';

/** テスト用フック: const 束縛された DATA_DIR を上書きするために root path を渡す。 */
interface ResolveEquippedBibliosOptions {
  equipmentRoot?: string;
}

/**
 * 装備済み biblio のリストを解決する。
 *
 * Phase 1 stub: env `BIBLIO_EQUIPPED_NAMES` (csv) の各 name について
 * `BIBLIO_NAME_RE` 検証 + 物理 dir 存在確認を行い、通ったものだけ返す。
 * 順序は csv 順を保つ (= buildMounts の append 順、container 内の見た目順)。
 * skip 経路では `log.warn` を出して開発者がリストの欠落に気づける状態にする。
 *
 * `async` signature は Phase 2 で内部実装を DB lookup に置換する際の呼び出し側
 * 変更を避けるためで、本 stub は内部で await しない。
 */
export async function resolveEquippedBiblios(
  session: Session,
  opts?: ResolveEquippedBibliosOptions,
): Promise<EquippedBiblio[]> {
  const root = opts?.equipmentRoot ?? path.join(DATA_DIR, 'biblio-equipped');
  const raw = process.env[ENV_NAME];
  if (!raw || raw.trim() === '') return [];

  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

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
