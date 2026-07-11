# biblio-claw セキュリティモデル

biblio-claw は NanoClaw v2 (`nanocoai/nanoclaw` @ `2492259`) を base fork とする司書 agent 実装。本ドキュメントは biblio-claw の実装に即したトラストモデルとセキュリティ境界を扱う。運用ノウハウの詳細は [`docs/operations-runbook.md`](operations-runbook.md) に分担する。

Vulnerability の報告経路は repo ルートの [`SECURITY.md`](../SECURITY.md) を参照。

## トラストモデル

信頼判定は **user レベル**で行い、group レベルでは行わない。実装は `src/modules/permissions/access.ts:canAccessAgentGroup` に集約されており、以下 5 段の判定順で解決する:

| 権限 | 判定 | 根拠 |
|---|---|---|
| owner | `users.role = 'owner'` | 全 agent group / messaging group を横断 |
| global admin | `user_roles.role = 'admin' AND agent_group_id IS NULL` | 全 agent group 管理可 |
| scoped admin | `user_roles.role = 'admin' AND agent_group_id = <id>` | 対象 agent group 内のみ管理可 |
| member | `agent_group_members` に登録あり | 対象 agent group への read + 自 session への send |
| not_member | いずれにも該当せず | 拒否 |

権限テーブルは central DB (`data/v2.db`) の `users` / `user_roles` / `agent_group_members` に永続化される。環境変数による admin 指定 (`NANOCLAW_ADMIN_USER_IDS` 等) は**存在しない**。

エンティティモデルと分離 3 レベル (agent-shared / shared / 個別 agent) の詳細は [`docs/isolation-model.md`](isolation-model.md) を参照。

## セキュリティ境界

biblio-claw は agent group の `container_configs.provider` により **3 つの異なる実行経路**を持ち、それぞれ trust boundary の張り方が異なる。

### 1. コンテナ分離 (`provider = 'claude'` / `'hybrid'` / provider 未指定経路)

Bun ベースの agent-runner を独立コンテナで動かす経路。**biblio-claw の主要境界**。

**Docker (local docker compose):**
- `--rm` エフェメラルコンテナ (`src/adapters/container/docker.ts`)
- base image = `node:22-slim` (Debian slim、distroless ではない。apt/curl/bash/tini/chromium を搭載)
- `USER node` (uid 1000) 非特権実行 (`container/Dockerfile`)
- プロセス / ファイルシステム / ネットワーク名前空間分離

**K8s Job (GKE Autopilot):**
- `restartPolicy: Never` + `ttlSecondsAfterFinished: 120` + `backoffLimit: 0` でエフェメラル相当 (`src/adapters/container/k8s.ts`)
- `securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } }`
- 非 root 実行は image の `USER node` default に依存 (K8s Job spec レベルの `runAsNonRoot`/`runAsUser` は明示指定なし)
- `securityContext.fsGroup: 1000` で PVC 所有権を agent user に寄せる

**GKE Autopilot Warden 制約への対処:**
- Warden `autogke-no-write-mode-hostpath` が agent Pod の hostPath mount を全 deny する制約に対して、agent Pod の mount は orchestrator RWO PVC の subPath 経由に変換する (`k8s.ts` の translateSpec)
- OneCLI proxy CA bundle は hostPath ではなく K8s Secret (`biblio-onecli-ca`) + emptyDir 経由。orchestrator Pod 内の `ca-secret-sync.ts` が 60s 周期で Secret を自動 upsert する

### 2. ADK in-process 経路 (`provider = 'adk'`)

**この経路はコンテナを spawn しない**。host プロセス内で `src/adk/dispatcher.ts` の in-process `LlmAgent` + `Runner` が tool 実行する (`src/router.ts` が provider 判定でセッション / コンテナ経路をスキップする)。

コンテナ FS 分離が効かない代わりに、以下のガードを積む:

