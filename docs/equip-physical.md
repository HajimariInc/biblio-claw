# 装備機構 — 物理配置 + 自律呼び出し (M3 Phase 1 + Phase 2)

biblio-claw の装備機構 (souwa / equip) は、棚から取り出した biblio を agent-container に
取り込んで実行する経路を構築する。本書はその中核となる **物理配置 (= ホスト側のソース
位置と agent 側の mount 先 path 規約)** + **spawn-time install ライフサイクル** を扱う。
M3 Phase 1 で物理配置を確立、M3 Phase 2 で spawn-time install + SKILL 発火経路を実装した
(解除 / 焼却は Phase 3 の申し送りとして末尾に集約)。

## 物理配置 path 規約

| 役割 | path | 備考 |
| --- | --- | --- |
| host 側 source root | `<DATA_DIR>/biblio-equipped/` | M2 `quarantine/` と並列、PVC (GKE) / data/ (Local) に直置き |
| host 側 per-biblio | `<DATA_DIR>/biblio-equipped/<biblioName>/` | `biblioName` は `BIBLIO_NAME_RE` (`<owner>--<name>` 形式) を強制 |
| agent 側 mount root | `/workspace/biblios/` | session 内 `agent-runner` から見える共通親 |
| agent 側 per-biblio | `/workspace/biblios/<biblioName>/` | readonly、装備中 biblio 1 件 |

`biblioName` を `<owner>--<name>` の 2 セグメント形式に強制するのは、

1. **dedup key**: 別 owner の同名 repo を同一 host dir で衝突させない
   (M2 PRD B `acquire.ts` と同方針)。
2. **path traversal 防御**: agent が任意の文字列を投げてきても、`path.join` 前に
   `../../tmp/evil` 形式を弾く。

の 2 目的を兼ねる。検証は `src/biblio/action-helpers.ts:BIBLIO_NAME_RE` (M2 で確立済の
正規表現) を再利用する。

## mount トポロジ

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                         装備物理配置 (M3 Phase 1)                            ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║   <DATA_DIR>/                                                                ║
║     ├── v2.db                                  (M1 既存)                     ║
║     ├── v2-sessions/<ag>/<sess>/               (M1 既存、Two-DB セッション) ║
║     ├── groups/<folder>/                       (M1 既存、agent group fs)     ║
║     ├── quarantine/<biblioName>/               (M2 仕入れ後の格納先)         ║
║     └── biblio-equipped/                       ★ M3 Phase 1 で確立           ║
║          └── <biblioName>/                                                   ║
║               ├── marker.txt                                                 ║
║               └── .claude-plugin/                                            ║
║                    └── marker.json                                           ║
║                                                                              ║
║   agent-container (spawn 後):                                                ║
║     /workspace/                                                              ║
║       ├── inbound.db, outbound.db, .heartbeat   (session DB、RW)             ║
║       ├── agent/                                (group dir、RW)              ║
║       └── biblios/                              ★ M3 Phase 1 で確立          ║
║            └── <biblioName>/                    (readonly, per-biblio)        ║
║                 ├── marker.txt                                               ║
║                 └── .claude-plugin/marker.json                               ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

`/workspace/biblios/<biblioName>/` は **per-biblio で独立 mount** する。装備中 biblio が
N 件あれば mount entry も N 件並ぶ。理由:

- **動的可変**: 装備リストは session ごとに別。共通 root を 1 つ mount すると装備中で
  ない biblio も同時に見えてしまい、agent が誤って参照する経路を作ってしまう。
- **readonly 単位**: per-biblio で readonly:true を貼ることで、agent が装備中 biblio に
  書き戻して状態を腐らせる経路を物理的に塞ぐ (= 装備状態の cleanup は host 側 1 箇所に集約)。

## 同一抽象 spec が Docker / K8s 両方を透過する仕組み

