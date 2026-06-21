# 装備機構 — 物理配置 (M3 Phase 1)

biblio-claw の装備機構 (souwa / equip) は、棚から取り出した biblio を agent-container に
取り込んで実行する経路を構築する。本書はその中核となる **物理配置 (= ホスト側のソース
位置と agent 側の mount 先 path 規約)** を扱う。M3 Phase 1 で確立した範囲のみを記す
(install ライフサイクル / 解除 / 焼却は後続 Phase の申し送りとして末尾に集約)。

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

## install timing 判断: ephemeral spawn-time install

装備された biblio を agent コンテナ内で実行できる状態にする方法には大別して 2 経路ある:

| 方式 | 実行タイミング | M9 (本体に焼かない) 遵守 | 採用判断 |
| --- | --- | --- | --- |
| build-time install | agent image build 時に `claude plugin install` | × (装備 biblio が image に焼き込まれる) | 不採用 |
| **ephemeral spawn-time install** | agent コンテナ spawn 時に `claude plugin install` を 1 度実行 | ◯ (コンテナ終了で消える) | **採用** |

PoC-11 (`/home/proj/wforest/repos/PoC/biblio-poc-11-biblio-sandbox-exec/agent-container/Dockerfile`) は
build-time install を試したが、装備リスト変更ごとに image rebuild が必要 = M9 違反として
不採用。Phase 2 で **spawn-time install** を採用する (詳細は後続 Phase の申し送り §Phase 2 参照)。

## ephemeral 保証の境界 (Phase 1 範囲外を含む)

「装備状態を本体に焼き込まない (M9)」の保証は 2 層に分かれる:

1. **コンテナ層**:
   - Docker: `docker run --rm` で container 終了時に container 層を自動削除。bind mount
     の source (`<DATA_DIR>/biblio-equipped/<name>/`) は host に残るが、これは「装備源」
     として意図的に残置する (Phase 2 で再利用、解除/焼却で別途処理 = §Phase 3 参照)。
   - K8s: Job の `ttlSecondsAfterFinished=120` で Pod が GC される。PVC subPath の中身は
     orchestrator PVC に残るが、これも同上の意図的残置。
2. **装備状態層** (Phase 2 で実装):
   - Phase 1 では `appendEquippedBiblioMounts` が **mount を貼るだけ** で、`claude plugin
     install` 等のインストールは行わない。Phase 1 verify は `marker.txt` を読めるかだけ。
   - Phase 2 で `handle.waitForExit().then(...)` (`src/container-runner.ts:170-190` 付近)
     に cleanup hook を追加し、agent コンテナ内 `~/.claude/plugins/<name>/` 等の作業状態
     (= image-layer に残る恐れがある領域) を明示的に flush する。

つまり Phase 1 単独では「mount された装備源を agent から読める」までで停止する設計。
install / cleanup の lifecycle は Phase 2 で導入する。

## Phase 1 の verify 経路

`scripts/verify-m3-phase-1.sh` が 2 経路で marker を読む:

- **Docker local 経路**: `<DATA_DIR>/biblio-equipped/<name>/marker.txt` を host から直読み
  + `pnpm exec tsx scripts/biblio-equip-mount-check.ts` で unit-level に確認
- **GKE 経路**: `kubectl exec biblio-orchestrator-0 -c orchestrator -- cat
  /data/biblio-equipped/<name>/marker.txt` で PVC subPath 経路を確認

agent-container を spawn して `agent-runner` 経由で marker を読む経路は Phase 2 (装備自律
呼び出し) で導入する。Phase 1 では「物理経路成立」 = host 側から marker が読める、で十分。

NetworkPolicy (`k8s/60-netpol-agent-egress.yaml`) は M2 PRD A で agent label
(`component=agent`) に対して全 Job Pod に適用済 + 外部 443/TCP 許可済のため、Phase 1 では
拡張不要。verify では「適用済」を `kubectl get networkpolicy` で確認するだけ。

## 後続 Phase への申し送り

### Phase 2 (equip-autonomous)

- **装備リスト解決の DB 化**: `resolveEquippedBiblios(session)` の内部実装を env
  (`BIBLIO_EQUIPPED_NAMES`) → DB lookup (新 table `session_equipped_biblios` or 既存
  `sessions` table に JSON 列追加) に置換。signature は変えず、`buildMounts` への影響なし。
- **install lifecycle (`claude plugin install --scope user`)**: spawn-time で
  `<DATA_DIR>/biblio-equipped/<name>/.claude-plugin/marketplace.json` を agent コンテナ
  起動時に register。entry point は `src/container-runner.ts:buildContainerSpec` の
  `command` 末尾、または pre-spawn hook 経路。
- **cleanup hook**: `handle.waitForExit().then(...)` に biblio cleanup ロジックを追加。
  Phase 1 の物理配置 (`<DATA_DIR>/biblio-equipped/<name>/`) は **持続させ** (別 session で
  再利用可能)、agent コンテナ内 `~/.claude/plugins/<name>/` のみ flush する。
- **同時複数装備**: 装備リストが N 件のとき、`/workspace/biblios/<name1>/`,
  `<name2>/`, ... と並列 mount。順序保証は `BIBLIO_EQUIPPED_NAMES` csv 順 (= Phase 1 で
  確立済) を踏襲。Phase 2 で DB 化したあとも順序保証を `ORDER BY` で明示する。

### Phase 3 (equip-disposal)

- **禁書** (= shelf からの除去 + 装備可残置): `<DATA_DIR>/biblio-equipped/<name>/` を
  **残置**、`shelve.ts` の PR 作成パターン (= Git Data API) を逆方向に使って shelf から
  除去する。
- **焼却** (= shelf からの除去 + 物理削除 = 装備不可): `<DATA_DIR>/biblio-equipped/<name>/`
  を `fs.rmSync(...)` で物理削除、shelf からも除去。verify は焼却後に同 biblio を equip
  試行して `equipped biblio dir not found, skipping` warn が出る (= 物理削除済) で確認可能。

### Phase 5 (m3-verify)

- `verify-m3-phase-1.sh` の Phase A + Phase B assertion を `verify-m3.sh` の assertion 1-2
  として組み込む。残り (解除 / 禁書 / 焼却 / 蔵書一覧) は Phase 2-4 完了後に統合。