- **tool allowlist**: `src/adk/root-agent.ts` の `tools` 配列に載せた `FunctionTool` (9 種) のみ発火可能。任意 shell / 任意 fs アクセスは不能
- **入力検証**: 破壊操作 tool (enkin/shokyaku) と外部入力を受ける tool (acquire/inspect/shelve) は `BIBLIO_NAME_RE` guard で fail-closed (後述 § 入力検証)
- **HITL 承認**: 破壊操作 tool は adk-js@1.3.0 の `Context.requestConfirmation` API 経由で人間 approver に承認カードを配信 (後述 § 破壊操作の HITL 承認)
- **外部 HTTP は OneCLI proxy 経由**: `src/biblio/host-proxy.ts` の bootstrap で `HTTPS_PROXY` + combined CA bundle を host プロセスに inject。実クレデンシャルは OneCLI vault が保持する (後述 § クレデンシャル分離)

**トレードオフ**: コンテナ分離は失うが、実行速度 (container spawn cost 削減) と観測性 (span 直接発火) を得る。破壊操作の権限昇格は tool allowlist + HITL の 2 重ガードで抑える。

### 3. Fugue HTTP endpoint (外部公開)

姉妹プロジェクト Fugue 連携用の HTTP endpoint。`src/channels/fugue-http.ts` の独立 `http.createServer` (Slack Chat SDK bridge とは別の入口) で、以下の認可層を積む:

- **Bearer 認証** (`Authorization: Bearer <shared-token>`): Secret Manager `fugue-shared-token` を timing-safe compare で検証
- **Rate limit** (`src/channels/fugue-rate-limit.ts`): 自前 sliding window、上限超過で `429 + Retry-After`。consult / equip は構造的 bypass、ask endpoint に適用
- **`BIBLIO_NAME_RE` guard**: equip / ask 経路で `<owner>--<repo>` 形式必須、不一致は `schema_invalid` で REJECT
- **HITL 政策関数** (`src/biblio/hitl-policy.ts`): Fugue equip 経路で `requiresApproval(operation, channel)` を defensive gate として呼び、承認必須操作は `fugue.outcome='hitl_required'` で応答
- **Intent gate 4 層** (ask endpoint、Phase 2): intent hint / `INTENT_GATE_MISMATCH` warnings / in-secure denial / rate limit

Fugue channel は Slack と異なり同期 request-response 型で、`outbound.db` 経路を使わない。`deliver` は throw で silent no-op を撲滅する。

### 4. Slack channel (Chat SDK bridge 経路)

`src/channels/slack.ts` の Chat SDK bridge 経由の非同期双方向。trigger は `messaging_group_agents` (agent group ↔ messaging group wire) で解決し、`session_mode` で per-thread / shared を制御する。

権限判定はメッセージ受信時に `command-gate.ts` が `user_roles` を直接クエリして admin コマンドを gate する。env var なし、コンテナ側の再チェックなし。

## マウントセキュリティ

### 外部 allowlist (v2 でも稼働)

`~/.config/nanoclaw/mount-allowlist.json` (プロジェクトルート**外側**、コンテナには決してマウントされない、agent には変更不能) が任意追加マウントの正本。実装は `src/modules/mount-security/index.ts`、参照経路は `src/container-runner.ts:validateAdditionalMounts` (agent group の `containerConfig.additionalMounts` に対して事前検証)。

**デフォルトブロックパターン** (`mount-security/index.ts:DEFAULT_BLOCKED_PATTERNS`):

```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret, .gpg, .pypirc
```

**保護策:**
- 検証前に symlink を実パスに解決 (`getRealPath`、traversal 攻撃を防ぐ)
- コンテナパス検証 (`isValidContainerPath`、`..` と絶対パスを拒否)
- `nonMainReadOnly` オプションで read-only 強制 (指定時)

### 固定 mount (buildMounts)

`src/container-runner.ts:buildMounts` が組む固定 mount 一覧 (session ディレクトリ / group フォルダ / `.claude-shared` / 装備済み biblio) は allowlist の適用対象外。固定 mount は agent group ごとの spec に基づき、host / K8s runtime が subPath 変換して agent Pod に投入する。

### 装備 biblio の物理配置

