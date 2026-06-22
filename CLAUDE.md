# biblio-claw

biblio-shelf プロジェクトの **司書実装 repo**。**NanoClaw v2 (`nanocoai/nanoclaw` @ `2492259`, 2026-05-28) を fork して base 化**。M1 (司書骨格、GKE Autopilot `biblio-prod` 稼働) + M2 (marketplace 統合 = 仕入れ→検品→カテゴライズ→陳列) + M3 (装備 + 蔵書リスト = Phase 1-5 全完了、`scripts/verify-m3.sh` で M3 PASS 取得済) まで完了済、現在は M4 以降着手前。

> **本 CLAUDE.md の構造**: 上部 = biblio-claw 固有の運用ルール (3 ロケーション / PRP / Branch 戦略 / 環境分離 / 公開ポリシー)。下部 = NanoClaw v2 上流 CLAUDE.md を継承保持 (base アーキ理解の正本)。**衝突時の優先**: 運用ルール (PRP コマンドフロー、Branch 戦略、環境分離方針、公開ポリシー) は biblio-claw 上部を優先。**アーキ理解・コード慣習** (Two-DB Session Split / Central DB / Container Config / OneCLI gateway / Bun runtime 等) は NanoClaw 下部に従う。

> **NanoClaw v1→v2 migration banner について (本 repo では適用対象外)**: NanoClaw v2 上流 CLAUDE.md の元バージョンには冒頭に「⚠️ STOP — READ THIS FIRST IF YOU ARE CLAUDE ⚠️」というバナーがあり、v1 install への v2 merge 衝突を検知したら HALT して `migrate-v2.sh` を案内する指示がある。biblio-claw は **NanoClaw からの fresh fork** (v1 install を持たない、`git clone` + rsync で取り込み済) ため、バナーの状況には該当しない。`git pull` 経由で上流の更新を取り込んで衝突した場合も、biblio-claw 側 (= 当 repo の現在の状態) を正として手動 merge する。当該バナー本文は本統合で下部から削除した。

## 入室手順

biblio-claw で作業を始める / PRP コマンドを実行する前は、`/prime` コマンドを実行する。`/prime` が次を担当する:

- **コンテキストの所在**: 構想・実装・索引の 3 ロケーション
- **標準ロード手順**: 入室時に読み込むファイルの優先順位
- **PRP コマンドカタログ**: 起草・実装・調査・コミット・PR・レビューの 5 群と使い分け
- **直近作業のスナップショット**: git log + 非公開ディレクトリの更新スキャン
- **挨拶の型**: 入室時のフロー

詳細は非公開の prime 設定を参照(`.claude/` 配下は gitignore 対象)。

## PRP コマンドフロー

本 repo は **PRP コマンドフロー** で開発する:

1. `/prp-prd` (or 議論済の場合は事前テンプレ埋め) → 大 PRD を `.claude/PRPs/prds/` に
2. `/prp-plan {prd}` → 次の pending phase の Plan を `.claude/PRPs/plans/` に
3. `/prp-implement {plan}` or `/prp-ralph {plan}` → 実装 + 検証 + レポート
4. `/prp-review-agents` → 専門エージェント並列レビュー

PRP / Phase 構造の階層モデル・判断軸・sub PRD の段階的展開・検証構成の詳細は、`/prime` 経由で参照する。

## Branch 戦略

biblio プロジェクトの branch 戦略 — **全 Milestone を横断する運用ルール**。`/prp-implement` / `/prp-pr` / `/prp-mr` などの PRP コマンドのデフォルト挙動を上書きする。PRP コマンド実行時、本セクションを最優先する。

### 4 階層モデル (M2 以降の正書き)

```
main (Protection)                                ← Milestone の終着点
  └─ base/<prd-slug>                             ← PRD (1 Milestone = N PRD)
       └─ feature/phase-<N>-<slug>               ← Phase (= plan)
            └─ Task (plan 内チェックリスト、ブランチなし)
```

| 階層 | 命名規則 | base | 目的 |
| :--- | :--- | :--- | :--- |
| **main** (Protection) | `main` | - | Prod 同等のリソース状態。Milestone 完了 = 配下 PRD 全てが合流した状態 |
| **PRD** | `base/<prd-slug>` | `main` | 1 Milestone 内の独立した実装計画単位。Milestone 配下で `base/m<N>-<a/b/c>-<theme>` 形式 (例: `base/m2-a-foundation`)、Milestone なしの単発 PRD は `base/<theme>` |
| **Phase** (= plan) | `feature/phase-<N>-<slug>` | 対応する `base/<prd-slug>` | PRD 内の中間達成点。**1 plan = 1 feature の 1:1 対応**。Task はブランチを切らず plan 内チェックに降格 |

> **重要 (M1 の反省)**: 旧モデル (1 M = 1 PRD + sub PRD = Phase 単位 + Task per feature branch) を採用した M1 で **過剰分割の歪** が出た (Phase 2 plan = 68KB / Task per feature で命名揺れ多発)。M2 以降は **1 plan = 1 feature の 1:1 対応** + plan サイズ規律 (25-40KB / 300-500 行) で運用する。M1 の branch (`base/m1-p1-lib` / `base/m1-p2-prod-deploy`) は旧ルール基準で残置 (= 履歴扱い、書き換えない)。

### 例 (M2 実績)

```
main (Protection)
 ├── base/m2-a-foundation                  ← PRD A: 基盤回収 (PR #5 で main 合流済)
 │    ├── feature/phase-1-m1-cleanup         ← Phase 1 (M1 残課題)
 │    ├── feature/phase-2-init-first-agent   ← Phase 2 (init-first-agent)
 │    ├── feature/phase-2-5-pvc-subpath      ← Phase 2.5 (Autopilot Warden 回避)
 │    └── feature/phase-3-onecli-sidecar-integration  ← Phase 3 (orchestrator sidecar 統合)
 └── base/m2-b-marketplace                 ← PRD B: marketplace 本体 (PR #9 で main 合流)
      ├── feature/phase-1-shiire             ← Phase 1 (仕入れ)
      ├── feature/phase-2-kenpin             ← Phase 2 (検品)
      └── feature/phase-3-chinretsu          ← Phase 3 (カテゴライズ + 陳列 + 統合 verify)
```

### PRP コマンドへの適用

| コマンド | 起こすもの | branch 操作 |
| :--- | :--- | :--- |
| `/prp-milestone` | Milestone overview | なし (Vault に書き出す) |
| `/prp-prd` | PRD | `main` から `base/<prd-slug>` を切る (PRD 着手時) |
| `/prp-plan` | Phase plan | なし (plan ファイル生成のみ) |
| `/prp-implement` / `/prp-ralph` | Phase plan の実装 | 対応する `base/<prd-slug>` から `feature/phase-<N>-<slug>` を切る |
| `/prp-pr` / `/prp-mr` | PR / MR 作成 | feature → base への PR を作成。PRD 完了時に **別途** base → main の PR を作成 |

**デフォルトとの差**: `/prp-implement` のテンプレートは `git checkout -b feature/{plan-slug}` だが、本ルールでは **2 階層 (base/\* → feature/\*)** で運用する。

### 運用上の注意

