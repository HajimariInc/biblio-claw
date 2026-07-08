# 装備機構 — 物理配置 + 自律呼び出し

> **語彙メモ**: biblio-claw 独自語彙 (`biblio` / `司書` / `patron` / `装備` / `禁書` / `焼却` 等) の解説は [`glossary.md`](glossary.md) 参照。

biblio-claw の装備機構 (souwa / equip) は、棚から取り出した biblio を agent-container に
取り込んで実行する経路を構築する。本書はその中核となる **物理配置 (= ホスト側のソース
位置と agent 側の mount 先 path 規約)** + **spawn-time install ライフサイクル** を扱う。
装備機構の物理配置を確立し、spawn-time install + SKILL 発火経路を段階的に実装した
(解除 / 焼却の詳細は本書末尾に集約)。

## 物理配置 path 規約

| 役割 | path | 備考 |
| --- | --- | --- |
| host 側 source root | `<DATA_DIR>/biblio-equipped/` | 仕入れ済み biblio の `quarantine/` と並列、PVC (GKE) / data/ (Local) に直置き |
| host 側 per-biblio | `<DATA_DIR>/biblio-equipped/<biblioName>/` | `biblioName` は `BIBLIO_NAME_RE` (`<owner>--<name>` 形式) を強制 |
| agent 側 mount root | `/workspace/biblios/` | session 内 `agent-runner` から見える共通親 |
| agent 側 per-biblio | `/workspace/biblios/<biblioName>/` | readonly、装備中 biblio 1 件 |

`biblioName` を `<owner>--<name>` の 2 セグメント形式に強制するのは、

1. **dedup key**: 別 owner の同名 repo を同一 host dir で衝突させない
   (`acquire.ts` と同方針)。
2. **path traversal 防御**: agent が任意の文字列を投げてきても、`path.join` 前に
   `../../tmp/evil` 形式を弾く。

の 2 目的を兼ねる。検証は `src/biblio/action-helpers.ts:BIBLIO_NAME_RE` (仕入れ時に確立済の
正規表現) を再利用する。

## mount トポロジ

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                              装備物理配置                                    ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║   <DATA_DIR>/                                                                ║
║     ├── v2.db                                  (host 既存)                   ║
║     ├── v2-sessions/<ag>/<sess>/               (既存、Two-DB セッション)     ║
║     ├── groups/<folder>/                       (既存、agent group fs)        ║
║     ├── quarantine/<biblioName>/               (仕入れ後の格納先)            ║
║     └── biblio-equipped/                       ★ 装備機構で確立              ║
║          └── <biblioName>/                                                   ║
║               ├── marker.txt                                                 ║
║               ├── marker.env                                                 ║
║               ├── .claude-plugin/marketplace.json                            ║
║               └── plugins/<plugin>/                                          ║
║                                                                              ║
║   agent-container (spawn 後):                                                ║
║     /workspace/                                                              ║
║       ├── inbound.db, outbound.db, .heartbeat   (session DB、RW)             ║
║       ├── agent/                                (group dir、RW)              ║
║       └── biblios/                              ★ 装備機構で確立             ║
║            └── <biblioName>/                    (readonly, per-biblio)       ║
║                 ├── marker.txt                                               ║
║                 ├── marker.env                                               ║
║                 ├── .claude-plugin/marketplace.json                          ║
║                 └── plugins/<plugin>/                                        ║
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
と subPath で共有する設計 (orchestrator PVC 共有設計で確立)。`subPathOf(hostPath, DATA_DIR)` で
自動算出される DATA_DIR 相対 path を `volumeMounts[].subPath` にそのまま乗せる。

逆に Docker は subPath を無視して `hostPath` を直接 bind mount するので、両 runtime が
**同一の `VolumeMount` 抽象** を受け取り、provider 側 (`src/adapters/container/docker.ts`,
`src/adapters/container/k8s.ts`) で正しい spec に翻訳する。

## install timing 判断: ephemeral spawn-time install

装備された biblio を agent コンテナ内で実行できる状態にする方法には大別して 2 経路ある:

| 方式 | 実行タイミング | 装備状態を本体に焼かない原則 遵守 | 採用判断 |
| --- | --- | --- | --- |
| build-time install | agent image build 時に `claude plugin install` | × (装備 biblio が image に焼き込まれる) | 不採用 |
| **ephemeral spawn-time install** | agent コンテナ spawn 時に `claude plugin install` を 1 度実行 | ◯ (コンテナ終了で消える) | **採用、`/app/install-biblios.sh` として実装** |

先行 PoC で build-time install (agent image build 時に `claude plugin install`) を試した経緯があるが、
装備リスト変更ごとに image rebuild が必要となる = 「装備状態を本体に焼かない」原則違反として不採用。
本実装では **spawn-time install** を採用し、`container/install-biblios.sh` という
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
コンテナ終了で消える (= 装備状態を本体に焼かない原則 遵守、§ephemeral 保証の境界参照)。

## ephemeral 保証の境界

「装備状態を本体に焼き込まない」の保証は 2 層に分かれる:

1. **コンテナ層**:
   - Docker: `docker run --rm` で container 終了時に container 層を自動削除。bind mount
     の source (`<DATA_DIR>/biblio-equipped/<name>/`) は host に残るが、これは「装備源」
     として意図的に残置する (= 次 session で再利用、解除 / 焼却は本書後段の解除 / 焼却 section で扱う)。
   - K8s: Job の `ttlSecondsAfterFinished=120` で Pod が GC される。PVC subPath の中身は
     orchestrator PVC に残るが、これも同上の意図的残置。
2. **装備状態層**:
   - `install-biblios.sh` が `--scope user` で install するので、生成される plugin state は
     コンテナ内 `/home/node/.claude/plugins/` に書かれ、container 終了で消える
     (= 1 で挙げた container 層の GC に依存)。**明示的な cleanup hook は不要**。
   - `handle.waitForExit().then(...)` (`src/container-runner.ts:170-190`) は touch しない。
     state 消滅は container 層 GC に完全に委ね、host TS 側で「装備を解除する」操作は
     `session_equipped_biblios` の DELETE / clear で十分。

つまり本装備機構により「装備 → 実行 → 解除」のサイクルが閉じる:
- **装備**: `session_equipped_biblios` に upsert + `<DATA_DIR>/biblio-equipped/<name>/` に
  fixture を投入 (`verify-m3-phase-2.sh` が事前 step として行う)
- **実行**: spawn 時に install-biblios.sh が走り、agent-runner が起動するまでに plugin が
  enable 済 = SKILL が claude SDK から発見可能 = patron 依頼で発火
- **解除**: container 終了で agent 内 `/home/node/.claude/plugins/` が消滅 (= 装備状態を本体に焼かない原則 遵守)、
  装備源は意図的残置 (= 次 session で再 install されて再 enable される、冪等動作)

## verify 経路 (marker.txt readback)

`scripts/verify-m3-phase-1.sh` が 2 経路で marker を読む:

- **Docker local 経路**: `<DATA_DIR>/biblio-equipped/<name>/marker.txt` を host から直読み
  + `pnpm exec tsx scripts/biblio-equip-mount-check.ts` で unit-level に確認
- **GKE 経路**: `kubectl exec biblio-orchestrator-0 -c orchestrator -- cat
  /data/biblio-equipped/<name>/marker.txt` で PVC subPath 経路を確認

物理経路成立 = host 側から marker が読める、で十分。SKILL 発火検証は次節の spawn 経路で扱う。

## verify 経路 (spawn + SKILL 発火)

`scripts/verify-m3-phase-2.sh` が以下の流れで verify する:

1. **物理経路 regression**: `bash scripts/verify-m3-phase-1.sh` を pre-step で呼んで
   marker readback verify が引き続き通ることを確認 (= fixture の `marker.txt` は backward compat 残置)
2. **Docker local**: fixture (= marketplace 形式の repo 構造) を `<DATA_DIR>/biblio-equipped/<name>/`
   に投入 → `scripts/biblio-equip-spawn-verify.ts` を実行 (= test agent group / session ensure →
   装備リスト upsert → inbound 直書き → wakeContainer → outbound 60s+ poll → marker grep) →
   marker_found を assert → host 装備源残置を assert → 2 回目 spawn-verify で install 冪等性を確認