装備済み biblio は `session_equipped_biblios` テーブルから DB lookup し、per-biblio readonly subPath mount として buildMounts 末尾に append される。詳細は [`docs/equip-physical.md`](equip-physical.md) を参照。

## セッション分離

各セッションは `data/v2-sessions/<agent_group_id>/<session_id>/` に 2 つの SQLite ファイルを持つ:

- **`inbound.db`** — host が書き、コンテナが読む (`messages_in`, ルーティング, destinations, pending_questions, processing_ack)
- **`outbound.db`** — コンテナが書き、host が読む (`messages_out`, session_state)

writer は各ファイルにつき厳密 1 プロセス。host は偶数の `seq`、コンテナは奇数の `seq` を使う契約でクロスマウントのロック競合を避ける。Heartbeat は `/workspace/.heartbeat` の touch で表現し、DB 更新ではない。

分離軸は `agent_group_id × messaging_group_id × thread_id × session_mode` の複合軸。`session_mode = 'agent-shared'` では複数 messaging_group が 1 session に収束し、意図的に「他 group の履歴を見える」構成を取れる。詳細は [`docs/db-session.md`](db-session.md) を参照。

## IPC 認可 / 管理 CLI (`ncl`)

`ncl` (`src/cli/dispatch.ts`) は central DB を照会・変更する管理 CLI。コンテナ内から呼ぶ場合は agent group ごとの `cli_scope` で制御する:

| `cli_scope` | 振る舞い |
|---|---|
| `disabled` | agent は ncl の存在を知らない (CLAUDE.md からも除外)。host のディスパッチはあらゆる `cli_request` を拒否 |
| `group` (デフォルト) | `groups` / `sessions` / `destinations` / `members` のみアクセス可、自 agent group に scope 限定。`--id` は自動補完、クロスグループアクセスは拒否、`cli_scope` 自体の変更は禁止 (権限昇格防止) |
| `global` | 制限なし。`init-first-agent` 経由で owner agent group にのみ自動設定 |

`group` scope の agent group 越境防止は `--id` 強制上書き + post-handler フィルタ (`scopeField` ベース) の二重防御。

**host-only debug 経路:**
- `ncl messages send` は他 messaging_group への発話を注入する host-only verb。`ctx.caller !== 'host'` を明示 `forbidden` で拒否 (`dispatch.ts`)
- `--stub-outbound` フラグで実 channel deliver を silent skip する verify 用契約 (`src/delivery.ts` の `stubOutboundTargets` Set)

## クレデンシャル分離 (OneCLI Agent Vault)

> **keyless 認証の全体像** (Workload Identity Federation + Sidecar token rotator 3 系統 + GitHub App PEM → installation token フロー) は [`vertex-claude-keyless.md`](vertex-claude-keyless.md) を参照。本節では OneCLI Vault との組み合わせと運用の罠に絞る。

API キー / OAuth token / GH App installation token / Vertex ADC token などの実クレデンシャルは **agent コンテナに入らない**。OneCLI gateway がリクエスト時に host / パスマッチで injection する:

1. クレデンシャルは `onecli secrets create` で登録され、OneCLI が保持・管理する
2. Host がコンテナを spawn するとき `applyContainerSecrets` (`src/adapters/secret/onecli.ts`) を呼び、agent の outbound HTTPS を OneCLI gateway 経由にする
3. Gateway はリクエストの `hostPattern` にマッチする secret があれば実クレデンシャルを注入して forward
4. Agent は実クレデンシャルを発見できない — env var にも stdin にも fs にも `/proc` にも無い

**Agent ごとのポリシー:**
各 agent group は独自の OneCLI agent identity を持つ (`ensureAgent`)。これによりグループ横断でクレデンシャルポリシーを分離できる。

### 承認フロー (実装済)

認証付きアクションの承認は **サーバ側 (OneCLI gateway) + host 側 (biblio-claw) の両側フロー**。両方とも実装済:

- **OneCLI gateway 側**: 承認要求ルールを Web UI (`http://127.0.0.1:10254`) 経由で設定。CLI 経路は `onecli@1.30.0` 時点で `approve` action 未公開のため Web UI 必須
- **biblio-claw 側**: `src/modules/approvals/onecli-approvals.ts` が `configureManualApproval(cb)` で gateway の `GET /api/approvals/pending` を long-poll し、pending 検知時に `src/modules/approvals/primitive.ts` の `pickApprover` + `pickApprovalDelivery` で approver に DM 配信する
- **approver 解決**: `user_roles` を優先順位 (対象 agent group の scoped admin → global admin → owner) で解決

### 運用上の罠 (詳細は runbook 誘導)

以下 3 点は「クレデンシャルはコンテナに入らない」前提を成立させるための実運用条件。ここには要点のみ記し、切り分け手順と実装詳細は [`docs/operations-runbook.md`](operations-runbook.md) を参照:

- **新規 agent は `selective` mode で起動** → `mode=all` への PATCH 昇格が必要。`OneCLISecretProvider.ensureAgent` が spawn 直後に自動昇格するが、失敗時は `scripts/onecli-{vertex,gh}-secret.sh` の safety net + 手動 fallback (`onecli agents set-secret-mode --mode all`)
- **OneCLI MITM が `tunnel` mode で素通し** → hostPattern 不一致宛先は MITM されず本物 TLS cert が client に届く。`src/biblio/host-proxy.ts:initHostProxy` が **OneCLI CA + Node.js 組み込み Mozilla root CA bundle** を append した combined bundle を書き出し、MITM 経路と tunnel 経路の両方で trust 成立させる。Go バイナリ (gh CLI 等) は `SSL_CERT_FILE=/etc/ssl/certs/onecli/onecli-combined-ca.pem` を尊重
- **secret は `pathPattern` を省略必須** → GKE 環境で `pathPattern` を string 明示すると MITM Authorization injection logic が skip される既知障害。`scripts/onecli-gh-secret.sh` は POST / PATCH 経路で pathPattern を送らない

## 破壊操作の HITL 承認 (biblio-claw 独自)

以下の破壊 / 特権操作は **管理者 (admin/owner) の承認**を経由する:

| 操作 | tool 名 | 経路 | 承認 handler |
|---|---|---|---|
| 禁書 (装備解除、装備源残置 = 再装備可) | `enkin_biblio` | ADK + delivery action 両経路 | `src/adk/tools/enkin-tool.ts` + `src/biblio/enkin-action.ts` |
| 焼却 (装備源含む物理削除) | `shokyaku_biblio` | ADK + delivery action 両経路 | `src/adk/tools/shokyaku-tool.ts` + `src/biblio/shokyaku-action.ts` |
| 設定変更 (allowlist 動的変更) | `update_config` | ADK + delivery action 両経路 | `src/biblio/config-action.ts` (admin check + allowlist 強制) |
| OneCLI 認証付きアクション | (gateway 経由) | gateway pending → biblio-claw dispatch | `src/modules/approvals/onecli-approvals.ts` |

**ADK 経路の HITL 実装** (`src/adk/dispatcher.ts` + `src/modules/approvals/adk-approvals.ts`):

1. tool 側の `execute` で adk-js@1.3.0 の `requestConfirmation({hint, payload})` を呼ぶ (初回)
2. Runner が session を保持したまま pause、dispatcher が `functionCall.name === 'adk_request_confirmation'` を検知して `requestAdkApproval` を呼び承認カードを Slack DM に配信
3. Approver の応答で `resolveAdkApproval(payload, selectedOption)` が resume 経路を発火し、`runner.runAsync({sessionId, newMessage: {functionResponse: {..., response: {confirmed}}}})` で session を再開
4. Pod 再起動などで session が消失した場合は「失効」通知を patron に配信

**Delivery action 経路の HITL** (`src/biblio/{enkin,shokyaku}-action.ts`) は Slack ボタン応答で `pending_approvals` row を解決する古典的な request/response 経路。

## 入力検証 (`BIBLIO_NAME_RE` guard)