- **PRD 完了** = PRD の全 Phase が base へ merge 済 + 統合 verify exit 0 + base → main の PR merge 済
- **Milestone 完了** = 配下 PRD 全てが main に合流した状態
- main 直 push は禁止 (Protection)
- 直近は CI/CD 未整備のため Protection は緩い (メンテナー手動運用)。Milestone 走破 or CI/CD 整備で Protection を厳格化する予定
- 本方針は biblio プロジェクト (biblio-claw / biblio-shelf) の **全 Milestone 横断**。他プロジェクトには汎用化済の wf-realm `reference/prd_phase_structure.md` を参照

### 関連ドキュメント

階層モデル・命名・PRP の汎用方法論と biblio 固有の事例集は次に分離:

- wf-realm `reference/prd_phase_structure.md` — **汎用方法論の正本** (階層・命名・PRP・検証戦略)
  - WHEN: 階層モデルの根拠・他プロジェクトへの適用判断・汎用ベストプラクティスを確認したいとき
- Vault `11-labo/biblio-shelf/design/branch-strategy.md` — **biblio 固有の事例集**
  - WHEN: M1 で何が歪んだかの振り返り / M2 の具体構成 / 注入経路の運用 / PoC との関係を確認したいとき

## 環境分離方針 (M1 / M2 採用)

M1 / M2 とも **環境分離型 (D-1)** で進めた:

- **Phase 1**: docker compose で local 実装を完成 (抽象化アダプタを含む)
- **Phase 2**: 同一バイナリを GKE へ + GCP 特有要素を追加適用

M2 PRD B (marketplace) では host 側で外部 HTTP を OneCLI proxy 経由に統一し、git/gh は `HTTPS_PROXY` を尊重、Node.js 内蔵 fetch は `undici.ProxyAgent` 経由で透過させる構成 (auto memory `biblio-host-onecli-proxy`)。M3 以降の環境分離も同方針を継承する。詳細は `/prime` 経由で参照する (環境分離方針 / 抽象化境界の設計ドキュメントは非公開エリアに格納)。

## 公開ポリシー — 重要

- **本 repo は大会提出時に public 化する**前提 (現状は private)
- **`.claude/` 配下は全 gitignore**。AI Agent の開発支援設定・PRP の議論内容は公開しない (`.gitignore` 参照)
- CLAUDE.md (root) は公開対象 (NanoClaw 上流継承部分を含む)
- 部分公開の判断は提出直前 (M5/M6 完了後)

## 関連

- biblio-shelf (棚、public) = `HajimariInc/biblio-shelf` — skill 本体 + marketplace (2026-06-12 旧 `example-org` org から移設)
- NanoClaw 上流 = `nanocoai/nanoclaw` @ `2492259` (2026-05-28) を本 repo に取り込み済 (Phase 1 Task 1 完了 2026-06-01)

---

# NanoClaw v2 上流 CLAUDE.md (継承)

> 以下は NanoClaw v2 上流 (`nanocoai/nanoclaw` @ `2492259`) の CLAUDE.md 本体。biblio-claw は本ドキュメントを **base アーキ理解の正本**として継承する。冒頭にあった「⚠️ STOP — READ THIS FIRST IF YOU ARE CLAUDE ⚠️」(v1→v2 merge 防衛バナー) は本 repo 文脈では適用対象外 (上部参照) のため削除した。それ以外は上流原文を保持する(日本語化済み)。
>
> **本セクション以下の指針が biblio-claw 上部運用ルールと衝突する場合**: PRP コマンドフロー / Branch 戦略 / 環境分離方針 / 公開ポリシー / `/prime` 読み込み順は biblio-claw 上部優先。アーキ理解・コード慣習 (Two-DB Session Split / Central DB / Container Config / OneCLI gateway / Bun runtime / pnpm policy 等) は NanoClaw 流に従う。

# NanoClaw

パーソナルな Claude アシスタント。理念とセットアップは [README.md](README.md) を参照。アーキテクチャは `docs/` 配下。

## 概要

host は単一の Node プロセスで、セッションごとの agent コンテナをオーケストレートする。プラットフォームのメッセージは channel adapter 経由で到着し、エンティティモデル(users → messaging groups → agent groups → sessions)を辿ってルーティングされ、セッションの inbound DB に書き込まれ、コンテナを起こす。コンテナ内の agent-runner は DB をポーリングし、Claude を呼び出して outbound DB に書き戻す。host は outbound DB をポーリングし、同じ adapter 経由で配信する。

**すべてはメッセージである。** host とコンテナの間に IPC、ファイルウォッチャ、stdin パイプは存在しない。2 つのセッション DB が唯一の IO 境界である。

## エンティティモデル

```
users (id "<channel>:<handle>", kind, display_name)
user_roles (user_id, role, agent_group_id)       — owner | admin (グローバル or スコープ付き)
agent_group_members (user_id, agent_group_id)    — 非特権ユーザのアクセスゲート
user_dms (user_id, channel_type, messaging_group_id) — cold-DM のキャッシュ

agent_groups (workspace, memory, CLAUDE.md, personality, container config)
    ↕ messaging_group_agents による many-to-many 関係 (session_mode, trigger_rules, priority)
messaging_groups (1 プラットフォーム上の 1 chat/channel; unknown_sender_policy)

sessions (agent_group_id + messaging_group_id + thread_id → セッションごとのコンテナ)
```

権限はユーザレベル(owner / admin)で扱い、agent group レベルでは扱わない。3 つの分離レベル(`agent-shared` / `shared` / 個別 agent)については [docs/isolation-model.md](docs/isolation-model.md) を参照。

## Two-DB セッション分割

各セッションは `data/v2-sessions/<agent_group_id>/<session_id>/` 配下に **2 つ** の SQLite ファイルを持つ:

- `inbound.db` — host が書き、コンテナが読む。`messages_in`、ルーティング、destinations、pending_questions、processing_ack。
- `outbound.db` — コンテナが書き、host が読む。`messages_out`、session_state。

各ファイルにつき writer は厳密に 1 つ — クロスマウントのロック競合は発生しない。Heartbeat は `/workspace/.heartbeat` のファイルタッチで表現し、DB 更新ではない。host は偶数の `seq` を、コンテナは奇数の `seq` を使う。

## 中央 DB

`data/v2.db` はセッション専有でないすべてを保持する: users、user_roles、agent_groups、messaging_groups、wiring、pending_approvals、user_dms、chat_sdk_*(Chat SDK ブリッジ用)、boots(biblio-claw 追加、PVC + SQLite 永続化アサーション用の決定的指紋)、session_equipped_biblios(biblio-claw 追加 M3 Phase 2、session 単位の装備リスト + order_index ASC で順序保証、session 削除で cascade)、schema_version。マイグレーションは `src/db/migrations/` 配下に置く。

skill やスクリプトからのアドホッククエリには `sqlite3` CLI ではなく、ツリー内のラッパーを使うこと: `pnpm exec tsx scripts/q.ts <db> "<sql>"`。host のセットアップは `sqlite3` バイナリへの依存を意図的に避けている(`setup/verify.ts:5`)。ラッパーはセットアップが既にインストールして検証済みの `better-sqlite3` 依存を経由する。デフォルト出力フォーマットは `sqlite3 -list`(パイプ区切り、ヘッダなし)に合わせてあるので、既存の skill のテキストはそのまま読める。

## 主要ファイル