3. **GKE**: tar 経路で fixture を PVC に投入 → orchestrator Pod 内から spawn-verify
   を実行 (= `CONTAINER_PROVIDER=k8s` で scratchpad fallback は `@kubernetes/client-node` の
   `readNamespacedPodLog` 経由、docker/kubectl バイナリ不要) → marker_found assert → PVC 装備源残置 assert

NetworkPolicy (`k8s/60-netpol-agent-egress.yaml`) は agent label
(`component=agent`) に対して全 Job Pod に適用済 + 外部 443/TCP 許可済のため、spawn verify では
拡張不要。verify GKE 経路では「適用済」を `kubectl get networkpolicy` で確認するだけ
(= 物理経路 regression 内で実行される)。

## 装備リストの解決 (env → DB)

- **装備リスト解決の DB 化**: `resolveEquippedBiblios(session)` の内部実装を env
  (`BIBLIO_EQUIPPED_NAMES`) → DB lookup (`session_equipped_biblios` テーブル) に置換。
  signature は変えず、`buildMounts` への影響なし。env は test only バックドアとして残置。
  実装は `src/biblio/equip.ts` + `src/db/session-equipped-biblios.ts` + migration 017。
- **install lifecycle (`claude plugin install --scope user`)**: `container/install-biblios.sh`
  wrapper script が spawn 時に `/workspace/biblios/*/` を loop して
  `claude plugin marketplace add → install --scope user → enable` を発火。
  entry point は `src/container-runner.ts:buildContainerSpec` の `command` 文字列
  (= `['-c', '/app/install-biblios.sh && exec bun run /app/src/index.ts']`)。
- **cleanup hook**: 明示的な cleanup hook は **追加しない**。`--scope user` install で
  書かれた `/home/node/.claude/plugins/` は container 層 GC (= Docker `--rm` / K8s
  `ttlSecondsAfterFinished`) で消える (= §ephemeral 保証の境界参照)。
- **同時複数装備**: `session_equipped_biblios.order_index` ASC で順序保証、
  `/workspace/biblios/<name1>/`, `<name2>/`, ... と並列 mount する。

## 解除 / 焼却

- **禁書** (= shelf 除去 + 装備可残置): `src/biblio/enkin.ts` + `src/biblio/enkin-action.ts`
  + `scripts/biblio-enkin.ts` で実装。`<DATA_DIR>/biblio-equipped/<name>/` は **意図的に残置**
  (= 再装備可)。
- **焼却** (= shelf 除去 + 物理削除 = 装備不可): `src/biblio/shokyaku.ts` +
  `src/biblio/shokyaku-action.ts` + `scripts/biblio-shokyaku.ts` で実装。`fs.rmSync(...)`
  で装備源 dir を物理削除 + `deleteEquippedBiblioByName` で全 session の装備リストから
  個別削除 (= 次回 spawn 以降の `equipped biblio dir not found` warn ノイズ抑制)。
  Fugue channel 対応で `deleteFugueEquippedBiblioByName` を追加し、Fugue channel-scoped
  装備状態 (`fugue_equipped_biblios`、本書が扱う session-scoped mount topology とは別 store。
  詳細は [db-central.md](db-central.md) migration 019 参照) からも同時に除去する。禁書 (enkin)
  は両 store とも touch しない対称性を維持 (= 装備状態残置で再装備可)。
- **HITL 経路**: 禁書 / 焼却の MCP tool 発火 → `requestApproval('enkin_confirm' /
  'shokyaku_confirm', ...)` で admin DM カード → 承認後に `registerApprovalHandler`
  callback が `enkin()` / `shokyaku()` を実行 → `notify()` で patron に PR URL 通知。
  破壊操作の最終 gate を admin に集約 (= 取り違え事故防止)。