biblio 名 (`<owner>--<repo>` 形式) を受け取る全経路で fail-closed の正規表現 guard を通す。実装は `src/biblio/action-helpers.ts:BIBLIO_NAME_RE`:

- **適用箇所**: 仕入れ / 検品 / カテゴライズ / 陳列 / 禁書 / 焼却 / Fugue equip / Fugue ask + ADK tool 側の execute 冒頭 + delivery action handler 側
- **効果**: path-traversal (`../`)、shell injection 材料 (`;`, `|`, backtick 等)、コロン / スラッシュ経由の外部プロジェクト誤参照を構造的にブロック
- **失敗時挙動**: `schema_invalid` REJECT で silent failure 撲滅 (throw ではなく writeBack + reason で patron に理由通知)

CLI / Slack / Fugue / ADK の 4 経路すべてで LLM 自律呼出が本番化しているため、guard は tool 側と action 側の**両方**に置き重複防御を成す。

## 監査 (Cloud Logging → BigQuery sink)

biblio 各 action は OpenTelemetry span を発火し、Cloud Logging → BigQuery sink 経由で BigQuery dataset `llm_observability` に落ちる。各 span には `biblio.action` / `biblio.request_id` / `biblio.session_id` / `biblio.outcome` + `gen_ai.*` (LLM 呼出) 属性が付き、承認経路 (`adk.approval.dispatch.*`) や Fugue channel 経路 (`fugue.outcome`, `channel='fugue'`) も同 sink に落ちる。

これは security 目的の tamper-evident audit log ではなく、observability / 運用診断が主目的。厳密な audit trail が必要な場合は別途 sink 分離を検討。詳細は [`terraform/m4-a-observability/`](../terraform/m4-a-observability/) と `docs/operations-runbook.md` を参照。

## サプライチェーンセキュリティ

### pnpm workspace (host tree)

`pnpm-workspace.yaml` に 2 つの防御:

**Minimum Release Age (`minimumReleaseAge: 4320` = 3 日):**
pnpm は公開から 3 日未満の npm パッケージバージョンを解決しない。typosquatting と侵害されたメンテナアカウントへの防御 (悪意ある公開の多くは 72 時間以内に検出・取り下げ)。

**除外は例外扱い** (`minimumReleaseAgeExclude`):

zero-day fix や重要な依存が即時更新を要する場合:

1. 除外は人間のメンテナがレビュー / 承認すること
2. エントリは **正確なバージョン** を pin する — 範囲やワイルドカードは不可
   ```yaml
   minimumReleaseAgeExclude:
     some-package: "1.2.3"  # @user が承認、2026-04-14 — CVE-XXXX-YYYY 修正
   ```
3. バージョンが閾値 (3 日) を超えたら除外を取り除く
4. 自動 agent (Claude Code、CI bot) は人間のサインオフ無しに除外を追加しない

**Build スクリプト allowlist (`onlyBuiltDependencies`):**
どのパッケージが `install` / `postinstall` スクリプトを実行できるかを制限する。現在許可されているもの:

- `better-sqlite3` — ネイティブ SQLite バインディングをコンパイル
- `esbuild` — プラットフォーム固有バイナリをダウンロード
- `protobufjs` — protobuf バインディングを生成
- `sharp` — プラットフォーム固有画像処理バイナリをダウンロード

このリストへの追加は人間の承認が必要 — build スクリプトはインストールユーザの権限で任意コードを実行できる。

**`.npmrc` セーフティネット:**
`.npmrc` は fallback として `minReleaseAge=3d` を含む。正本は `pnpm-workspace.yaml` だが、`.npmrc` は npm が直接呼ばれた場合 (pnpm を尊重しないツール) の defense-in-depth を提供する。

**CI / 自動化での install:**
CI / 自動化 / コンテナビルドでは `pnpm install --frozen-lockfile` を使う。生の `pnpm install` は禁止。

### `container/agent-runner/` (Bun tree、pnpm 対象外)

`container/agent-runner/` は独自 `bun.lock` を持ち **pnpm workspace の対象外**。したがって `minimumReleaseAge` ポリシーは**適用されない**。