| ファイル | 役割 |
|------|---------|
| `src/index.ts` | エントリーポイント: DB 初期化、マイグレーション、channel adapter、配信ポーリング、sweep、シャットダウン |
| `src/adapters/` | 環境差分吸収アダプタ群(biblio-claw 追加)。`getDsnProvider()`(DB / セッション DB のパス解決)、`getSchedulerProvider()`(sweep の tick 供給)、`getSecretProvider()`(OneCLI 操作)、`getContainerRuntimeProvider()`(agent コンテナの spawn / kill、Docker vs K8s Job 切替)の 4 ファクトリ。`<X>_PROVIDER` env スイッチで実装を差し替え可能 (`DSN_PROVIDER=local\|gke`、`CONTAINER_PROVIDER=docker\|k8s` 等) |
| `src/router.ts` | 受信ルーティング: messaging group → agent group → session → `inbound.db` → ウェイク |
| `src/delivery.ts` | `outbound.db` をポーリングし adapter 経由で配信、システムアクション(スケジュール、承認 等)を処理 |
| `src/host-sweep.ts` | 60 秒の sweep: `processing_ack` の同期、stale 検出、due メッセージのウェイク、再帰スケジュール(周期 tick の供給は `getSchedulerProvider()` に委譲) |
| `src/session-manager.ts` | セッションを解決し `inbound.db` / `outbound.db` をオープン、heartbeat パスを管理(DB パス算出は `getDsnProvider()` に委譲) |
| `src/container-runner.ts` | agent group ごとにコンテナを起動 (`getContainerRuntimeProvider()` 経由で Docker または K8s Job)。セッション DB と outbox をマウント (Docker = hostPath bind mount、K8s = PVC subPath volumeMount、Phase 2.5 で分岐)。`getSecretProvider()` 経由で OneCLI gateway のクレデンシャルを注入(`ensureAgent` / `applyContainerSecrets`)。`subPathOf` ヘルパは `src/adapters/container/mounts.ts`。`appendEquippedBiblioMounts` (export) で装備済 biblio を per-biblio readonly subPath mount として末尾に append (M3 Phase 1 で mount spec、Phase 2 で DB lookup 化) |
| `src/adapters/container/` | `ContainerRuntimeProvider` 抽象 + `DockerContainerRuntimeProvider` (local) + `K8sJobContainerRuntimeProvider` (GKE Batch v1 Job + Informer。K8s 経路では mounts を orchestrator RWO PVC の subPath に変換 + OneCLI CA bundle を K8s Secret から `/etc/ssl/certs/onecli` にマウント + OneCLI SDK の Docker 由来 env `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS` を cluster-internal 値に post-process + `securityContext.fsGroup: 1000` で agent user に PVC 所有権を寄せる) + factory (`CONTAINER_PROVIDER` env で切替) |
| `src/modules/permissions/access.ts` | `canAccessAgentGroup` — `user_roles` + `agent_group_members` に対する owner / global admin / scoped admin / member の解決 |
| `src/modules/approvals/primitive.ts` | `pickApprover`、`pickApprovalDelivery`、`requestApproval`、approval-handler のレジストリ |
| `src/command-gate.ts` | ルータ側の admin コマンドゲート — `user_roles` を直接クエリ(env var なし、コンテナ側チェックなし) |
| `src/modules/approvals/onecli-approvals.ts` | OneCLI の認証付きアクション承認ブリッジ |
| `src/user-dm.ts` | cold-DM の解決 + `user_dms` キャッシュ |
| `src/group-init.ts` | agent group ごとのファイルシステム scaffold(CLAUDE.md、skills、agent-runner-src のオーバーレイ) |
| `src/db/container-configs.ts` | `container_configs` テーブル(agent group ごとのコンテナランタイム設定)の CRUD |
| `src/backfill-container-configs.ts` | 起動時に旧 `container.json` ファイルを DB に移行 |
| `src/container-restart.ts` | agent group コンテナの kill + on-wake 再生成 |
| `src/db/` | DB レイヤー — agent_groups、messaging_groups、sessions、container_configs、user_roles、user_dms、pending_*、マイグレーション |
| `src/channels/` | channel adapter のインフラ(レジストリ、Chat SDK ブリッジ)。上流 NanoClaw では具体的な adapter は `channels` ブランチから skill 経由でインストール / biblio-claw では Slack adapter (`src/channels/slack.ts`) を trunk に直接コミット済 |
| `src/providers/` | host 側の provider container-config(`claude` は組み込み、`opencode` 等は `providers` ブランチからインストール) |
| `container/agent-runner/src/` | agent-runner: ポーリングループ、フォーマッタ、provider 抽象化、MCP ツール、destinations |
| `container/skills/` | 全 agent セッションにマウントされるコンテナ skill(`onecli-gateway`、`welcome`、`self-customize`、`agent-browser`、`slack-formatting`) |
| `groups/<folder>/` | agent group ごとのファイルシステム(CLAUDE.md、skills、group ごとの `agent-runner-src/` オーバーレイ) |
| `scripts/init-first-agent.ts` | 最初の DM 配線済 agent をブートストラップ(`/init-first-agent` skill から使われる) |
| `src/biblio/` | **biblio-claw 機能本体** (M2 PRD B + M3 装備機構 + M3 蔵書一覧)。`acquire.ts` 仕入れ / `inspect.ts` 検品 (Vertex × Gemini 3 軸) / `categorize.ts` カテゴライズ (Vertex × Claude Sonnet-4.6) / `shelve.ts` 陳列 (追加方向 draft PR、`shelf-gh.ts` 共有経路) / `shelf-gh.ts` GitHub Git Data API 共通レイヤ (ghFetch / GhHttpError / fetchMarketplace / pluginsOf / createCommit / readShelveEnv、shelve + unshelve + list-biblio で共有) / `unshelve.ts` 解除本体 (削除方向 draft PR、`sha:null + base_tree`) / `enkin.ts` 禁書 (unshelve 薄ラッパ、装備源残置 = 再装備可) / `shokyaku.ts` 焼却 (unshelve + fs.rmSync 物理削除 + `deleteEquippedBiblioByName`、`cleanupWarning` で patron に cleanup 失敗を伝える) / `host-proxy.ts` OneCLI proxy 経由化 (combined CA bundle で MITM/tunnel 両 trust) / `vertex-client.ts` Vertex 呼び出し (Anthropic + Gemini 両経路) / `types.ts` 型定義 + `BIBLIO_CATEGORIES` + `EquippedBiblio` + `UnshelveResult` + `ShokyakuResult` + `ListBiblioItem` / `ListBiblioParams` / `ListBiblioResult` / `action-helpers.ts` biblio action 共通ヘルパ (writeBackMessage + BIBLIO_NAME_RE + safeNotify approval handler 用) / `{acquire,inspect,categorize,shelve}-action.ts` delivery action handler (= agent → MCP → outbound → host → inbound 経路) / `{enkin,shokyaku}-action.ts` delivery action handler + approval handler (HITL 承認経路、破壊操作は admin 承認を経由) / `equip.ts` 装備機構の物理配置解決 (M3 Phase 2、`session_equipped_biblios` テーブルから session 単位で DB lookup、env override は test only バックドアとして残置) / `list-biblio.ts` 蔵書一覧本体 (M3 Phase 4、`fetchMarketplace` → source split → category filter で `ListBiblioResult` を返す純粋関数) / `list-biblio-action.ts` delivery action handler (`@bot 蔵書` 経路、不正 category は silent fallback で全件 + 注記の UX 寄せ) |
| `container/agent-runner/src/mcp-tools/biblio.ts` | agent コンテナから露出する MCP ツール 7 種(`acquire_biblio` / `inspect_biblio` / `categorize_biblio` / `shelve_biblio` / `enkin_biblio` / `shokyaku_biblio` / `list_biblio`)。各ツールは outbound.db に system action を書き、delivery poll が `src/biblio/*-action.ts` を呼ぶ。禁書 / 焼却は破壊操作のため host 側で admin 承認を経由する (HITL)。`list_biblio` は patron の自然文「蔵書」「蔵書一覧」mention を agent が tool description で自律発火する (= host 側 keyword parser を持たない) |
| `scripts/biblio-{acquire,inspect,categorize,shelve,enkin,shokyaku,list,equip-set,equip-mount-check,equip-spawn-verify}.ts` | CLI ハーネス。`RESULT=<json>` を stdout に吐き、verify スクリプト (`scripts/verify-m2*.sh` / `scripts/verify-m3*.sh`) が assert で消費する |
| `scripts/verify-m2.sh` | M2 完成判定 E2E (= 仕入れ → 検品 → カテゴライズ → 陳列 + 再 shelve graceful)。pre-flight で `.env` 存在 / OneCLI proxy 到達 / 必須 env をまとめて fail-fast |
| `scripts/verify-m3.sh` | M3 完成判定 E2E (= 装備マーカー検出 / 解除 / 禁書 (装備可) / 焼却 (装備不可) / 全蔵書一覧 / カテゴリ別蔵書一覧 の 6 assertion 統合)。`verify-m3-phase-3.sh` を regression chain として呼び出し、Phase 5 で蔵書一覧 2 assertion を追加。destructive 強制 (`VERIFY_M3_P3_BIBLIO` / `VERIFY_M3_P3_CATEGORY` を pre-flight で fail-fast) + draft PR trap cleanup |
| `migrate-v2.sh` + `setup/migrate-v2/` | v1→v2 マイグレーション。スタンドアロンスクリプト: `bash migrate-v2.sh`。DB を seed、groups / sessions をコピー、channels をインストール、コンテナをビルド、サービス切替を提案、その後 `/migrate-from-v1` skill に引き継いで owner セットアップと CLAUDE.md クリーンアップを行う。詳細は [docs/migration-dev.md](docs/migration-dev.md) を参照。 |