- **shelf-gh.ts 共通化**: `shelve.ts` から `ghFetch` / `GhHttpError` / `fetchMarketplace`
  / `pluginsOf` / `createCommit` / `readShelveEnv` を `src/biblio/shelf-gh.ts` に切り出し、
  `shelve.ts` (追加方向) と `unshelve.ts` (削除方向 = `sha:null + base_tree`) の両方から
  共有。GitHub Git Data API の wire 経路は 1 箇所に集約された。
  read-only 経路向けに `readListEnv()` / `ListEnv` を追加。`readShelveEnv` (4 件必須) は write
  経路 (shelve / unshelve / enkin / shokyaku) が継続利用、`list-biblio.ts` は `readListEnv`
  (owner/repo のみ) に切替済。`fetchMarketplace` の引数型も `ShelfEnv` → `ListEnv` に変更
  (= list-biblio 経路で author env 不在でも呼出可)。
- **`UnshelveResult` + `EnkinResult` / `ShokyakuResult`**: `src/biblio/types.ts` に追加。
  失敗分類 `UnshelveFailureReason` (`not_shelved` / `github_api_error` / `invalid_category` / `config_error`)
  + 成功時 `{ ok: true, biblioName, category, prUrl, prNumber, branchName }`。enkin /
  shokyaku は `UnshelveResult` の type alias (= 挙動が完全に同 shape)。
- **`enkin_biblio` / `shokyaku_biblio` MCP tool** (3 段経路 = MCP tool → action handler →
  approval handler): `container/agent-runner/src/mcp-tools/biblio.ts` に追加、`registerTools`
  が 6 tool 体制に拡張。`category` も MCP tool input に required で、agent が categorize.ts
  の結果を再利用して渡す前提 (= 装備機構の disposal 経路は shelf path 計算に category 必須)。

## 今後の拡張 (session 単位の部分操作)

- **`equip_biblio` / `disequip_biblio` MCP tool**: agent が自律的に装備リスト
  (`session_equipped_biblios`) を変更する MCP 経路。HITL 不要で即時実行。装備リスト
  変更が現 container には反映されない (= mount は spawn 時に固定) 設計を agent に伝える
  skill description / response text で「次回 spawn から効く」を周知。
- 想定追加: `src/biblio/equip-action.ts` 新規 + `src/db/session-equipped-biblios.ts` に
  `addEquippedBiblio(sessionId, biblioName)` / `removeEquippedBiblio(sessionId, biblioName)`
  追加 + `container/agent-runner/src/mcp-tools/biblio.ts` に 2 tool 追加。
- 既存の `deleteEquippedBiblioByName` は **全 session 横断削除** であり、
  今後の拡張対象である **session 単位の部分操作** とは semantics が異なる (= 同居可、別 API)。

## 統合 verify

`scripts/verify-m3.sh` で次の 3 項目を消化する:

- **assertion 1-4 (装備 + 解除 + 禁書 + 焼却)**: `bash scripts/verify-m3-phase-3.sh "${@}"` を
  regression chain として呼び出す構造。個別 verify を「単独叩き可」のまま温存しつつ、
  統合 verify では 1 度に消化する。
- **assertion 5-6 (蔵書一覧)**: `scripts/biblio-list.ts` を CLI 直叩きで `RESULT=<json>` 消費
  (Slack adapter / MCP tool は通さない純粋関数経路)。
- **destructive E2E 必須化**: pre-flight で `${VERIFY_M3_P3_BIBLIO:?...}` / `${VERIFY_M3_P3_CATEGORY:?...}`
  を fail-fast 必須化、skip 経路には倒れず必ず enkin/shokyaku が走る。
- **draft PR cleanup 自動化**: trap で `gh pr list --search 'is:pr is:open draft:true (head:enkin/ OR head:shokyaku/)'`
  + `gh pr close --delete-branch` を実行 (`cleanup_destructive_prs`)。
  verify 失敗 / Ctrl+C 経由でも draft PR が残らない。

## 完成判定の流れ

- 単体テスト: `pnpm test src/biblio/{unshelve,enkin-action,shokyaku-action}.test.ts`
  (= 24 ケース、`UnshelveResult` + HITL + payload 検証を網羅)
- 個別 verify: `bash scripts/verify-m3-phase-3.sh` → 装備 regression + smoke (not_shelved)
- destructive E2E (= 任意): `VERIFY_M3_P3_BIBLIO=<owner>--<name> VERIFY_M3_P3_CATEGORY=biblio-dev
  bash scripts/verify-m3-phase-3.sh` → 実 shelf に draft PR 2 つ作成 (cleanup 手動)
