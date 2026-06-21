/**
 * scripts/biblio-equip-mount-check.ts — M3 Phase 1 装備物理配置の verify ハーネス。
 *
 * Phase 1 では agent-runner 経由ではなく、host から `<DATA_DIR>/biblio-equipped/<name>/marker.txt`
 * を直接読んで marker 文字列を確認する (= mount 配線の物理経路は K8s 経路では
 * orchestrator Pod 内から PVC 直読み、Docker local 経路では DATA_DIR 直読みで成立)。
 * agent-container 経由の skill 発火 verify は Phase 2 で行う。
 *
 * `verify-m2.sh` と同流儀: `RESULT=<json>` を stdout に吐く。assertion は呼び出し側
 * (shell) が JSON フィールド (`marker_found`) を見て判定する。
 *
 * Usage:
 *   pnpm exec tsx scripts/biblio-equip-mount-check.ts <biblioName>
 *
 *   env:
 *     DATA_DIR  装備物理配置の root (= `<DATA_DIR>/biblio-equipped/<name>/`)。未指定なら
 *               `process.cwd()/data` (= `src/config.ts` の既定)。
 */
import fs from 'node:fs';
import path from 'node:path';

import { BIBLIO_NAME_RE } from '../src/biblio/action-helpers.js';

interface CheckResult {
  marker_found: boolean;
  biblio: string;
  path: string;
  marker?: string;
  detail?: string;
}

function emit(result: CheckResult, exitCode: number): never {
  process.stdout.write(`RESULT=${JSON.stringify(result)}\n`);
  process.exit(exitCode);
}

function main(): never {
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write('usage: biblio-equip-mount-check.ts <biblioName>\n');
    process.exit(2);
  }

  // path traversal 防御 — env が偶然信用できない経路から渡る場合に備えて、
  // ハーネス側でも biblio name を validate する (二重防御)。
  if (!BIBLIO_NAME_RE.test(arg)) {
    emit(
      {
        marker_found: false,
        biblio: arg,
        path: '',
        detail: 'invalid biblio name (BIBLIO_NAME_RE 不通過)',
      },
      2,
    );
  }

  const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
  const markerPath = path.join(dataDir, 'biblio-equipped', arg, 'marker.txt');

  if (!fs.existsSync(markerPath)) {
    emit(
      {
        marker_found: false,
        biblio: arg,
        path: markerPath,
        detail: 'marker.txt not found at expected path',
      },
      1,
    );
  }

  const content = fs.readFileSync(markerPath, 'utf-8').trim();
  // 期待するマーカー文字列の prefix (Phase 1 fixture は hello-world のみだが、
  // 装備対象拡張に追従できるよう prefix 一致でチェックする)。
  const expectedPrefix = 'BIBLIO_EQUIP_M3_P1_MARKER_';
  const found = content.startsWith(expectedPrefix);
  emit(
    {
      marker_found: found,
      biblio: arg,
      path: markerPath,
      marker: content,
      detail: found ? undefined : `marker prefix mismatch (expected ${expectedPrefix}…)`,
    },
    found ? 0 : 1,
  );
}

main();