## 管理 CLI (`ncl`)

`ncl` は central DB を照会・変更する — agent groups、messaging groups、wirings、users、roles など。host 上では Unix ソケット経由で接続し(`src/cli/socket-server.ts`)、コンテナ内ではセッション DB を transport として使う(`container/agent-runner/src/cli/ncl.ts`)。

```
ncl <resource> <verb> [<id>] [--flags]
ncl <resource> help
ncl help
```

| リソース | 動詞 | 何か |
|----------|-------|------------|
| groups | list, get, create, update, delete, restart, config get/update, config add-mcp-server/remove-mcp-server, config add-package/remove-package | agent group(workspace、personality、container config) |
| messaging-groups | list, get, create, update, delete | 1 プラットフォーム上の 1 chat/channel |
| wirings | list, get, create, update, delete | messaging group と agent group の紐付け(セッションモード、トリガー) |
| users | list, get, create, update | プラットフォーム identity(`<channel>:<handle>`) |
| roles | list, grant, revoke | owner / admin 権限(グローバル or agent group スコープ) |
| members | list, add, remove | agent group の非特権ユーザアクセスゲート |
| destinations | list, add, remove | agent group がメッセージを送れる宛先 |
| sessions | list, get | アクティブセッション(read-only) |
| user-dms | list | cold-DM のキャッシュ(read-only) |
| dropped-messages | list | 未登録の sender からのメッセージ(read-only) |
| approvals | list, get | 承認待ちリクエスト(read-only) |

主要ファイル: `src/cli/dispatch.ts`(ディスパッチャ + approval ハンドラ)、`src/cli/crud.ts`(汎用 CRUD 登録)、`src/cli/resources/`(リソースごとの定義)。

## チャネルと provider(上流 NanoClaw: skill 経由 / biblio-claw: trunk 直接コミット)

> **上流 NanoClaw の前提** (以下 2 段落): trunk には具体的な channel adapter や非デフォルトの agent provider は同梱されていない。コードベースはレジストリ・インフラとしての役割を持ち、実際のアダプタと provider は長命の sibling ブランチに置き、skill 経由でコピーされる。

- **`channels` ブランチ** — Discord、Slack、Telegram、WhatsApp、Teams、Linear、GitHub、iMessage、Webex、Resend、Matrix、Google Chat、WhatsApp Cloud(+ ヘルパー、テスト、channel 固有のセットアップ手順)。`/add-<channel>` skill 経由でインストール。
- **`providers` ブランチ** — OpenCode(および将来の非デフォルト agent provider)。`/add-opencode` 経由でインストール。

各 `/add-<name>` skill は冪等である: `git fetch origin <branch>` → 標準パスにモジュールをコピー → 対応する barrel に self-registration の import を追記 → `pnpm install <pkg>@<pinned-version>` → ビルド。