mount 配線は `src/container-runner.ts:buildMounts` 末尾の `appendEquippedBiblioMounts`
で行う。実体は以下の単純な 4 フィールド `VolumeMount` を push するだけ:

```typescript
{
  hostPath: '<DATA_DIR>/biblio-equipped/<biblioName>',
  subPath: 'biblio-equipped/<biblioName>',  // DATA_DIR 相対
  containerPath: '/workspace/biblios/<biblioName>',
  readonly: true,
}
```

これを runtime 2 経路でどう解釈するか:

| runtime | `subPath` の扱い | `hostPath` の扱い |
| --- | --- | --- |
| **Docker (Local)** | 無視 | `-v <hostPath>:<containerPath>:ro` で直接 bind mount |
| **K8s Job (GKE)** | PVC subPath として `volumeMounts[].subPath` に渡す | 参照しない (`hostPath` は agent Pod では使えない = Warden deny) |

GKE Autopilot の Warden 制約 (`autogke-no-write-mode-hostpath`) は agent Pod に
hostPath を許さないため、K8s 経路では orchestrator StatefulSet の RWO PVC を Job Pod
と subPath で共有する設計 (M2 PRD A Phase 2.5 で確立)。`subPathOf(hostPath, DATA_DIR)` で
自動算出される DATA_DIR 相対 path を `volumeMounts[].subPath` にそのまま乗せる。

逆に Docker は subPath を無視して `hostPath` を直接 bind mount するので、両 runtime が
**同一の `VolumeMount` 抽象** を受け取り、provider 側 (`src/adapters/container/docker.ts`,
`src/adapters/container/k8s.ts`) で正しい spec に翻訳する。

## install timing 判断: ephemeral spawn-time install (Phase 2 実装済)

装備された biblio を agent コンテナ内で実行できる状態にする方法には大別して 2 経路ある:

| 方式 | 実行タイミング | M9 (本体に焼かない) 遵守 | 採用判断 |
| --- | --- | --- | --- |
| build-time install | agent image build 時に `claude plugin install` | × (装備 biblio が image に焼き込まれる) | 不採用 |
| **ephemeral spawn-time install** | agent コンテナ spawn 時に `claude plugin install` を 1 度実行 | ◯ (コンテナ終了で消える) | **採用、Phase 2 で `/app/install-biblios.sh` として実装** |

PoC-11 (`/home/proj/wforest/repos/PoC/biblio-poc-11-biblio-sandbox-exec/agent-container/Dockerfile`) は
build-time install を試したが、装備リスト変更ごとに image rebuild が必要 = M9 違反として
不採用。M3 Phase 2 で **spawn-time install** を採用、`container/install-biblios.sh` という
wrapper script を Dockerfile に COPY して image 内 `/app/install-biblios.sh` に配置、
`src/container-runner.ts:buildContainerSpec` の `command` を
`['-c', '/app/install-biblios.sh && exec bun run /app/src/index.ts']` に変更することで、
agent コンテナ spawn 時に install_biblios が agent-runner より先に発火するようにした。

install_biblios.sh の挙動:

- `/workspace/biblios/*/` を loop (装備 0 件は no-op で早期 exit)
- 各 biblio dir の `.claude-plugin/marketplace.json` を jq で読み、`name` (= marketplace name)
  と `plugins[].name` を抽出
- `claude plugin marketplace add <dir>` (idempotent) → `claude plugin install <plugin>@<mp-name>
  --scope user` → `claude plugin enable <plugin>` (既 enable で fail しても `|| true` で許容)
- log は `>&2` に流し、agent-runner の stdout を汚さない

`--scope user` install は agent コンテナ内 `/home/node/.claude/plugins/` に書き込み、
コンテナ終了で消える (= M9 遵守、§ephemeral 保証の境界参照)。

## ephemeral 保証の境界 (Phase 1 + Phase 2)

「装備状態を本体に焼き込まない (M9)」の保証は 2 層に分かれる:

1. **コンテナ層**:
   - Docker: `docker run --rm` で container 終了時に container 層を自動削除。bind mount
     の source (`<DATA_DIR>/biblio-equipped/<name>/`) は host に残るが、これは「装備源」
     として意図的に残置する (= 次 session で再利用、解除 / 焼却は Phase 3 で扱う = §Phase 3 参照)。
   - K8s: Job の `ttlSecondsAfterFinished=120` で Pod が GC される。PVC subPath の中身は
     orchestrator PVC に残るが、これも同上の意図的残置。
2. **装備状態層** (Phase 2 で確立):
   - `install-biblios.sh` が `--scope user` で install するので、生成される plugin state は
     コンテナ内 `/home/node/.claude/plugins/` に書かれ、container 終了で消える
     (= 1 で挙げた container 層の GC に依存)。**明示的な cleanup hook は不要** (Phase 2
     設計判断、Q3 参照)。
   - `handle.waitForExit().then(...)` (`src/container-runner.ts:170-190`) は touch しない。
     state 消滅は container 層 GC に完全に委ね、host TS 側で「装備を解除する」操作は
     `session_equipped_biblios` の DELETE / clear で十分。

つまり Phase 2 完了時点で「装備 → 実行 → 解除」のサイクルは閉じる:
- **装備**: `session_equipped_biblios` に upsert + `<DATA_DIR>/biblio-equipped/<name>/` に
  fixture を投入 (verify-m3-phase-2.sh が事前 step として行う)
- **実行**: spawn 時に install-biblios.sh が走り、agent-runner が起動するまでに plugin が
  enable 済 = SKILL が claude SDK から発見可能 = patron 依頼で発火
- **解除**: container 終了で agent 内 `/home/node/.claude/plugins/` が消滅 (= M9 遵守)、
  装備源は意図的残置 (= 次 session で再 install されて再 enable される、冪等動作)

## Phase 1 の verify 経路

`scripts/verify-m3-phase-1.sh` が 2 経路で marker を読む:

- **Docker local 経路**: `<DATA_DIR>/biblio-equipped/<name>/marker.txt` を host から直読み
  + `pnpm exec tsx scripts/biblio-equip-mount-check.ts` で unit-level に確認
- **GKE 経路**: `kubectl exec biblio-orchestrator-0 -c orchestrator -- cat
  /data/biblio-equipped/<name>/marker.txt` で PVC subPath 経路を確認

Phase 1 では「物理経路成立」 = host 側から marker が読める、で十分。Phase 2 で agent-runner
経由の SKILL 発火検証を追加した。

## Phase 2 の verify 経路

`scripts/verify-m3-phase-2.sh` が以下の流れで verify する:

1. **Phase 1 regression**: `bash scripts/verify-m3-phase-1.sh` を pre-step で呼んで Phase 1
   verify が引き続き通ることを確認 (= fixture の `marker.txt` は backward compat 残置)
2. **Phase A (Docker local)**: fixture (= PoC-11 同形 marketplace 構造) を `<DATA_DIR>/biblio-equipped/<name>/`
   に投入 → `scripts/biblio-equip-spawn-verify.ts` を実行 (= test agent group / session ensure →
   装備リスト upsert → inbound 直書き → wakeContainer → outbound 60s+ poll → marker grep) →
   marker_found を assert → host 装備源残置を assert → 2 回目 spawn-verify で install 冪等性を確認
3. **Phase B (GKE)**: tar 経路で fixture を PVC に投入 → orchestrator Pod 内から spawn-verify
   を実行 → marker_found assert → PVC 装備源残置 assert

NetworkPolicy (`k8s/60-netpol-agent-egress.yaml`) は M2 PRD A で agent label
(`component=agent`) に対して全 Job Pod に適用済 + 外部 443/TCP 許可済のため、Phase 2 では
拡張不要。verify Phase B では「適用済」を `kubectl get networkpolicy` で確認するだけ
(= Phase 1 regression 内で実行される)。

