/**
 * 装備機構 (souwa / equip) の物理配置解決 (M3 Phase 1)。
 *
 * Phase 1 stub: env `BIBLIO_EQUIPPED_NAMES` (csv) を読み、`<DATA_DIR>/biblio-equipped/`
 * 配下の物理 dir 存在を確認して `EquippedBiblio[]` を返す。Phase 2 で内部実装を
 * session 単位の DB lookup (例: `session_equipped_biblios` table) に置換予定 — 上位
 * `buildMounts` への影響を抑えるため signature に `session` を持つ。
 *
 * **罠回避** (acquire.test.ts で実証済): `vi.stubEnv('DATA_DIR', ...)` はモジュール
 * load 時に const 束縛された `DATA_DIR` に効かないため、テストで base path を上書き
 * したい場合は `opts.equipmentRoot` を渡す (= prod 経路は未指定で `<DATA_DIR>/biblio-equipped`)。
 *
 * **silent failure 防止**: 無効な name (BIBLIO_NAME_RE 不通過) / dir 不在は warn log を
 * 出して skip する (= 開発者がリストの欠落に気づける)。
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

/** Phase 1 で固定の sub-directory 名 (DATA_DIR 直下の装備物理配置 root)。 */
const EQUIPMENT_SUBDIR = 'biblio-equipped';

/** agent コンテナ内の装備 mount root (= `<MOUNT_ROOT>/<biblioName>` の親)。 */
const CONTAINER_MOUNT_ROOT = '/workspace/biblios';

export interface ResolveEquippedBibliosOptions {
  /**
   * 装備物理配置の root path を override する (= `<DATA_DIR>/biblio-equipped` の代わり)。
   * `vi.stubEnv('DATA_DIR', ...)` の const 束縛罠を回避するためのテスト用フック。
   * prod 経路では未指定。
   */
  equipmentRoot?: string;
}

/**
 * 装備済み biblio のリストを解決する。
 *
 * Phase 1 stub: env `BIBLIO_EQUIPPED_NAMES` (csv) を読み、各 name の物理 dir を
 * 確認して `EquippedBiblio[]` を返す。順序は csv の出現順を保つ (= buildMounts への
 * append 順 = container 内の見た目順、安定)。
 *
 * **async signature について**: 本 stub は内部で await しないが、Phase 2 で DB lookup
 * (= `await db.prepare(...).all(session.id)` 等) に置換する際の呼び出し側 (buildMounts)
 * 変更を避けるため Promise を返す。
 */
export async function resolveEquippedBiblios(
  session: Session,
  opts?: ResolveEquippedBibliosOptions,
): Promise<EquippedBiblio[]> {
  const root = opts?.equipmentRoot ?? path.join(DATA_DIR, EQUIPMENT_SUBDIR);
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
      mountPath: `${CONTAINER_MOUNT_ROOT}/${name}`,
    });
  }
  return result;
}