**biblio-claw 流の運用** (上流継承と差分): 上流の `/add-<channel>` skill フローは biblio-claw では使わず、`setup/add-<channel>.sh` で取り込んだ adapter を biblio-claw の trunk (= `main`) に **直接コミット** する運用を採る。これは「fork は base を持つ = trunk が channel adapter を持って配布される」というスタンスの帰結。本 repo の `src/channels/slack.ts` は本方針の第 1 例 (Phase 1 Task 7-A、PR #4)。**したがって**、本セクション冒頭の上流前提「trunk に adapter は同梱されない」は biblio-claw には当てはまらない。

## 自己改修

現在の agent self-modification は 1 段階のみ:

1. **`install_packages` / `add_mcp_server`** — DB 上の agent group ごとのコンテナ設定の変更(apt/npm 依存、既存 MCP server の配線)。リクエストごとに admin 承認 1 回。承認されると `src/modules/self-mod/apply.ts` のハンドラが必要に応じてイメージを再ビルドし(`install_packages` のみ)、`on_wake` メッセージを書き、コンテナを kill し、`onExit` コールバック経由で再生成する。on-wake メッセージはフレッシュなコンテナの最初の poll でのみ拾われる — 死にかけのコンテナがそれを横取りすることはない。`container/agent-runner/src/mcp-tools/self-mod.ts`。

2 段目(draft/activate フロー経由でのソースレベルの直接的な self-edit)は計画段階で、未実装。

## コンテナ設定

agent group ごとのコンテナランタイム設定(provider、model、packages、MCP servers、mounts 等)は central DB の `container_configs` テーブルに置く。spawn 時に `groups/<folder>/container.json` にマテリアライズされ、container runner がそれを読む。`ncl groups config get/update` と self-mod MCP ツール経由で管理する。

**`cli_scope`** — コンテナ内から agent が `ncl` で何をできるかを制御する:

| 値 | 振る舞い |
|-------|----------|
| `disabled` | agent は ncl の存在自体を知らない(CLAUDE.md からも除外される)。host のディスパッチはあらゆる `cli_request` を拒否する。 |
| `group`(デフォルト) | agent は `groups`、`sessions`、`destinations`、`members` のみアクセス可能で、自分の agent group にスコープが限定される。`--id` と group 引数は自動補完される。クロスグループアクセスは拒否される。`cli_scope` の変更は禁止される。 |
| `global` | 制限なし。owner agent group には `init-first-agent` 経由で自動設定される。 |

主要ファイル: `src/db/container-configs.ts`、`src/container-config.ts`、`src/cli/dispatch.ts`(スコープ強制)、`src/claude-md-compose.ts`(命令文の除外)。

## コンテナ再起動

`ncl groups restart --id <group-id> [--rebuild] [--message <text>]`。実行中のコンテナを kill し、`--message` が指定されている場合は `on_wake` メッセージを書いて `onExit` コールバック経由で再生成する。`--message` なしの場合は次のユーザーメッセージでコンテナが復帰する。コンテナ内から実行した場合、`--id` は自動補完され、呼び出し側のセッションのみが再起動する。

`messages_in` の `on_wake` 列は、wake メッセージがフレッシュなコンテナの最初の poll でのみ拾われることを保証する。これにより、死にかけのコンテナ(SIGTERM の grace period 中)がメッセージを横取りする競合状態を防ぐ。`killContainer` は省略可能な `onExit` コールバックを受け取り、プロセス終了後にそれが発火するので、新しいコンテナが起動する前に古いコンテナが完全に消えていることが保証される。

主要ファイル: `src/container-restart.ts`、`src/container-runner.ts`(`killContainer`)、`container/agent-runner/src/db/messages-in.ts`(`getPendingMessages`)。

## シークレット / クレデンシャル / OneCLI

API キー、OAuth トークン、認証クレデンシャルは OneCLI gateway が管理する。シークレットはリクエスト時に agent ごとのコンテナへ注入される — env var にもチャットコンテキストにも渡さない。コンテナ内の agent はこれを `onecli-gateway` コンテナ skill(`container/skills/onecli-gateway/SKILL.md`)経由で認識する。この skill は proxy の仕組み、認証エラーの扱い方、生クレデンシャルを決して尋ねないことを agent に教える。host 側の配線: OneCLI 固有の実装は `src/adapters/secret/onecli.ts`(`SecretProvider` 実装)に隔離され、呼び出し元(`container-runner.ts` / `src/modules/approvals/onecli-approvals.ts`)は `getSecretProvider()` 経由で同一インスタンスを共有する。詳細は `onecli --help`。

### 落とし穴: 自動生成された agent は `selective` シークレットモードで起動する

host が新しい agent group のセッションを最初に spawn するとき、`container-runner.ts` の `buildContainerArgs` が `getSecretProvider().ensureAgent({ name, identifier })` を呼ぶ。OneCLI の `POST /api/agents` エンドポイントは agent を **`selective`** シークレットモードで作成する — つまり、vault にシークレットが存在しホストパターンが本来マッチするものでも、**デフォルトではこの agent にシークレットが割り当てられない**。

症状: コンテナが起動し、proxy と CA 証明書は正しく配線されているのに、vault に *実在する* クレデンシャルを使う API から `401 Unauthorized`(または類似)が返ってくる。クレデンシャルがこの agent の allow-list に入っていないだけである。

SDK は `setSecretMode` を公開していないが、OneCLI v1.30.0 の REST には `PATCH /v1/agents/:id/secret-mode {"mode":"all"}` が存在する。biblio-claw では `scripts/onecli-vertex-secret.sh` と `scripts/onecli-gh-secret.sh` がそれぞれ secret 投入のついでに全 agent を mode=all に昇格するため、`docker compose up -d --wait` 後に該当するスクリプトを 1 回流せば自動的に解消する。手動で個別調整したい場合は CLI(または Web UI `http://127.0.0.1:10254`)を使う:

```bash
# agent を探す (identifier は agent group id)
onecli agents list

# "all" に切り替えて、ホストパターンがマッチする vault 内のすべてのシークレットを注入する
onecli agents set-secret-mode --id <agent-id> --mode all

# あるいは selective のまま、特定のシークレットを割り当てる
onecli secrets list                                    # シークレット id を確認
onecli agents set-secrets --id <agent-id> --secret-ids <id1>,<id2>

# 現在 agent に割り当てられているものを確認する
onecli agents secrets --id <agent-id>                  # この agent に割り当てられたシークレット
onecli secrets list                                    # vault の全シークレット (ホストパターン付き)
```

`mode all` を有効化したばかりの場合、Bearer が未失効ならばコンテナの再起動は不要 — gateway はリクエストごとにシークレットをルックアップするので、稼働中のコンテナからの次の API 呼び出しで新しいクレデンシャルが見える。**ただし、既に 401 retry-loop に入っている agent コンテナは `pnpm run ncl groups restart --id <agent-group-id>` で clean restart が必要** — SDK 内部の認証状態がリクエストごとの lookup を超えて固着していることがあり、host 経由で kill + 再生成すると新しい Bearer で動く。Phase 1 Task 7-A (PR #4) で実測した知見。

### 落とし穴: OneCLI MITM が `tunnel` mode で素通しになる

OneCLI proxy (v1.30.0) は secret の `hostPattern` にマッチしない宛先 host を **`mode=tunnel`** で素通し転送する (= MITM しない)。tunnel 経路では client が本物の TLS cert を受信するため、`GIT_SSL_CAINFO` / `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS` に OneCLI CA だけを渡していると trust chain が完成せず SSL 検証で落ちる (典型症状: `git clone https://github.com/...` で `unable to get local issuer certificate`)。

biblio-claw は `src/biblio/host-proxy.ts:initHostProxy()` で **OneCLI CA + Node.js 組み込みの Mozilla root CA bundle (`tls.rootCertificates`)** を append した combined bundle を書き出すことで、MITM 経路 (= OneCLI 偽 cert) と tunnel 経路 (= 本物 cert chain) のどちらも trust 成立させる。詳細な切り分けデバッグ手順 (= `docker logs biblio-onecli | grep 'mode='` から始まる 3 ステップ) は `docs/operations-runbook.md` §「落とし穴: OneCLI MITM が `tunnel` mode で素通しになる」を参照。

### 設計原則: secret の `pathPattern` で injection 範囲を最小化

OneCLI secret は **`hostPattern` + `pathPattern` の 2 軸** で injection 対象を決定する (`pathPattern: null` = host 全パス inject = 最小権限原則違反)。biblio-claw では:

- **棚 / 司書本体** (`HajimariInc/biblio-{shelf,claw}`) への operation → `hostPattern=api.github.com` + `pathPattern=/repos/${SHELF_REPO_OWNER}/*` (= `.env` 由来で動的生成、既定 `HajimariInc`) で GH App auth inject
- **外部 public biblio の仕入れ** (`/repos/<外部>/*`) → path match 外で素通し、無認証で 200
- **private repo / 認証必要な外部 access が出てきたら DEN さん事前相談** (= 新規 hostPattern + pathPattern で別 secret を追加、scope を最小に保つ)

glob `*` は複数 segment マッチ (実機検証済、`/repos/HajimariInc/biblio-shelf/git/blobs` まで届く)。`scripts/onecli-gh-secret.sh` が POST 経路 (= 初回作成) でも PATCH 経路 (= token refresh) でも `pathPattern=/repos/${SHELF_REPO_OWNER}/*` を投入するため、新規 setup でも refresh 後でも `pathPattern` は effective に保たれる (= null = 全パス inject の罠なし)。OneCLI `PATCH /v1/secrets/<id>` の partial update では `value` + `pathPattern` 以外のフィールド (`hostPattern`, `injectionConfig` 等) は OneCLI 側で保持される (M2 PRD B Phase 3 PR #8 で設計確立、PR #10 で `scripts/onecli-gh-secret.sh` への永続化完了)。

### GH installation token (GitHub App Sidecar 経路)

司書 agent が `gh` で GitHub REST API に到達するための認可は、GitHub App PEM → RS256 JWT → installation access token を発行して OneCLI に投入する経路で行う。

- **Local (docker compose 経路)**: `scripts/onecli-gh-secret.sh` を host OS 上のシェルスクリプトとして実行する。PEM はローカルファイル (`GH_APP_PEM_PATH`、`*.pem` で gitignore 済) から読む。同スクリプトは `scripts/sign_jwt.cjs` (Node 組み込み crypto / 依存ゼロ) を内部で呼ぶため、両ファイルは常にペアで存在する必要がある。token 有効期限は **~60min** なので、期限切れ時に同スクリプトを再実行すると `PATCH /v1/secrets/:id` で `value` + `pathPattern` partial update (id 保持、200) される (= token と最小権限経路 pathPattern が同時更新)。
- **GKE 経路 (M2 PRD A Phase 3 以降)**: orchestrator Pod 内の `gh-token-rotator` Native sidecar (image `biblio-sidecar-gh:m2-p3`) が `scripts/gh-rotate.sh` (= `scripts/onecli-gh-secret.sh` を `ROTATE_INTERVAL_SEC=3000` (= 50min) の sleep loop で wrap) を実行し、自動再投入する。PEM は別の `fetch-pem` initContainer が WI 経由 (orchestrator KSA → `biblio-orchestrator` GSA, `roles/secretmanager.secretAccessor` on `biblio-gh-app-pem`) で Secret Manager から取得し、tmpfs emptyDir (`medium: Memory`) に書き出して rotator container に読み取り専用 mount する。旧 `k8s/30-sidecar-cronjob.yaml` (`biblio-sidecar` CronJob `*/30`) は本 Phase で **廃止** された。

```bash
# Local 経路 (docker compose):
# 前提: .env に GH_APP_ID / GH_INSTALLATION_ID / GH_APP_PEM_PATH / SHELF_REPO_OWNER を設定 + docker compose up -d --wait 済
bash scripts/onecli-gh-secret.sh
```

GKE 経路では DEN さんが追加コマンドを叩く必要はない (= `kubectl apply -f k8s/` 後、orchestrator Pod が起動した時点で sidecar が動き始める)。あわせて `set_all_agents_mode_all` で全 agent を mode=all に昇格する処理も rotator script 内で走るため、初回 agent spawn 後の再注入も自動で完了する。

**動作確認の注意**: `api.github.com` の public repo (`/repos/owner/repo`) は無認証でも `200 + repo メタ` を返すため、Authorization 注入の効果検証には rate limit ヘッダ (`X-RateLimit-Limit: 5000` = authenticated) を見るか、private repo か、authenticated 必須エンドポイント (例: `/installation/repositories`) を probe する必要がある。同様に「token 未注入で 401」確認も public repo では成立しない (無認証でも 200 を返すため、Authorization ヘッダの有無で応答が変わらない)。

### OneCLI proxy CA bundle 投入 (GKE 経路、M2 PRD A Phase 3 以降)

GKE Autopilot Warden が `autogke-no-write-mode-hostpath` で agent Pod の hostPath mount を全 deny するため、OneCLI が agent コンテナに渡したい proxy CA bundle (`/tmp/onecli-{proxy,combined}-ca.pem`) を hostPath 経由で注入できない。

Phase 3 以降は **orchestrator Pod 内の `onecli` Native sidecar が emptyDir 経由で CA bundle を生成 → 同 Pod 内 orchestrator container 上の `ca-secret-sync` が起動時 + 60s sweep で K8s Secret `biblio-onecli-ca` に自動 upsert** する経路に切り替わった。agent Pod は引き続き Secret から `/etc/ssl/certs/onecli/` に mount される (`K8sJobContainerRuntimeProvider.translateSpec` の Secret mount + env rewrite ロジックは温存)。

DEN さんが手動で `kubectl create secret` する手順は不要 (= Phase 2.5 までの手動投入 doc は Phase 3 で廃止済み)。

ロジックの所在:
- emptyDir 共有: `k8s/10-orchestrator-statefulset.yaml` の `volumes.onecli-ca` (OneCLI sidecar: `/app/data/gateway` / orchestrator: `/etc/ssl/certs/onecli` readOnly)
- 自動 upsert ループ: `src/sidecar/ca-secret-sync.ts` (起動 + 60s 周期、ENOENT は silent retry + 5min ごとに warn 再発火)
- agent Pod 用 Secret mount: `K8sJobContainerRuntimeProvider.translateSpec` の OneCLI CA Secret volume / volumeMount (`src/adapters/container/k8s.ts`、温存)

### GKE 側 OneCLI への secret 投入時の `.env` 上書き罠 (ローカル経路のみ)

> Phase 3 以降、GKE 側の secret 投入は orchestrator Pod 内の sidecar (gh-token-rotator / vertex-token-rotator) が自動で行うため、**GKE 経路では本罠は発生しない**。以下はあくまで **ローカル開発で `scripts/onecli-{vertex,gh}-secret.sh` を host 端末から GKE 側に直接投入したいケース** (debug や緊急復旧) に限定した補足。

`scripts/onecli-vertex-secret.sh` および `scripts/onecli-gh-secret.sh` はスクリプト冒頭で `.env` を `set -a; . .env; set +a` で読み込むため、`.env` に `ONECLI_URL=http://localhost:10254` (= ローカル docker compose 用) があると、外部から `ONECLI_URL=...` を渡しても上書きされ、**ローカル OneCLI に投入されて GKE 側 OneCLI には届かない**。Phase 2.5 実機検証で踏んだ罠。

GKE 側 OneCLI に直接投入する手順 (debug 用途):

```bash
# 別 terminal で port-forward (port 衝突回避でローカル側を 20254 に)
kubectl port-forward svc/biblio-onecli -n biblio-claw 20254:10254

# ADC token を取って GKE 側 OneCLI に直接 POST (jq 不要、token は stdin で渡す)
ADC="$(gcloud auth application-default print-access-token)"
PAYLOAD="$(printf '{"name":"biblio-claw-vertex","type":"generic","hostPattern":"aiplatform.googleapis.com","injectionConfig":{"headerName":"authorization","valueFormat":"Bearer {value}"},"value":"%s"}' "$ADC")"
unset ADC
echo "$PAYLOAD" | curl -fsS -X POST -H 'Content-Type: application/json' --data-binary @- http://localhost:20254/v1/secrets
```

orchestrator pod 内から見える `/v1/agents` は **API 経由でローカル OneCLI を叩いたときと別の view** (auth context が違う) になる。「どの agent が登録されているか」確認するときは必ず orchestrator pod 内から `fetch($ONECLI_URL/v1/agents)` を叩く:

```bash
kubectl exec biblio-orchestrator-0 -c orchestrator -n biblio-claw -- node -e "
fetch(process.env.ONECLI_URL + '/v1/agents').then(r => r.json()).then(d => {
  console.log('count=', d.length);
  for (const a of d) console.log(a.accessToken.slice(0,20), a.identifier, a.name, 'mode='+a.secretMode);
});"
```

### クレデンシャル使用時の承認要求

認証付きアクションの承認制御は **両側** のフローである:

- **サーバ側**(OneCLI gateway): いつリクエストを保留して pending な承認を発行するかを決定する。`onecli@1.3.0` 時点では、CLI からこれを公開していない — `rules create --action` は `block` と `rate_limit` のみ受け付け、`secrets create` には承認用のフラグがない。承認ポリシーは OneCLI の Web UI `http://127.0.0.1:10254` 経由で設定する必要がある。将来 CLI に `approve` アクションが追加されたら、本セクションは更新が必要。
- **host 側**(nanoclaw): pending な承認を受け取り、人間へ振り分ける。`src/modules/approvals/onecli-approvals.ts` が `getSecretProvider().configureManualApproval(cb)` 経由でコールバックを登録する(`GET /api/approvals/pending` を long-poll)。コールバックは `src/modules/approvals/primitive.ts` の `pickApprover` + `pickApprovalDelivery` を使って approver に DM する。approver は `user_roles` テーブルから解決される — 優先順位: agent group に対する scoped admin → global admin → owner。`NANOCLAW_ADMIN_USER_IDS` のような env var は存在しない。role は central DB にのみ永続化される。

サーバ側で承認が設定されているのに host 側のコールバックが走っていない(または例外を投げる)場合、認証付き呼び出しはすべて gateway がタイムアウトするまでハングする。逆に、gateway に承認を要求するルールがなければ、配線がどうであっても host 側のコールバックは発火しない。

## スキル

skill は 4 種類ある。完全な分類は [CONTRIBUTING.md](CONTRIBUTING.md) を参照。

- **Channel/provider インストール skill** — `channels` または `providers` ブランチから関連モジュールをコピー、import を配線、pin した依存をインストール(例: `/add-discord`、`/add-slack`、`/add-whatsapp`、`/add-opencode`)。
- **ユーティリティ skill** — `SKILL.md` と一緒にコードファイルを同梱する(例: `/claw`)。
- **オペレーション skill** — 命令文だけのワークフロー(`/setup`、`/debug`、`/customize`、`/init-first-agent`、`/manage-channels`、`/init-onecli`、`/update-nanoclaw`)。
- **コンテナ skill** — 実行時に agent コンテナ内へロードされる(`container/skills/`: `onecli-gateway`、`welcome`、`self-customize`、`agent-browser`、`slack-formatting`)。

| Skill | 用途 |
|-------|-------------|
| `/setup` | 初回インストール、認証、サービス設定 |
| `/init-first-agent` | 最初の DM 配線済 agent をブートストラップ(channel 選択 → identity → 配線 → ウェルカム DM) |
| `/manage-channels` | channel と agent group を分離レベルの判断付きで配線 |
| `/customize` | channel 追加、統合、振る舞いの変更 |
| `/debug` | コンテナの問題、ログ、トラブルシューティング |
| `/update-nanoclaw` | カスタマイズ済みのインストールに上流の更新を取り込む |
| `/init-onecli` | OneCLI Agent Vault のインストールと `.env` クレデンシャルの移行 |

## 貢献ガイド

PR の作成、skill の追加、その他コントリビューションの準備をする前に、必ず [CONTRIBUTING.md](CONTRIBUTING.md) を読むこと。受け付ける変更の種類、skill 4 種類とそれぞれのガイドライン、`SKILL.md` のフォーマット規則、提出前チェックリストを扱っている。

## PR 衛生

PR を作る前に、次のチェックを実行すること:

```bash
git diff upstream/main --stat HEAD
git log upstream/main..HEAD --oneline
```

出力を提示して承認を待つこと。インストール固有のファイル(group ファイル、.claude/settings.json、ローカル設定)は含めてはならない。

## 開発

コマンドは直接実行する — ユーザーに「これを実行してください」とは伝えない。

```bash
# host (Node + pnpm)
pnpm run dev          # ホットリロード付きで host を起動
pnpm run build        # host の TypeScript (src/) をコンパイル
./container/build.sh  # agent コンテナイメージ (nanoclaw-agent:latest) を再ビルド
pnpm test             # host のテスト (vitest)

# agent-runner (Bun — container/agent-runner/ 配下の独立パッケージツリー)
cd container/agent-runner && bun install   # agent-runner の依存を編集したあと
cd container/agent-runner && bun test      # コンテナのテスト (bun:test)
```

コンテナ側の型チェックは別の tsconfig を持つ — `container/agent-runner/src/` を編集した場合、ルートから `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` を実行する(または `container/agent-runner/` から `bun run typecheck`)。

サービス管理:
```bash
# macOS (launchd)
launchctl load   ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # 再起動

# Linux (systemd)
systemctl --user start|stop|restart nanoclaw
```

## トラブルシューティング

何か問題が起きたら、まず次を確認する:

| 何 | どこ |
|------|-------|
| host ログ | まず `logs/nanoclaw.error.log`(配信失敗、crash-loop backoff、警告)、次に `logs/nanoclaw.log`(ルーティングチェイン全体) |
| セットアップログ | `logs/setup.log`(全体)、`logs/setup-steps/*.log`(ステップ別: bootstrap、environment、container、onecli、mounts、service など) |
| セッション DB | `data/v2-sessions/<agent-group>/<session>/` — `inbound.db`(`messages_in`: メッセージはコンテナに届いたか?)、`outbound.db`(`messages_out`: agent はレスポンスを生成したか?) |

注意: コンテナログはコンテナ終了後に失われる(`--rm` フラグ)。**ただし Docker (local) 経路では exit !=0 / signal 終了時の直近 64 KiB stderr が host ログ (`logs/nanoclaw.error.log`) に warn として残る** (`src/adapters/container/docker.ts` の `DockerAgentHandle` が stderr buffer + exit 経路で吐く、M3 Phase 5 で追加)。`LOG_LEVEL=debug` で line-by-line tail も得られる。K8s Job 経路では引き続き container 内ログは消える (= 別途 `kubectl logs` で live 取得が必要)。kill 経由の non-zero 終了 (= 通常運用) は warn 対象外。

## サプライチェーンセキュリティ (pnpm)

本プロジェクトは `pnpm-workspace.yaml` の `minimumReleaseAge: 4320`(3 日)を伴った pnpm を使う。新しいパッケージバージョンは npm レジストリに 3 日以上存在しないと pnpm が解決しない。

**ルール — 明示的な人間の承認なしにバイパスしないこと:**
- **`minimumReleaseAgeExclude`**: 人間のサインオフなしにエントリを追加しない。release age ゲートをバイパスする必要がある場合、人間が承認し、エントリは除外対象の正確なバージョン(例: `package@1.2.3`)を pin すること。決して範囲指定しない。
- **`onlyBuiltDependencies`**: 人間の承認なしにパッケージを追加しない — ビルドスクリプトはインストール時に任意のコードを実行する。
- **`pnpm install --frozen-lockfile`** を CI、自動化、コンテナビルドで使うこと。これらのコンテキストで生の `pnpm install` を実行しないこと。

## ドキュメント索引

| Doc | 役割 |
|-----|---------|
| [docs/architecture.md](docs/architecture.md) | アーキテクチャの完全版 |
| [docs/api-details.md](docs/api-details.md) | host API + DB スキーマの詳細 |
| [docs/db.md](docs/db.md) | DB アーキテクチャ概要: three-DB モデル、クロスマウントルール、reader/writer マップ |
| [docs/db-central.md](docs/db-central.md) | Central DB(`data/v2.db`)— 全テーブル + マイグレーションシステム |
| [docs/db-session.md](docs/db-session.md) | セッションごとの `inbound.db` + `outbound.db` のスキーマ + seq の偶奇規約 |
| [docs/agent-runner-details.md](docs/agent-runner-details.md) | agent-runner の内部 + MCP ツールインターフェース |
| [docs/isolation-model.md](docs/isolation-model.md) | 3 レベルの channel 分離モデル |
| [docs/setup-wiring.md](docs/setup-wiring.md) | セットアップフローで何が配線され、何が開いたままか |
| [docs/architecture-diagram.md](docs/architecture-diagram.md) | アーキテクチャの図版 |
| [docs/build-and-runtime.md](docs/build-and-runtime.md) | ランタイムの分割(Node host + Bun container)、lockfile、イメージビルド表面、CI、主要な不変条件 |
| [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md) | v1→v2 のアーキテクチャ差分 — v1 のものが v2 のどこへ移ったかの語彙 |
| [docs/migration-dev.md](docs/migration-dev.md) | マイグレーション開発ガイド — テスト、デバッグ、開発ループ |
| [docs/operations-runbook.md](docs/operations-runbook.md) | **biblio-claw 運用早見表** (local / GCP)。orchestrator / agent / OneCLI の起動・ログ所在・M2/M3 verify 前提セットアップ表 + OneCLI tunnel 罠の対処 + §GKE リセット手順 (部分 reset / 完全 teardown + 再構築 + Cloud SQL Bootstrap GRANT) + /init-project / /init-project-gcp サブコマンドカタログ |
| [docs/equip-physical.md](docs/equip-physical.md) | 装備機構の物理配置規約 / mount トポロジ / Docker+K8s 両 runtime 透過の仕組み / spawn-time install lifecycle / Phase 1-3 完了 (物理配置 + 自律呼び出し + 禁書/焼却) + Phase 5 完了 (m3-verify で消化済) + Phase 3.5 申し送り (M3 全体) |
| [docs/slack-environments-setup.md](docs/slack-environments-setup.md) | Slack 2 環境分離 (GCP=本番 ws / local=開発 ws) の App セットアップ手順 |

## コンテナビルドキャッシュ

コンテナの buildkit はビルドコンテキストを強くキャッシュする。`--no-cache` 単独では COPY ステップを無効化しない — builder のボリュームが stale なファイルを保持する。本当に綺麗な再ビルドを強制するには、builder を prune したうえで `./container/build.sh` を再実行する。

## コンテナランタイム (Bun)

agent コンテナは **Bun** 上で動き、host は **Node**(pnpm)上で動く。両者の通信はセッション DB のみ — 共有モジュールはない。詳細と根拠: [docs/build-and-runtime.md](docs/build-and-runtime.md)。

**落とし穴 — トリガーとアクション:**

- **`container/agent-runner/` のランタイム依存を追加またはバンプする** → `package.json` を編集し、`cd container/agent-runner && bun install` を実行して更新された `bun.lock` をコミットする。ここで `pnpm install` を実行しないこと — agent-runner は pnpm workspace ではない。
- **`@anthropic-ai/claude-agent-sdk`、`@modelcontextprotocol/sdk`、その他 agent-runner のランタイム依存をバンプする** → このツリーには `minimumReleaseAge` ポリシーは適用されない。npm 上のリリース日を確認し、意図的に pin し、決して `bun update` を盲目的に実行しないこと。
- **コンテナで新しい named パラメータの SQL insert/update を書く** → SQL と JS キーの両方で `$name` を使う: `.run({ $id: msg.id })`。`bun:sqlite` は host 側の `better-sqlite3` のようにプレフィックスを自動で剥がさない。位置パラメータ `?` は通常通り動く。
- **`container/agent-runner/src/` にテストを追加する** → `vitest` ではなく `bun:test` から import する。Vitest は Node 上で動き、`bun:sqlite` をロードできない。`vitest.config.ts` はこのツリーを除外している。
- **agent がランタイムで呼び出す Node CLI を追加する**(`agent-browser`、`claude-code`、`vercel` のようなもの) → Dockerfile の pnpm グローバルインストールブロックに置き、新しい `ARG` で exact バージョンに pin する。`bun install -g` は使わない — それは pnpm の supply-chain ポリシーをバイパスする。
- **Dockerfile の entrypoint または動的 spawn コマンドを変更する**(spawn 機構は `src/adapters/container/{docker,k8s}.ts`、agent の起動コマンド文字列は `src/container-runner.ts` の `command: ['-c', '/app/install-biblios.sh && exec bun run ...']` 付近)→ `exec bun ...` を維持してシグナルがクリーンに転送されるようにする。spawn コマンドは M3 Phase 2 から `container/install-biblios.sh` (= `/app/install-biblios.sh`、Dockerfile で COPY + chmod 755) を bun の前に挟む形になった — 装備リスト loop の wrapper script で、装備 0 件なら早期 exit で no-op。command を変更するときは wrapper の前置を保つこと (= 装備機構が壊れる)。イメージには `/app/dist` がない。tsc ビルドステップを再導入しないこと。
- **セッション DB の pragma を変更する**(`container/agent-runner/src/db/connection.ts`)→ `journal_mode=DELETE` はクロスマウント可視性に必須である。先頭のコメントブロックを先に読むこと。

## CJK フォントサポート

agent コンテナはデフォルトで CJK フォントを同梱しない(~200MB の節約)。ユーザーが中国語/日本語/韓国語のコンテンツを扱う兆候 — CJK で会話している、CJK タイムゾーン(例: `Asia/Tokyo`、`Asia/Shanghai`、`Asia/Seoul`、`Asia/Taipei`、`Asia/Hong_Kong`)、システムロケールのヒント、スクリーンショット / PDF / スクレイプ済みページで CJK をレンダリングする必要があるとの言及 — に気づいた場合、有効化を提案する:

```bash
# .env に INSTALL_CJK_FONTS=true があることを保証する (上書き or 追記)
grep -q '^INSTALL_CJK_FONTS=' .env && sed -i.bak 's/^INSTALL_CJK_FONTS=.*/INSTALL_CJK_FONTS=true/' .env && rm -f .env.bak || echo 'INSTALL_CJK_FONTS=true' >> .env

# 新しいセッションが新しいイメージを拾うように、再ビルドして再起動する
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
```

`container/build.sh` は `.env` から `INSTALL_CJK_FONTS` を読み、Docker のビルド引数として渡す。CJK フォントがないと、Chromium がレンダリングするスクリーンショットと PDF に含まれる CJK テキストは tofu(空の四角形)として表示される。