## 後続 Phase への申し送り

### Phase 2 (equip-autonomous) — 実装完了

- ✅ **装備リスト解決の DB 化**: `resolveEquippedBiblios(session)` の内部実装を env
  (`BIBLIO_EQUIPPED_NAMES`) → DB lookup (`session_equipped_biblios` テーブル) に置換。
  signature は変えず、`buildMounts` への影響なし。env は test only バックドアとして残置。
  実装は `src/biblio/equip.ts` + `src/db/session-equipped-biblios.ts` + migration 017。
- ✅ **install lifecycle (`claude plugin install --scope user`)**: `container/install-biblios.sh`
  wrapper script が spawn 時に `/workspace/biblios/*/` を loop して
  `claude plugin marketplace add → install --scope user → enable` を発火。
  entry point は `src/container-runner.ts:buildContainerSpec` の `command` 文字列
  (= `['-c', '/app/install-biblios.sh && exec bun run /app/src/index.ts']`)。
- ✅ **cleanup hook**: 明示的な cleanup hook は **追加しない**。`--scope user` install で
  書かれた `/home/node/.claude/plugins/` は container 層 GC (= Docker `--rm` / K8s
  `ttlSecondsAfterFinished`) で消える (= §ephemeral 保証の境界参照)。
- ✅ **同時複数装備**: `session_equipped_biblios.order_index` ASC で順序保証、
  `/workspace/biblios/<name1>/`, `<name2>/`, ... と並列 mount は Phase 1 から不変。

### Phase 3 (equip-disposal) 完了済 ✅

- **禁書** (= shelf 除去 + 装備可残置): `src/biblio/enkin.ts` + `src/biblio/enkin-action.ts`
  + `scripts/biblio-enkin.ts` で実装。`<DATA_DIR>/biblio-equipped/<name>/` は **意図的に残置**
  (= 再装備可)。
- **焼却** (= shelf 除去 + 物理削除 = 装備不可): `src/biblio/shokyaku.ts` +
  `src/biblio/shokyaku-action.ts` + `scripts/biblio-shokyaku.ts` で実装。`fs.rmSync(...)`
  で装備源 dir を物理削除 + `deleteEquippedBiblioByName` で全 session の装備リストから
  個別削除 (= 次回 spawn 以降の `equipped biblio dir not found` warn ノイズ抑制)。
- **HITL 経路**: 禁書 / 焼却の MCP tool 発火 → `requestApproval('enkin_confirm' /
  'shokyaku_confirm', ...)` で admin (DEN) DM カード → 承認後に `registerApprovalHandler`
  callback が `enkin()` / `shokyaku()` を実行 → `notify()` で patron に PR URL 通知。
  破壊操作の最終 gate を admin に集約 (= 取り違え事故防止)。
- **shelf-gh.ts 共通化**: `shelve.ts` から `ghFetch` / `GhHttpError` / `fetchMarketplace`
  / `pluginsOf` / `createCommit` / `readShelveEnv` を `src/biblio/shelf-gh.ts` に切り出し、
  `shelve.ts` (追加方向) と `unshelve.ts` (削除方向 = `sha:null + base_tree`) の両方から
  共有。GitHub Git Data API の wire 経路は 1 箇所に集約された。
- **`UnshelveResult` + `EnkinResult` / `ShokyakuResult`**: `src/biblio/types.ts` に追加。
  失敗分類 `UnshelveFailureReason` (`not_shelved` / `github_api_error` / `invalid_category`)
  + 成功時 `{ ok: true, biblioName, category, prUrl, prNumber, branchName }`。enkin /
  shokyaku は `UnshelveResult` の type alias (= 挙動が完全に同 shape)。