Bun 依存を追加 / バンプするときは:

1. npm 上のリリース日を手動で確認 (3 日以上経過を目安)
2. 意図的にバージョンを pin する
3. `bun update` を盲目的に実行しない
4. 特に agent-runner が実行時に import する `@anthropic-ai/claude-agent-sdk` / `@modelcontextprotocol/sdk` などランタイム critical な依存は変更 review を必須

### コンテナが実行時に呼ぶ Node CLI

`agent-browser`, `claude-code`, `vercel` などの Node CLI は agent-runner (`bun install -g`) ではなく **Dockerfile 内の pnpm グローバル install** で導入する (`bun install -g` は host tree の supply-chain policy を bypass する)。追加時は新しい `ARG` で exact バージョンに pin する。

## セキュリティアーキテクチャ図

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Slack Chat SDK    Fugue HTTP endpoint      Debug CLI             │
│  (msg, mentions)   (Bearer + rate limit     (host-only)           │
│                     + BIBLIO_NAME_RE)                             │
└──────┬───────────────────┬──────────────────────┬─────────────────┘
       │                   │                      │
       ▼                   ▼                      ▼
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • messaging routing (agent_groups × messaging_groups × sessions) │
│  • IPC 認可 (cli_scope, user_roles: owner/global/scoped/member)   │
│  • mount validation (external allowlist, block patterns)          │
│  • container lifecycle (Docker / K8s Job)                         │
│  • OneCLI Vault (credential injection, combined CA bundle)        │
│  • HITL approval dispatch (Slack DM → approver)                   │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  ADK RUNNER (in-process, provider='adk')                    │  │
│  │  • LlmAgent + LLMRegistry (tool allowlist: 9 tools)         │  │
│  │  • tool execute: BIBLIO_NAME_RE guard + HITL (adk-js@1.3.0) │  │
│  │  • outbound HTTP via OneCLI proxy (no real credentials)     │  │
│  └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────┬────────────────────────────────────┘
                              │ two-DB session split (inbound/outbound)
                              │ no shared modules, no IPC pipe
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│         CONTAINER (ISOLATED, provider='claude'/'hybrid')          │
│  • Bun agent-runner                                               │
│  • MCP tools (biblio actions + self-mod + onecli-gateway)         │
│  • Bash / fs / net via OneCLI proxy                               │
│  • no real credentials in env/fs/proc                             │
│                                                                    │
│  Docker (local): --rm, USER node uid 1000, node:22-slim           │
│  K8s Job (GKE): restartPolicy=Never, ttl=120s, backoffLimit=0     │
│                 + fsGroup=1000, drop=ALL, RWO PVC subPath         │
└──────────────────────────────────────────────────────────────────┘
```

## 参照

- [`docs/vertex-claude-keyless.md`](vertex-claude-keyless.md) — Vertex×Claude keyless 認証設計 (WIF + Sidecar token rotator 3 系統 + OneCLI 組み合わせ)
- [`docs/gate-4-layer.md`](gate-4-layer.md) — 入力ゲート 4 層設計 (M4-F Phase 2、pattern / markdown / XML boundaries / LLM evaluator + 3 分類 routing + in-secure 3 点セット)
- [`docs/isolation-model.md`](isolation-model.md) — 3 レベル channel 分離モデル
- [`docs/db-session.md`](db-session.md) — セッションごと `inbound.db` + `outbound.db` の詳細
- [`docs/db-central.md`](db-central.md) — Central DB (`data/v2.db`) の全テーブル
- [`docs/equip-physical.md`](equip-physical.md) — 装備機構の物理配置規約
- [`docs/operations-runbook.md`](operations-runbook.md) — 運用早見表 (OneCLI 罠 / GKE リセット / verify 手順)
- [`terraform/m4-a-observability/`](../terraform/m4-a-observability/) — Cloud Logging → BigQuery sink 宣言
- [`SECURITY.md`](../SECURITY.md) — Vulnerability 報告経路