- **`enkin_biblio` / `shokyaku_biblio` MCP tool** (3 段経路 = MCP tool → action handler →
  approval handler): `container/agent-runner/src/mcp-tools/biblio.ts` に追加、`registerTools`
  が 6 tool 体制に拡張。`category` も MCP tool input に required で、agent が categorize.ts
  の結果を再利用して渡す前提 (= 装備機構の disposal 経路は shelf path 計算に category 必須)。

### Phase 3.5 への申し送り (= 本 Phase 3 では Out of Scope)

- **`equip_biblio` / `disequip_biblio` MCP tool**: agent が自律的に装備リスト
  (`session_equipped_biblios`) を変更する MCP 経路。HITL 不要で即時実行。装備リスト
  変更が現 container には反映されない (= mount は spawn 時に固定) 設計を agent に伝える
  skill description / response text で「次回 spawn から効く」を周知。
- 想定追加: `src/biblio/equip-action.ts` 新規 + `src/db/session-equipped-biblios.ts` に
  `addEquippedBiblio(sessionId, biblioName)` / `removeEquippedBiblio(sessionId, biblioName)`
  追加 + `container/agent-runner/src/mcp-tools/biblio.ts` に 2 tool 追加 (= 30KB plan 目安)。
- 本 Phase 3 で導入した `deleteEquippedBiblioByName` は **全 session 横断削除** であり、
  Phase 3.5 の **session 単位の部分操作** とは semantics が異なる (= 同居可、別 API)。

### Phase 5 (m3-verify) 完了

`scripts/verify-m3.sh` で次の 3 項目を消化済 (= 本 Phase 3 で残した申し送りを Phase 5 で実装完結):

- **assertion 1-4 (装備 + 解除 + 禁書 + 焼却)**: `bash scripts/verify-m3-phase-3.sh "${@}"` を
  regression chain として呼び出す構造 (= verify-m3.sh:128 付近)。Phase 1-3 の個別 verify を
  「単独叩き可」のまま温存しつつ、Phase 5 では 1 度に消化する。
- **assertion 5-6 (蔵書一覧)**: `scripts/biblio-list.ts` を CLI 直叩きで `RESULT=<json>` 消費
  (Slack adapter / MCP tool は通さない純粋関数経路、verify-m3.sh:139-200 付近)。
- **destructive E2E 必須化**: pre-flight で `${VERIFY_M3_P3_BIBLIO:?...}` / `${VERIFY_M3_P3_CATEGORY:?...}`
  を fail-fast 必須化 (= verify-m3.sh:78-79)、Phase 3 の skip 経路には倒れず必ず enkin/shokyaku が走る。
- **draft PR cleanup 自動化**: trap で `gh pr list --search 'is:pr is:open draft:true (head:enkin/ OR head:shokyaku/)'`
  + `gh pr close --delete-branch` を実行 (verify-m3.sh:96-118 の `cleanup_destructive_prs`)。
  本 Phase 3 の「手動 cleanup 運用」を巻き取り、verify 失敗 / Ctrl+C 経由でも draft PR が残らない。

詳細: `scripts/verify-m3.sh` 冒頭コメント + plan `.claude/PRPs/plans/completed/m3/phase-5-m3-verify.plan.md`。

### Phase 3 完成判定の流れ

- 単体テスト: `pnpm test src/biblio/{unshelve,enkin-action,shokyaku-action}.test.ts`
  (= 24 ケース、`UnshelveResult` + HITL + payload 検証を網羅)
- Phase 1-3 連鎖 verify: `bash scripts/verify-m3-phase-3.sh` → Phase 2 regression
  + smoke (not_shelved) で `M3 P3 PASS` 出力
- destructive E2E (= 任意): `VERIFY_M3_P3_BIBLIO=<owner>--<name> VERIFY_M3_P3_CATEGORY=biblio-dev
  bash scripts/verify-m3-phase-3.sh` → 実 shelf に draft PR 2 つ作成 (cleanup 手動)
