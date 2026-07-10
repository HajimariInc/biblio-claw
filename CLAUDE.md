# biblio-claw

biblio-shelf プロジェクトの **司書実装 repo** (Librarian for the biblio-shelf skill marketplace)。NanoClaw v2 (`nanocoai/nanoclaw` @ `2492259`, 2026-05-28) を base fork として、以下の司書オペレーションと channel integration を実装:

- **司書オペレーション**: 仕入れ (acquire) / 検品 (inspect) / カテゴライズ (categorize) / 陳列 (shelve) / 装備 (equip) / 蔵書一覧 (list) / 禁書 (enkin) / 焼却 (shokyaku) / 設定変更 (update_config)。破壊操作は HITL 承認を経由。
- **Channel integration**: Slack (Chat SDK bridge)、Fugue (`/v1/channels/fugue/{consult,equip,ask}` HTTP endpoint、姉妹プロジェクト連携)。
- **Runtime**: GKE Autopilot (Prod) / docker compose (local)。observability = OpenTelemetry + Cloud Logging → BigQuery sink。ADK (Google Agent Development Kit) 経由での host action の LLM 自律呼出に対応。

> **本 CLAUDE.md の構造**: 上部 = biblio-claw 固有の運用ルール (Branch 戦略 / 環境分離方針)。下部 = NanoClaw v2 上流 CLAUDE.md を継承保持 (base アーキ理解の正本)。**衝突時の優先**: 運用ルール (Branch 戦略、環境分離方針) は biblio-claw 上部を優先。**アーキ理解・コード慣習** (Two-DB Session Split / Central DB / Container Config / OneCLI gateway / Bun runtime 等) は NanoClaw 下部に従う。

> **biblio 独自語彙について**: 本文中に登場する biblio-claw 独自語彙 (`biblio` / `司書` / `patron` / `装備` / `禁書` / `焼却` / `棚` / `仕入れ` / `検品` / `カテゴライズ` / `陳列` 等) の解説は [`docs/glossary.md`](docs/glossary.md) 参照 (Vault 正本 `naming-mapping.md` / `functions.md` の inject 版、bilingual)。

> **NanoClaw v1→v2 migration banner について (本 repo では適用対象外)**: NanoClaw v2 上流 CLAUDE.md の元バージョンには冒頭に「⚠️ STOP — READ THIS FIRST IF YOU ARE CLAUDE ⚠️」というバナーがあり、v1 install への v2 merge 衝突を検知したら HALT して `migrate-v2.sh` を案内する指示がある。biblio-claw は **NanoClaw からの fresh fork** (v1 install を持たない、`git clone` + rsync で取り込み済) ため、バナーの状況には該当しない。`git pull` 経由で上流の更新を取り込んで衝突した場合も、biblio-claw 側 (= 当 repo の現在の状態) を正として手動 merge する。当該バナー本文は本統合で下部から削除した。

## Branch 戦略

biblio プロジェクトの branch 戦略 — **全 PRD を横断する運用ルール**。`/prp-implement` / `/prp-pr` / `/prp-mr` などの PRP コマンドのデフォルト挙動を上書きする。PRP コマンド実行時、本セクションを最優先する。

### 4 階層モデル

```
main (Protection) ← リリースの終着点
 └─ base/<prd-slug> ← PRD (1 リリース = N PRD)
 └─ feature/phase-<N>-<slug> ← Phase (= plan)
 └─ Task (plan 内チェックリスト、ブランチなし)
```

| 階層 | 命名規則 | base | 目的 |
| :--- | :--- | :--- | :--- |
| **main** (Protection) | `main` | - | Prod 同等のリソース状態。配下 PRD 全てが合流した状態がリリース単位 |
| **PRD** | `base/<prd-slug>` | `main` | 独立した実装計画単位。`base/<theme>-<slug>` 形式 |
| **Phase** (= plan) | `feature/phase-<N>-<slug>` | 対応する `base/<prd-slug>` | PRD 内の中間達成点。**1 plan = 1 feature の 1:1 対応**。Task はブランチを切らず plan 内チェックに降格 |

### 例

```
main (Protection)
 ├── base/<prd-slug-A> ← PRD A
 │ ├── feature/phase-1-<slug> ← 1st plan
 │ ├── feature/phase-2-<slug> ← 2nd plan
 │ └── feature/phase-3-<slug> ← 3rd plan
 └── base/<prd-slug-B> ← PRD B
 ├── feature/phase-1-<slug> ← 1st plan
 └── feature/phase-2-<slug> ← 2nd plan
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
- **リリース単位** = 配下 PRD 全てが main に合流した状態
- main 直 push は禁止 (Protection)
- CI/CD 未整備の間は Protection を緩く運用 (メンテナ手動運用)、CI/CD 整備で厳格化する予定
- 本方針は biblio プロジェクト (biblio-claw / biblio-shelf) 全域で採用

## 環境分離方針

biblio-claw は **環境分離型** で開発する:

- **local**: docker compose で実装を完成 (抽象化アダプタを含む)
- **Prod**: 同一バイナリを GKE Autopilot へ + GCP 特有要素を追加適用

host 側で外部 HTTP を OneCLI proxy 経由に統一し、git/gh は `HTTPS_PROXY` を尊重、Node.js 内蔵 fetch は `undici.ProxyAgent` 経由で透過させる構成。全 PRD で本方針を継承する。

## 関連

- **biblio-shelf** (棚、public) = [`HajimariInc/biblio-shelf`](https://github.com/HajimariInc/biblio-shelf) — skill 本体 + marketplace
- **NanoClaw 上流** = [`nanocoai/nanoclaw`](https://github.com/nanocoai/nanoclaw) @ `2492259` (2026-05-28) を base として本 repo に取り込み済

---

# NanoClaw v2 上流 CLAUDE.md (継承)

> 以下は NanoClaw v2 上流 (`nanocoai/nanoclaw` @ `2492259`) の CLAUDE.md 本体。biblio-claw は本ドキュメントを **base アーキ理解の正本**として継承する。冒頭にあった「⚠️ STOP — READ THIS FIRST IF YOU ARE CLAUDE ⚠️」(v1→v2 merge 防衛バナー) は本 repo 文脈では適用対象外 (上部参照) のため削除した。それ以外は上流原文を保持する(日本語化済み)。
>
> **本セクション以下の指針が biblio-claw 上部運用ルールと衝突する場合**: Branch 戦略 / 環境分離方針は biblio-claw 上部優先。アーキ理解・コード慣習 (Two-DB Session Split / Central DB / Container Config / OneCLI gateway / Bun runtime / pnpm policy 等) は NanoClaw 流に従う。

# NanoClaw

パーソナルな Claude アシスタント。理念とセットアップは [README.md](README.md) を参照。アーキテクチャは `docs/` 配下。

## 概要

host は単一の Node プロセスで、セッションごとの agent コンテナをオーケストレートする。プラットフォームのメッセージは channel adapter 経由で到着し、エンティティモデル(users → messaging groups → agent groups → sessions)を辿ってルーティングされ、セッションの inbound DB に書き込まれ、コンテナを起こす。コンテナ内の agent-runner は DB をポーリングし、Claude を呼び出して outbound DB に書き戻す。host は outbound DB をポーリングし、同じ adapter 経由で配信する。

**すべてはメッセージである。** host とコンテナの間に IPC、ファイルウォッチャ、stdin パイプは存在しない。2 つのセッション DB が唯一の IO 境界である。

## エンティティモデル

```
users (id "<channel>:<handle>", kind, display_name)
user_roles (user_id, role, agent_group_id) — owner | admin (グローバル or スコープ付き)
agent_group_members (user_id, agent_group_id) — 非特権ユーザのアクセスゲート
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

`data/v2.db` はセッション専有でないすべてを保持する: users、user_roles、agent_groups、messaging_groups、wiring、pending_approvals、user_dms、chat_sdk_*(Chat SDK ブリッジ用)、boots(PVC + SQLite 永続化アサーション用の決定的指紋)、session_equipped_biblios(session 単位の装備リスト + order_index ASC で順序保証、session 削除で cascade)、biblio_settings(個別 PRD `individual-skill-shiire` 、動的設定値の allowlist ベース upsert)、fugue_equipped_biblios(Fugue channel-scoped 装備状態、`biblio_name` PK + `equipped_at` + `request_id`、`sessions(id)` FK なし = Fugue に session 概念なし)、schema_version。マイグレーションは `src/db/migrations/` 配下に置く。

skill やスクリプトからのアドホッククエリには `sqlite3` CLI ではなく、ツリー内のラッパーを使うこと: `pnpm exec tsx scripts/q.ts <db> "<sql>"`。host のセットアップは `sqlite3` バイナリへの依存を意図的に避けている(`setup/verify.ts:5`)。ラッパーはセットアップが既にインストールして検証済みの `better-sqlite3` 依存を経由する。デフォルト出力フォーマットは `sqlite3 -list`(パイプ区切り、ヘッダなし)に合わせてあるので、既存の skill のテキストはそのまま読める。

## 主要ファイル

| ファイル | 役割 |
|------|---------|
| `src/index.ts` | エントリーポイント: DB 初期化、マイグレーション、channel adapter、配信ポーリング、sweep、シャットダウン(SIGTERM/SIGINT で `shutdownOtel` も実行)。main 冒頭で `registerAnthropicVertexLlm` を呼出 (ADK `LLMRegistry` への `AnthropicVertexLlm` 登録、OTel init は `--import` 経路で完了済の前提)。`writeFileSync('/tmp/boot-complete', ...)` (`incrementBootCounter` 直後 = DB init + migration 完了 signal) と `writeFileSync('/tmp/host-ready', ...)` (`main` 末尾 = `initChannelAdapters` + delivery poll + host sweep + CLI server まで全 subsystem 起動完了 signal、StatefulSet の `startupProbe`/`readinessProbe`/`livenessProbe` が exec `test -f /tmp/host-ready` で読む) の 2 段 sentinel を書き込む。synchronous `writeFileSync` = 書き込み順序保証、throw 経路は `main.catch` の fatal log で観測可能 |
| `src/instrumentation.ts` | `node --import ./dist/instrumentation.js` / `tsx --import ./src/instrumentation.ts` で main より前に NodeSDK を起動する OTel エントリ。init failure は warn + 継続 (= telemetry なしでも biblio actions を生かす degraded fallback) |
| `src/adk/AnthropicVertexLlm.ts` | `BaseLlm` 継承による Anthropic Claude on Vertex AI ADK wrap (`supportedModels: [/^claude-.*/]`、`generateContentAsync` AsyncGenerator + 自前 span 計装 = `vertex-client.ts` 写経、`connect` は throw NotImplemented)。keyless ADC 経路 (= `accessToken` / `googleAuth` / `authClient` 明示渡さず SDK 内部解決に委譲)。既存 `src/biblio/vertex-client.ts:callVertexAnthropic` (undici raw `:rawPredict`) は 既存機能本体への影響回避のため touch せず並行存続、段階的に移行。(1) `LlmRequestConfig.tools?` → `toAnthropicTools` → `messages.create({tools})` 経路で LLM に tool 定義を渡す / (2) `toLlmResponse` 先頭で `tool_use` block → `functionCall` part 変換 (id 保持、multi-block 対応、id/name 不正 filter で全 drop の warn 経路) / (3) `convertContentsToAnthropicMessages` を multi-turn 対応に拡張 (`functionCall` part → `tool_use` block / `functionResponse` part → `tool_result` block、無効 part は log.warn + skip で silent failure 撲滅)。これにより LLM 自律 tool 呼出 + round-trip が成立 |
| `src/adk/schema-conversion.ts` | `normalizeSchema` (再帰的 type UPPERCASE→lowercase + 数値メタフィールド `Number` coerce = ADK `simple_zod_to_json.ts` が `minLength:"1"` を string 出力する bug 対応、Anthropic draft 2020-12 validator の 400 reject 回避) + `toAnthropicTools` (ADK `config.tools` `Array<{functionDeclarations}>` → Anthropic `AnthropicTool[]` 変換、`name` 不在 / `parameters` 不正型は `log.warn` + skip、`{type:'object'}` fallback で silent failure 撲滅) の 2 純粋関数。外部 dep 追加なし (pailat/adk-llm-bridge 写経)。ADK 1.4.0+ で `parametersJsonSchema` が追加された場合の切替は TODO コメントで grep 可能 |
| `src/adk/llm-registry-setup.ts` | `LLMRegistry.register(AnthropicVertexLlm)` の idempotent 起動時 hook (module-scope `registered` flag で二重登録の log noise 回避、失敗時 throw で silent failure 撲滅 fail-fast)。`src/index.ts` の main 冒頭で `registerAnthropicVertexLlm` を呼出 |
| `src/adk/tools/{acquire,inspect,shelve}-tool.ts` | 既存 host action `acquire` / `inspect` / `shelve` を ADK `FunctionTool` でラップ。入力は Zod schema (= `repo: z.string` / `biblioName: z.string` / `category: z.enum(BIBLIO_CATEGORIES)`) で型付け、`resolveToolCtx(tool_context)` で `requestId` / `sessionId` を取得して structured log を出力 + 既存関数に ctx 伝搬。`withBiblioActionSpan` は不呼び出し (= ADK 自動 span `execute_tool` に任せ重複 span 回避)。delivery action handler 経路 (MCP → outbound.db) は touch せず並走継続。`AnthropicVertexLlm` tool routing 拡張が完了し LLM 自律呼出経路が成立。**`inspect-tool.ts` の `execute` 冒頭に `BIBLIO_NAME_RE` guard 追加** (path-traversal 防御、`inspect-action.ts:47-56` と同流儀、`schema_invalid` REJECT で fail-closed。CLI/Slack 経路 LLM 自律呼出が本番化した以降の攻撃面閉塞) |
| `src/adk/tools/{categorize,list-biblio,shelve-multi,config}-tool.ts` | 残 4 host action の `FunctionTool` ラップ (pattern 機械踏襲、BIBLIO_NAME_RE guard + throw しない契約 + structured log を統一)。`categorize` は Vertex × Anthropic での 4 namespace 分類、`list_biblio` は棚 marketplace.json 取得 (category filter)、`shelve_biblio_multi` は複数 skill × 複数 category を 1 PR に陳列 (原子性維持)、`update_config` は `BIBLIO_SETTING_KEYS` allowlist の動的変更 (ADK 経路では admin check 省略、Zod enum で allowlist 強制、`config-validation.ts` 経由の意味検証) |
| `src/adk/tools/{enkin,shokyaku}-tool.ts` | 破壊操作 tool (`enkin_biblio` / `shokyaku_biblio`) の HITL 対応ラップ。adk-js@1.3.0 `Context.requestConfirmation` API を活用し、`toolConfirmation` の有無で初回/resume を分岐する 2 段構造 (初回: `requestConfirmation({hint, payload})` → runner 自動 pause / resume: `toolConfirmation.confirmed` で承認判定 → 実 `enkin` / `shokyaku` 呼出 or 拒否応答)。初回呼出の `requestConfirmation` に try/catch を追加し、`@experimental` API の throw リスクに fail-closed で対処 (`adk.tool.{enkin,shokyaku}.request_confirmation_error` event)。BIBLIO_NAME_RE guard は execute 冒頭で fail-closed、reason 分類は `UnshelveFailureReason` に `user_rejected` 不在のため `config_error` に集約 (型追加検討) |
| `src/adk/tools/hitl-types.ts` | HITL tool の型安全性強化用共有型定義 — `HitlToolAction = 'enkin' \| 'shokyaku'` + `HitlConfirmationPayload = {biblioName, category, action}` の共有型を集約 export。tool 側 payload / dispatcher pending 経路判定 / adk-approvals の RequestAdkApprovalOptions / approval-dispatcher の AdkApprovalPayload の 4 layer 間で単一 source として参照される。新 HITL tool 追加時は `HitlToolAction` に値追加するだけで型 error で全経路が検知される |
| `src/adk/dispatcher.ts` | channel adapter agnostic な ADK Runner event stream → `adapter.deliver` 橋渡し dispatcher。`getSharedRunner` = module-level singleton (SDK オブジェクト構築コスト削減、lazy 初期化)。(1) `getSharedRunner` を `SharedRunnerContext = {runner, sessionService}` 返しに拡張、(2) `runEphemeral` → `sessionService.createSession + runner.runAsync + 明示 deleteSession` に切替 (HITL pause で session 保持が必要になったため)、(3) `event.content.parts` から `functionCall.name === 'adk_request_confirmation'` の part を直接走査して HITL pending 経路を検知 → `requestAdkApproval` (`Promise<boolean>`) 呼出 → true 時のみ「承認申請しました」中間応答 + session 保持 (review C1/C2/C3 で adk-js@1.3.0 実装契約の namespace 不一致バグ + silent drop + 内部失敗の誤認識を修正)。CLI (`cli.ts`) でも Slack (`slack.ts`) でも同一 code path。`adapter.deliver` が undefined 返却時 (CLI client 未接続等) は `not_delivered` warn で silent 化を防ぐ。event loop 内で HITL 以外の `functionCall.name` を `emitAdkToolStatus` に転送し ADK 経路にも progress-status を出す (`.catch` で unhandledRejection 撲滅)。通常経路の finally で `clearAdkTargetStatus` を呼び per-target 直近 status Map を明示解放 |
| `src/adk/approval-dispatcher.ts` | `resolveAdkApproval(payload, selectedOption)` = admin 承認後の resume 経路。`sessionService.getSession` で Pod 再起動対応 (session 消失時は patron に「失効」通知) → `runner.runAsync({sessionId, newMessage: {functionResponse: {id: wrapper_id, name: 'adk_request_confirmation', response: {confirmed}}}})` で resume → event stream から最終応答を patron に deliver → `sessionService.deleteSession` で cleanup。`deliverToPatron` に `deliveryId === undefined` 検知追加 (dispatcher.ts:deliverFallback pattern carry over) |
| `src/adk/tools/tool-ctx.ts` | `resolveToolCtx(tool_context)` ヘルパ — `tool_context?.invocationId ?? crypto.randomUUID` + `tool_context?.sessionId ?? ''` を返す (= `ReadonlyContext` getter 経由で ADK 公開 API 面を尊重、3 tool で 2 行重複の単一更新点) |
| `src/adk/root-agent.ts` | `buildRootAgent` factory — `new LlmAgent({model: 'claude-sonnet-4-6', tools: [...]})` を返す。module-scope での `new LlmAgent` は import 時に Vertex 認証解決が走る罠があるため factory function 化 (test 環境の mock 順序問題を回避)。**CLI/Slack 統合版に `ROOT_AGENT_INSTRUCTION` を拡張済** (patron 呼称 + 応答フォーマット指針 + 失敗理由伝達 + tool 使用判断規範、日本語 minimal → ~35 行)。tools 配列を 3 → 9 に拡張 (`categorize` / `list_biblio` / `shelve_biblio_multi` / `update_config` / `enkin` / `shokyaku` 追加)、instruction に破壊操作の判断規範追加 (「patron 明示指示のみ発火、曖昧指示なら list_biblio で候補提示 → 明示指示 → 発火の 2 段」、~500 → ~1000 words) |
| `src/adk/runner.ts` | `buildRunner(agent)` factory — 外部依存ゼロの in-process `SessionService` / `ArtifactService` / `MemoryService` を自動セットアップ。戻り値を `SharedRunnerContext = {runner: InMemoryRunner, sessionService: InMemorySessionService}` に拡張し、`InMemoryRunner` 内部が自動生成する `InMemorySessionService` を `runner.sessionService` (Runner 親クラスの public field) 経由で expose。HITL pause/resume で session を明示的に create/delete するために dispatcher / approval-dispatcher から touch できるようにした (multi-turn 需要ではなく HITL 対応が動機)。`as InMemorySessionService` cast は adk-js@1.3.0 実装契約に依存 (関連 issue で runtime assertion 追加検討) |
| `src/modules/approvals/adk-approvals.ts` | ADK Runner 経由の破壊操作 (enkin/shokyaku) 用 HITL 承認カード配信ブリッジ (`onecli-approvals.ts` pattern 継承)。`requestAdkApproval(opts): Promise<boolean>` は Slack DM に ask_question card を配信し、`session_id: null` + `action='adk_confirm'` で `pending_approvals` row を作成する。戻り値 `Promise<boolean>` で pending row 作成成否を dispatcher に伝え、内部 fallback 通知 (approver 不在 / DM 不在 / deliver throw / delivery adapter 未 wire) を「成功」と誤認しない設計に修正。`notifyPatronFallback` に `deliveryId === undefined` 検知追加 |
| `src/observability/` | host 側 OTel 実装。`otel.ts` (NodeSDK + OTLP HTTP + BatchSpanProcessor low-throughput チューニング) / `auth.ts` (ADC Bearer + 45min refresh) / `env-propagation.ts` (W3C Env Carriers Spec の UPPERCASE Setter/Getter) / `no-proxy.ts` (telemetry.googleapis.com を NO_PROXY に確実に追加) / `index.ts` (公開 API) / `genai.ts` (GenAI semconv 定数 + `extractVertexUsage` Gemini/Anthropic 両対応、`/incubating` import 不使用で定数 hardcode) / `trace-fields.ts` (`getTraceLogFields` = active span から Cloud Logging `logging.googleapis.com/{trace,spanId,trace_sampled}` reserved field を返す、Preferred Format = trace_id alone、実機検証 2026-07-03 / 、runbook § log↔trace 連携 参照)。`container/agent-runner/src/observability/` と対 (Bun 非互換のため BasicTracerProvider 直接組み、auth.ts / env-propagation.ts / trace-fields.ts はコメントで同期義務を明記)。`http-propagation.ts` (W3C `traceparent` HTTP header 用 `TextMapGetter` + `extractTraceContextFromHttpHeaders(headers, base=context.active)` = `env-propagation.ts` の HTTP header carrier 版、base が `context.active` デフォルト引数で `context.with` 経由の active context 破壊を防ぐ review 対応) / `fugue-entry-span.ts` (`withFugueEntrySpan(operation, requestId, fn, extraAttributes?)` = 既存の `withBiblioActionSpan` の Fugue channel 版、`fugue.<operation>` span 生成、`channel:'fugue'` を span level 属性、`sessionId` 引数なし、catch でデフォルト `fugue.outcome='error'` 反映で silent failure 撲滅) |
| `src/adapters/` | 環境差分吸収アダプタ群。`getDsnProvider`(DB / セッション DB のパス解決)、`getSchedulerProvider`(sweep の tick 供給)、`getSecretProvider`(OneCLI 操作)、`getContainerRuntimeProvider`(agent コンテナの spawn / kill、Docker vs K8s Job 切替)の 4 ファクトリ。`<X>_PROVIDER` env スイッチで実装を差し替え可能 (`DSN_PROVIDER=local\|gke`、`CONTAINER_PROVIDER=docker\|k8s` 等) |
| `src/router.ts` | 受信ルーティング: messaging group → agent group → session → `inbound.db` → ウェイク (`container_configs.provider === 'adk'` の場合は session/container 経路をスキップし `src/adk/dispatcher.ts` の in-process ADK Runner に直結、dispatcher throw 時は patron に fallback 応答を送る)。gate 発火直前に `emitPreSpawnStatus('分類中')`、`deliverToAgent` wake 分岐で `startTypingRefresh` に `initialStatus=PIPELINE_STATUS.CONTAINER_STARTING` を渡す (=「container 起動中」) の 2 経路で Slack 進行ステート表示に載る |
| `src/delivery.ts` | `outbound.db` をポーリングし adapter 経由で配信、システムアクション(スケジュール、承認 等)を処理。`pollActive` の 1s tick に `refreshProgressStatus` 相乗り (`container_state.current_tool` 読取 → tool 名日本語文言 → `updateTypingStatus`)。`drainSession` の db open 失敗判定は `isPreSpawnDbOpenError` (session-manager.ts) に集約して poller.ts と共通化。`stubOutboundTargets` Set + `addStubOutboundTarget` / `removeStubOutboundTarget` / `isStubOutboundTarget` の 3 export API 追加 (`ncl messages send --stub-outbound` の verify 経路で実 channel deliver を silent skip する契約)。key は 3-tuple `${agentGroupId}:${channelType}:${platformId}` (`session_mode='shared'` の `thread_id=null` に対応するため key から thread_id 除外、fan-out 別 agent group への副作用ゼロは agent_group_id で担保)。production 経路は Set が常に空 = 常に false = 挙動不変。skip 時 `log.info` で「何を skip したか」を Cloud Logging に残す |
| `src/modules/typing/index.ts` | typing indicator の 4 秒 refresh loop 本体。既存 `startTypingRefresh` / `pauseTypingRefreshAfterDelivery` / `stopTypingRefresh` に加え、 `TypingTarget.currentStatus` + `updateTypingStatus(sessionId, status)` (変化時のみ再送 = rate limit ガード、`pausedUntil` 尊重で post-delivery 中は状態更新のみ) を追加。`setTyping` signature に `status?: TypingStatus` を通す 3 層 (`channels/adapter.ts` / `delivery.ts` / 本 file) の起点 = `TypingStatus` 型は `channels/adapter.ts` に集約。`triggerTyping` に `sessionId` / `agentGroupId` optional 引数を追加、成功/失敗両分岐で `logProgressStatusTransition` helper 経由 `progress.status.transition` info emit を発火 (既存の弱点 = 成功パス log 不在、を補完)。呼出元 3 箇所 (startTypingRefresh 初回 tick / re-inbound existing 分岐 / interval tick) 全てで entry から取得値を forward |
| `src/modules/progress-status/` | 新設: Slack 進行ステート表示 (`assistant.threads.setStatus`) の集約 module。`tool-status-map.ts` = tool 名 → 日本語文言 pure mapper (SDK 18 種 + ADK biblio 9 + MCP nanoclaw/tavily/drive + generic fallback、`PIPELINE_STATUS` 定数で router.ts のステージ文言を集約) / `poller.ts` = `refreshProgressStatus` (`delivery.ts:pollActive` の 1s tick 相乗り、`isPreSpawnDbOpenError` で pre-spawn 抑制) / `pre-spawn.ts` = `emitPreSpawnStatus` (session 未確定な pre-spawn 経路) + `emitAdkToolStatus` (ADK dispatcher 用、per-target 直近 status ガード内蔵 = hybrid `updateTypingStatus` と対称) + `clearAdkTargetStatus` (invocation 終了時解放) |
| `src/host-sweep.ts` | 60 秒の sweep: `processing_ack` の同期、stale 検出、due メッセージのウェイク、再帰スケジュール(周期 tick の供給は `getSchedulerProvider` に委譲)。`decideStuckAction` は `kill-ceiling` (30 min, stuck 最後の砦) / `kill-idle` (`AGENT_IDLE_THRESHOLD_MS` 既定 5 min、claims 空 + Bash 未宣言時に conversation-done container を解放、GKE zonal PVC 由来の Pending Pod 緩和) / `kill-claim` の 3 path |
| `src/session-manager.ts` | セッションを解決し `inbound.db` / `outbound.db` をオープン、heartbeat パスを管理(DB パス算出は `getDsnProvider` に委譲) |
| `src/container-runner.ts` | agent group ごとにコンテナを起動 (`getContainerRuntimeProvider` 経由で Docker または K8s Job)。セッション DB と outbox をマウント (Docker = hostPath bind mount、K8s = PVC subPath volumeMount で分岐)。`getSecretProvider` 経由で OneCLI gateway のクレデンシャルを注入(`ensureAgent` / `applyContainerSecrets`)。`subPathOf` ヘルパは `src/adapters/container/mounts.ts`。`appendEquippedBiblioMounts` (export) で装備済 biblio を per-biblio readonly subPath mount として末尾に append (mount spec の DB lookup 化) |
| `src/adapters/container/` | `ContainerRuntimeProvider` 抽象 + `DockerContainerRuntimeProvider` (local) + `K8sJobContainerRuntimeProvider` (GKE Batch v1 Job + Informer。K8s 経路では mounts を orchestrator RWO PVC の subPath に変換 + OneCLI CA bundle を K8s Secret から `/etc/ssl/certs/onecli` にマウント + OneCLI SDK の Docker 由来 env `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS` を cluster-internal 値に post-process + `securityContext.fsGroup: 1000` で agent user に PVC 所有権を寄せる) + factory (`CONTAINER_PROVIDER` env で切替) |
| `src/modules/permissions/access.ts` | `canAccessAgentGroup` — `user_roles` + `agent_group_members` に対する owner / global admin / scoped admin / member の解決 |
| `src/modules/approvals/primitive.ts` | `pickApprover`、`pickApprovalDelivery`、`requestApproval`、approval-handler のレジストリ |
| `src/command-gate.ts` | ルータ側の admin コマンドゲート — `user_roles` を直接クエリ(env var なし、コンテナ側チェックなし) |
| `src/modules/approvals/onecli-approvals.ts` | OneCLI の認証付きアクション承認ブリッジ |
| `src/modules/approvals/response-handler.ts` | 承認 response 分岐点。OneCLI in-memory Promise resolve → DB row 検索 → OneCLI action / **ADK adk_confirm** (追加) / module-registered action の順で dispatch。`adk_confirm` 分岐は `ONECLI_ACTION` 分岐の直後 (現状 L48-49 付近、`ADK_CONFIRM_ACTION === 'adk_confirm'` を grep) に挿入 (既存 module-registered handler の session_id null ガード + wakeContainer 経路は無変更で温存)、payload を JSON.parse して `resolveAdkApproval` を呼出 |
| `src/user-dm.ts` | cold-DM の解決 + `user_dms` キャッシュ |
| `src/group-init.ts` | agent group ごとのファイルシステム scaffold(CLAUDE.md、skills、agent-runner-src のオーバーレイ) |
| `src/db/container-configs.ts` | `container_configs` テーブル(agent group ごとのコンテナランタイム設定)の CRUD |
| `src/backfill-container-configs.ts` | 起動時に旧 `container.json` ファイルを DB に移行 |
| `src/container-restart.ts` | agent group コンテナの kill + on-wake 再生成 |
| `src/db/` | DB レイヤー — agent_groups、messaging_groups、sessions、container_configs、user_roles、user_dms、pending_*、マイグレーション。`biblio-settings.ts` は biblio 設定値 (`biblio_settings` table) の 4 CRUD (`getBiblioSetting` / `setBiblioSetting` / `getAllBiblioSettings` / `deleteBiblioSetting`、`container-configs.ts` パターン mirror)。`fugue-equipped-biblios.ts` は Fugue channel の装備状態 (`fugue_equipped_biblios` table = migration 019、`biblio_name` PK + `equipped_at` + `request_id`、`sessions(id)` FK なし = Fugue に session 概念なし、channel-scoped で 1 装備セット) の 3 CRUD (`insertFugueEquippedBiblio` = INSERT OR IGNORE + boolean 返却で `equipped` / `already_equipped` を atomic 判別 / `getFugueEquippedBiblioNames` = consult 応答の `SkillRef.equipped` 判定用 / `deleteFugueEquippedBiblioByName` = 焼却 cleanup 用)。`container-configs.ts` は migration 020 (M4-H Phase 3.5) で `system_prompt_override TEXT` 列を追加し、fugue-ask agent group 専用の custom system prompt bypass 経路を保持する (非 NULL 時のみ Claude SDK の `systemPrompt: <string>` string 経路 + `settingSources: []` = preset 全 bypass + CLAUDE.md auto-load 遮断) |
| `src/biblio/config-validation.ts` | `validateValueForKey(key, value)` を副作用なしの pure helper file に分離。`config-action.ts` は `registerDeliveryAction` を module-scope で発火する副作用を持つため、ADK tool (`src/adk/tools/config-tool.ts`) から直接 import すると test 環境で不要な delivery pipeline 初期化が走る問題への対応。`config-action.ts` は re-export で後方互換維持、ADK / delivery 両経路で単一更新点となる。`Number.parseInt` → `Number.isInteger(Number(value))` に変更し、小数文字列 `"10.5"` の素通しを reject |
| `src/channels/` | channel adapter のインフラ(レジストリ、Chat SDK ブリッジ)。上流 NanoClaw では具体的な adapter は `channels` ブランチから skill 経由でインストール / biblio-claw では Slack adapter (`src/channels/slack.ts` = Chat SDK bridge 経由の非同期双方向) と Fugue adapter (`src/channels/fugue.ts` + `fugue-http.ts` + `fugue-schemas.ts`、独立 `http.createServer` + Bearer auth の同期 request-response 型、outbound.db 経路を使わないため `deliver` は throw で silent no-op 撲滅。consult endpoint は `listBiblio` 経由の実検索 + `withBiblioActionSpan('list', ...)` 相乗り + 部分失敗 200+`status:'error'`+`warnings` 経路で full spec 実装。**equip endpoint も full spec 化 = `FugueEquipRequest.skill_id + channel` 受理 + `BIBLIO_NAME_RE` guard + `requiresApproval` guard (defensive) + `withBiblioActionSpan('equip',...)` + `insertFugueEquippedBiblio` の INSERT OR IGNORE で 4 status (`equipped` / `already_equipped` / `not_found` / `error`) 応答、部分失敗は consult と対称に 200 経路。consult 側は `toSkillRefs` に `equippedNames: ReadonlySet<string>` 引数追加 + `getFugueEquippedBiblioNames` の DB read failure 時は空 Set fallback + warnings 経路 (装飾情報の欠落で検索を殺さない)、`SkillRef.equipped` を `boolean` に緩和**。**2 段 trace 構造 (`fugue.consult`/`fugue.equip` = `withFugueEntrySpan` → `biblio.list`/`biblio.equip`) + W3C traceparent 手動 extract (`extractTraceContextFromHttpHeaders`、base=`context.active`) を `handleRequest` の path routing 前に `context.with` で active 化 + `fugue.outcome` を `biblio.outcome` と対称配置 (grep 検知可能) + `fugue.degraded=true` (装備状態劣化) + `fugue.outcome='hitl_required'` (HITL defensive path を withFugueEntrySpan の内側に移動、matrix 変更時の silent bypass + telemetry 不可視の両方閉じる) + malformed traceparent の `log.warn` 可視化 (`event:'fugue.traceparent.malformed'`)。auto HTTP SERVER span 層は ESM + `--import` 構成で現状未発火 (`require-in-the-middle` 依存 + `module.register` 未整備)、**2 段構造を正式仕様として確定** (Node 24.15.0 `module.register` DEP0205 documentation-only 非推奨化 + Node 26.0.0 runtime deprecation 予定を根拠に 3 段化投資見送り、`fugue-entry-span.ts:15-18` の AsyncLocalStorage 設計で将来 auto SERVER span 発火時は自動 nest される保険 = 可逆判断、`docs/operations-runbook.md` §ESM フック判断 に集約)。unit test 45 case (5 file)**) を trunk に直接コミット済。**M4-H で ask endpoint 追加** = `POST /v1/channels/fugue/ask` (`handleAsk` 経路、Contract §5.5)。agent-container spawn (`resolveSession` + `writeSessionMessage` の 2 段を try/catch で保護 = C1 対応 + `try/finally` で cleanup 統一 = P2 対応、AD 本義契約に整合) → 90s 同期 poll wait (`pollFugueAskResponse`、`performance.now()` deadline で clock skew 対策) → response 抽出 + `AgentAskResponse.safeParse` → `wrapExternalContent` で 4 field XML 囲み (`fugue-ask-content.ts:wrapExternalContent`、二重 wrap 剥がし + close tag escape の trust boundary layer) → `FugueAskReply.safeParse` self-validation → 200 応答。gate 4 層 (Phase 2) + intent hint / INTENT_GATE_MISMATCH warnings + in-secure denial + rate limit (`fugue-rate-limit.ts` の自前 sliding window、429 + `Retry-After`、consult/equip は構造的 bypass) を統合。`FugueOperation` に `'ask'` 追加 (`fugue-entry-span.ts`)。単一 source の Literal は `FUGUE_ASK_INTENTS` / `FUGUE_SOURCE_KINDS` (schemas.ts) に集約 = biblio 側拡張時の drift を型で検知 |
| `src/providers/` | host 側の provider container-config(`claude` は組み込み、`opencode` 等は `providers` ブランチからインストール) |
| `container/agent-runner/src/` | agent-runner: ポーリングループ、フォーマッタ、provider 抽象化、MCP ツール、destinations |
| `container/skills/` | 全 agent セッションにマウントされるコンテナ skill(`onecli-gateway`、`welcome`、`self-customize`、`agent-browser`、`slack-formatting`) |
| `groups/<folder>/` | agent group ごとのファイルシステム(CLAUDE.md、skills、group ごとの `agent-runner-src/` オーバーレイ) |
| `scripts/init-first-agent.ts` | 最初の DM 配線済 agent をブートストラップ(`/init-first-agent` skill から使われる) |
| `scripts/init-adk-agent.ts` | ADK 用 agent group (folder=`adk-biblio-shisho`) を central DB に upsert + `container_configs.provider='adk'` を毎回 assert (isNewGroup gate 外で真の冪等・自己修復) + CLI channel (`cli/local`) 自動 wire。既存 CLI wire (別 agent group) を検出したら fan-out 二重発火防止のため fail-fast + 手動対応 prompt。Slack channel wire は env `SLACK_WIRE_CHANNEL_ID` 指定時のみ optional (プレゼン素材録画用の任意作業として温存) |
| `scripts/init-hybrid-agent.ts` | hybrid (claude fallback provider) 用 agent group (folder=`hybrid-biblio-shisho`) を central DB に upsert + `container_configs.provider=null` + `model='claude-sonnet-4-6'` (過去に発生した Vertex 404 の再発防止のため明示、null は claude-code SDK の内蔵 default が Anthropic API alias を返して Vertex rawPredict が 404 化する既知障害の再発ルート) を毎回 assert (isNewGroup gate 外で真の冪等・自己修復) + owner user は `getUser` guard で display_name 上書き回避 (init-first-agent.ts 経路で登録済の owner 情報を無傷保護) + **メンテナ Slack DM wire (必須) + Slack channel wire (optional、0..N、`--slack-channel-ids C1,C2,...` or `HYBRID_SLACK_CHANNEL_IDS` env、issue #144 対応)**。DM / channel いずれも既存 mg が他 agent group に wire 済なら fan-out 二重発火防止のため fail-fast + 手動対応 prompt (`GATE_ENABLED=1` で構造的抑止条件を満たす場合のみ並置許容 = `init-adk-agent.ts:wireCliChannel` の CLI 経路 fail-fast pattern を Slack DM / channel 経路に対称転写)。channel wire は `createMessagingGroupAgent` 経由で `agent_destinations` 自動生成が発火する = issue #144 で実測された「事後手動 `ncl wirings create` = generic CRUD 経路で destinations 抜け → channel 応答が DM に silent 混線」を構造的に閉じる。CLI wire なし (= `cli/local` の既存 ADK wire を無傷維持、`verify-m4-b.sh` regression 継続確保)。GKE 実行は `scripts/init-hybrid-agent-gke.sh` (kubectl exec wrapper、`HYBRID_USER_ID` + `HYBRID_SLACK_DM_CHANNEL_ID` + optional `HYBRID_SLACK_CHANNEL_IDS` env or `.env` から供給) 経由 |
| `src/biblio/` | **biblio-claw 機能本体** (+ 装備機構 + 蔵書一覧 + 独立 PRD `individual-skill-shiire` 全 5 Phase 完了 + observability)。`acquire.ts` 仕入れ (`ACQUIRE_SKILL_THRESHOLD` 超過で clone 前 early return → patron に個別指定促進 / `<owner>/<repo>/<skill>` 指定時は `fetchSkillSubtree` が partial clone + sparse-checkout で該当 skill dir + `.claude-plugin/` を取得 = biblioName 3 要素化 (marketplace 形式 repo 対応: `.claude-plugin/` を含めることで metadata 源を検品 / 陳列段階で物理可視化、`.claude-plugin` 不在 repo は pattern miss として silent に抜ける) / **`resolveSkillThreshold` を DB → env → DEFAULT の 3 層 fallback に拡張 + `export` 化 (verify probe 用)、各層 warn ログに `event` / `outcome` key 付与、`acquire` 内呼び出しは try/catch で degraded fallback**) / `inspect.ts` 検品 (Vertex × Gemini 3 軸。schema 軸の metadata 解決は `resolvePluginMeta` ヘルパで `.claude-plugin/plugin.json` 優先、ENOENT なら `.claude-plugin/marketplace.json` の plugins[] から該当 entry を fallback で marketplace 形式 repo を ACCEPT) / `categorize.ts` カテゴライズ (Vertex × Claude Sonnet-4.6) / `shelve.ts` 陳列 (追加方向 draft PR、`shelf-gh.ts` 共有経路。**`shelveMulti(reqs, opts)` を中核実装に置換、既存 `shelve(req, opts)` は `shelveMulti([req], opts)` の薄ラッパ。reqs.length === 1 で branch 名 / commit msg / PR body / PR title を既存単一 shelve と完全互換**) / `shelf-gh.ts` GitHub Git Data API 共通レイヤ (ghFetch / GhHttpError / MarketplaceParseError / GhFetchCtx / GhFetchOptions / fetchMarketplace / pluginsOf / createCommit / readShelveEnv / readListEnv、shelve + unshelve 系は `ShelfEnv` (棚 owner/repo + author 4 件必須)、list-biblio 系は `ListEnv` (owner/repo のみ) で分岐。`ghFetch` の `noAuth` オプションは、外部 repo (= GH App installation scope 外) では OneCLI MITM が token 注入しても GitHub が 401 Bad credentials を返すため Authorization 自体を省略して無認証 public API 200 を取る、`ctx` オプション (GhFetchCtx = requestId / sessionId) は構造化ログ伝搬用) / `unshelve.ts` 解除本体 (削除方向 draft PR、`sha:null + base_tree`) / `enkin.ts` 禁書 (unshelve 薄ラッパ、装備源残置 = 再装備可) / `shokyaku.ts` 焼却 (unshelve + fs.rmSync 物理削除 + `deleteEquippedBiblioByName` + `deleteFugueEquippedBiblioByName` (fugue channel-scoped 装備状態からも並置除去)、`cleanupWarning` で patron に cleanup 失敗を伝える。shokyaku-action.ts 側の通知文言は cleanupWarning あり時「装備状態のクリーンアップに一部失敗しました」の理由非依存ヘッドラインで運用) / `host-proxy.ts` OneCLI proxy 経由化 (combined CA bundle で MITM/tunnel 両 trust) / `vertex-client.ts` Vertex 呼び出し (Anthropic + Gemini 両経路) / `types.ts` 型定義 + `BIBLIO_CATEGORIES` + `EquippedBiblio` + `UnshelveResult` + `ShokyakuResult` + `ListBiblioItem` / `ListBiblioParams` / `ListBiblioResult` + `MultiShelveItem` / `MultiShelveResult` / `MultiShelveFailureReason` + `BIBLIO_SETTING_KEYS` / `BiblioSettingKey` (whitelist 方式の動的変更 key allowlist、`BIBLIO_CATEGORIES` パターン mirror) / `action-helpers.ts` biblio action 共通ヘルパ (writeBackMessage + BIBLIO_NAME_RE + safeNotify approval handler 用。**`BIBLIO_NAME_RE` を 2 要素 + 3 要素両対応に拡張**。**: `withBiblioActionSpan` (10 handler 共通 span ラッパ、`biblio.${action}` 名 + `biblio.request_id` / `biblio.session_id` / `biblio.action` / `biblio.outcome` 属性、exception を recordException + ERROR status で記録、finally で span.end 保証) + `BiblioActionName` closed union 12 値 (`'equip'` 追加、Fugue channel 装備操作を既存 `biblio.${action}` 集計に channel-agnostic に載せる、sessionId 空文字は approval 経路と同慣習) で span 名タイポを compile-time block**) / `hitl-policy.ts` HITL 承認要否の政策関数 (Fugue 契約 §6.2 matrix の pure 宣言 = `requiresApproval(operation: 'consult'|'equip'|'shiire'|'tekkyo', channel: 'slack'|'fugue')`、副作用なし。現状の呼び出し元は Fugue equip 経路のみ = 既存 enkin/shokyaku HITL は各 action ファイル側分岐が正で touch せず、本関数は「政策宣言 + Fugue 契約の写し + 将来の集中化 anchor」の役割) / `{acquire,inspect,categorize,shelve}-action.ts` delivery action handler (= agent → MCP → outbound → host → inbound 経路) / `multi-shelve-action.ts` 複数陳列 delivery action handler (`shelve_biblio_multi` 経路、per-item BIBLIO_NAME_RE + BIBLIO_CATEGORIES validate → `shelveMulti` 呼出) / `{enkin,shokyaku}-action.ts` delivery action handler + approval handler (HITL 承認経路、破壊操作は admin 承認を経由) / `equip.ts` 装備機構の物理配置解決 (`session_equipped_biblios` テーブルから session 単位で DB lookup、env override は test only バックドアとして残置) / `list-biblio.ts` 蔵書一覧本体 (`fetchMarketplace` → source split → category filter で `ListBiblioResult` を返す純粋関数) / `list-biblio-action.ts` delivery action handler (`@bot 蔵書` 経路、不正 category は silent fallback で全件 + 注記の UX 寄せ) / `config-action.ts` 設定動的変更 delivery action handler (`update_config` 経路、key/value validate → allowlist (`BIBLIO_SETTING_KEYS`) → key-specific value validation (`ACQUIRE_SKILL_THRESHOLD` は正整数チェック、silent fallback 防止) → admin check (`isConfigChangeAllowed` = 該当 agent_group に owner/admin が紐づくか、`user_roles` 不在は allow-all。userId 取得経路欠落のため per-user 厳密 check 未実装 = 別 PRD で改善) → `setBiblioSetting` upsert → writeBack。handler 全体を try/catch で囲み throw しない不変条件を担保) |
| `src/reporting/` | **M4-C 週次 reporting** (`scripts/reporting-cronjob.ts` から起動される週次 K8s CronJob の本体 module、Phase 1 で pipeline 成立 + Phase 2 で SQL 完成 + Data Table Block 化 + cache 対称化 + severity=CRITICAL 追加)。`bq-client.ts` (BigQuery v8 client wrapper、location: 'asia-northeast1' 明示 + SDK 自動 retry 依存) / `pricing-table.ts` (Anthropic 4 モデル + Gemini 2 モデル単価表、Vertex regional premium 1.10 定数 + `resolveVertexPremium()` の `CLOUD_ML_REGION` 分岐 (`'global' → 1.0` / それ以外 → `1.10`)、Gemini は Vertex Global 単価で hardcode = `gemini-3.1-flash-lite` は $0.25/$1.50、2026-07-09 pinning) / `cost-calculator.ts` (usage → cost の pure fn、Anthropic × Vertex premium (`resolveVertexPremium()` 経由、Prod は `CLOUD_ML_REGION=global` 明示のため実質 1.0、未指定 fallback は 1.10) 適用 + Gemini は premium 適用外 (`PROVIDER_APPLIES_VERTEX_PREMIUM.gemini=false`)、`cache_creation`/`cache_read` は M4-C Phase 2 で emit + SQL 列追加済 + normalizeLlmCostRow の null ガード対称化 (C2) で BQ NULL 経路も warnings 発火 = cost 過小推定を patron に可視化、未知 model は silent 0 + warnings で throw しない) / `slack-post.ts` (`postSlackMessage` REST 直叩き wrapper + 429 検知時の 30s 固定 backoff 1 回 retry、SlackApiError.status で分岐、`blocks: SlackBlock[]` required で型締め、discriminated union で返し throw しない = silent failure 撲滅) / `formatter.ts` (4 種セクション → `{text, blocks}` の 2 shape、BigQueryInt shape `{value: string}` の coerce + row warnings 収集 + inspect の reason 列 (I1) + errorTrend の severity 列 (C1) + llmCost の uncaptured_cache_calls warning (I2)、Slack Block 変換は `blocks-builder.ts` に分離) / `blocks-builder.ts` (M4-C Phase 2 新設: `@chat-adapter/slack/blocks` の `cardToSlackBlocks(card)` 経由で 4 セクションを Data Table Block 化。内部 `tableToBlocks` は非 export、1 card 1 table 制約のため必ず 4 card 分割、100 rows × 20 cols 超過時は library 側で自動 ASCII fallback、`QueryOutcome<unknown>` 受け + normalizer injection で unsafe cast 排除 (S2)) / `cronjob-lib.ts` (entrypoint の pure fn 抽出 = `validateReportingEnv` 3 段 guard + `safeRunQuery` (`QueryOutcome<T>` discriminated union で SQL 失敗と empty を型区別) + `loadSql` + `REPORT_KINDS` 定数) / `sql/*.sql` (4 種全て完成版。`llm-cost.sql` は M4-C Phase 2 で `cache_read`/`cache_creation`/`uncaptured_cache_calls` 列追加、`inspect-distribution.sql` は `verdict × reason × dangerous` 3 軸集計 (`inspect_error` = システム障害と `license_*` = policy 保留を区別)、`error-trend.sql` は `severity IN ('ERROR', 'CRITICAL')` + `APPROX_QUANTILES(x, 100 IGNORE NULLS)` p50/p95/p99 (host crash / startup failed が silent 除外される regression 対応、review R6 C1)、全て `<PROJECT_ID>` + `<DATASET_ID>` placeholder + `DATE(timestamp, 'Asia/Tokyo')` TZ 明示) / `index.ts` (barrel export) |
| `scripts/reporting-cronjob.ts` | M4-C CronJob entrypoint (`pnpm exec tsx --import ./src/instrumentation.ts scripts/reporting-cronjob.ts` で起動)。4 種 SQL を Promise.all で並列実行 (`cronjob-lib.ts:safeRunQuery` が `QueryOutcome<T>` discriminated union (`{ok: true, rows} \| {ok: false}`) で各失敗を型付き分離、1 種の失敗で他 3 種を止めない = R4 review 対応) + `formatBiblioUsageSummary` の `{text, blocks}` 分割代入 + `postReport` に text + blocks 両方渡し (Phase 2) + `shutdownOtel()` 必須呼出。`GCP_PROJECT_ID` / `BQ_DATASET_ID` / `REPORTING_WINDOW_DAYS` / `REPORTING_CHANNEL_ID` / `OWNER_SLACK_USER_ID` / `SLACK_BOT_TOKEN` env で駆動、必須欠落は fail-fast + `reporting.cronjob.no_project_id` / `reporting.cronjob.no_channel` event emit。OneCLI proxy 非経由 (CronJob Pod は orchestrator 相当の host 権限で BQ / Slack 直接到達、agent container 経路との別トポロジをコメントで明示) |
| `terraform/m4-c-reporting/` | M4-C 週次 reporting CronJob 用 IAM binding 宣言 module。既存 `biblio-orchestrator@` GSA に project-scoped `roles/bigquery.jobUser` (**repo 初の `google_project_iam_member` 使用例**、BQ job submit 権限は project scope より下に存在しないため) + dataset-scoped `roles/bigquery.dataViewer` on `llm_observability` (table read 権限は dataset に絞る) の 2 binding を付与。既存踏襲の 6 file 構成 (versions.tf / providers.tf / variables.tf / main.tf / outputs.tf / README.md)、既存 dataset は `data "google_bigquery_dataset"` で read 参照のみ (作成は `terraform/m4-a-observability` 側の責務)。1 workload = 1 GSA 原則で M4-C 専用 SA を作らない |
| `container/agent-runner/src/mcp-tools/biblio.ts` | agent コンテナから露出する MCP ツール 9 種(`acquire_biblio` / `inspect_biblio` / `categorize_biblio` / `shelve_biblio` / `shelve_biblio_multi` / `enkin_biblio` / `shokyaku_biblio` / `list_biblio` / `update_config`)。各ツールは outbound.db に system action を書き、delivery poll が `src/biblio/*-action.ts` を呼ぶ。禁書 / 焼却は破壊操作のため host 側で admin 承認を経由する (HITL)。`shelve_biblio_multi` は複数 skill を複数 category 跨ぎで 1 PR に陳列する追加ツール (= 単一 skill / 単一 category なら `shelve_biblio` を使う、agent が description で自律判断)。`list_biblio` は patron の自然文「蔵書」「蔵書一覧」mention を agent が tool description で自律発火する (= host 側 keyword parser を持たない)。`update_config` は patron の「`@bot 設定 KEY VALUE`」「閾値を 20 にして」等の自然文で agent が自律発火する追加ツール (allowlist `ACQUIRE_SKILL_THRESHOLD` のみ受理、value は正整数 string、`user_roles` 不在は allow-all・存在時は該当 agent_group に admin/owner が紐づくときのみ実行可) |
| `scripts/biblio-{acquire,inspect,categorize,shelve,shelve-multi,enkin,shokyaku,list,equip-set,equip-mount-check,equip-spawn-verify,config,resolve-threshold}.ts` | CLI ハーネス。`RESULT=<json>` を stdout に吐き、verify スクリプト (`scripts/verify-m2*.sh` / `scripts/verify-m3*.sh` / `scripts/verify-phase-5-dynamic-config.sh`) が assert で消費する。`shelve-multi` は複数陳列 CLI (= `MultiShelveItem[]` JSON 引数を取り `shelveMulti` を呼ぶ)。`config` は `biblio_settings` の 4 verb (get/set/list/delete) を提供する CLI、`resolve-threshold` は `resolveSkillThreshold` の 3 層 fallback 結果を probe する CLI (どちらも`DB_PATH` env で対象 DB を上書き可能 = verify は専用 fixture DB を使う) |
| `scripts/emit-test-span.ts` | verify 用 test fixture (NodeSDK は `--import ./src/instrumentation.ts` 経由で起動 → `withBiblioActionSpan('acquire', requestId, sessionId, fn)` を直接呼んで実 biblio action と同じ span 構造で 1 リクエスト発射 → `TRACE_ID=<32hex>` / `REQUEST_ID=<uuid>` / `SESSION_ID=verify-m4a-<unix>-<pid>` を stdout に出力 → `shutdownOtel` で BatchSpanProcessor flush 強制)。本番 `acquire` ロジック (GitHub clone 等) は起こさない = 外部依存をパイプ疎通のみに絞り、verify を deterministic に保つ |
| `scripts/verify-phase-1-adk-local.ts` | 新設。 **`TOOL_CALLED=true` + `FINAL_TEXT 非空 (= 司書日本語応答)` が完了判定**に格上げ (`pnpm exec tsx --import ./src/instrumentation.ts scripts/verify-phase-1-adk-local.ts` で起動)。実 Anthropic Vertex (= ADC 経由 `claude-sonnet-4-6`) + 実 `acquire` を呼び、stdout に `TRACE_ID` / `EVENT_COUNT` / `TOOL_CALLED` / `FINAL_TEXT` を出力。main 冒頭に `initHostProxy + setupVertexProxy` を追加 (= tool routing 成立後に `acquire` 内 `github.fetch` が OneCLI proxy 経由にならず 403 rate limit を踏んだため補正、本番 `src/index.ts` main と同等 bootstrap を verify 内で複製)。厳格な TOOL_CALLED=true 判定は GKE 経路の `verify-phase-2-adk-gke.sh` 側が担う (= 本 script は local smoke として INFO を残すだけで exit 0 を維持)。必須 env: `ANTHROPIC_VERTEX_PROJECT_ID` + ADC 済。`CLOUD_ML_REGION` 未設定は `'global'` フォールバック。GOTCHA: `HTTPS_PROXY` が `aiplatform.googleapis.com` に乗ると keyless ADC が壊れる経路あり = `unset HTTPS_PROXY` or `NO_PROXY=aiplatform.googleapis.com` で対処 |
| `scripts/verify-m2.sh` | marketplace 完成判定 E2E (= 仕入れ → 検品 → カテゴライズ → 陳列 + 再 shelve graceful)。pre-flight で `.env` 存在 / OneCLI proxy 到達 / 必須 env をまとめて fail-fast |
| `scripts/verify-m3.sh` | 装備・蔵書 完成判定 E2E (= 装備マーカー検出 / 解除 / 禁書 (装備可) / 焼却 (装備不可) / 全蔵書一覧 / カテゴリ別蔵書一覧 の 6 assertion 統合)。`verify-m3-phase-3.sh` を regression chain として呼び出す。destructive 強制 (cleanup 対象 env を pre-flight で fail-fast) + draft PR trap cleanup。`.env` は local 経路用 (GKE 経路では manifest env 直接投入のため不在 = 正常、warn 継続) |
| `scripts/verify-m3-helpers.sh` | 装備・蔵書 verify 共通ヘルパ (`info` / `warn` / `fail` / `extract_result` / `json_field` / `json_array_length` / `probe_onecli`)。`probe_onecli` は curl 優先 / node fetch fallback で OneCLI 到達を probe (GKE distroless 環境での curl 不在を吸収) |
| `scripts/verify-m4-a.sh` | 統合検証 (案 C 設計、7 セクション + Section 4.5 追加 + Section 5.5 追加)。Section 4 (Cloud Trace) は emit-test-span の TRACE_ID 個別マッチ assert、Section 5-6 (BQ sink) は host log が Cloud Logging に届かない plan 欠陥への対応として **TRACE_ID 個別マッチ諦め + 「過去 1h に GKE 起源の biblio.* event log が >= 1 件 BQ 到達」だけ assert** に簡素化 (= sink 疎通の証跡で deliverable 動作確認として十分、本番副作用なし)、**Section 5.5 (BQ 上の top-level `trace` 列が `projects/<PROJECT_ID>/traces/<32-hex>` 形式に自動昇格されているかを stdout+stderr UNION で shape assert = "View trace" UI 遷移動作の regression 早期検知 (warn-only、PASS はブロックしない、query 失敗は sentinel で 0 件不在と区別)**。Section 7 は sink filter の k8s_container + namespace 縛り保持の静的 grep。`source verify-m3-helpers.sh` で info/warn/fail を共有。必須 env = `GCP_PROJECT_ID` / `BQ_DATASET_ID`、`.env` 不在は warn 継続。終了時 `PASS` 出力 + exit 0。完全 E2E (case A = orchestrator Pod 内で fixture / case B = Slack 経由 read-only action) は将来 phase で別途検討 |
| `scripts/verify-m4-b.sh` | ADK 統合検証 (**9 section**CLI 経由 E2E)。Section 1 (preflight) / Section 2 (keyless 4 面) / Section 3 (StatefulSet ready + image tag `m4b-*` + ADK agent group 存在) / **Section 4 (1 命令完遂 = `kubectl exec ... pnpm run chat "@bot 仕入れて ..."` の stdout に `仕入れ|acquire|📦` キーワード)** / **Section 4.5: 拡張 tool smoke = `list_biblio` + `update_config` を chat 経由で発火して stdout keyword 検証** / Section 5 (Cloud Trace REST v1 で trace + span 一覧、`execute_tool acquire_biblio` + `chat claude-*` の 2 種存在 = `invoke_agent` は ADK 1.3.0 実装で立たない前提、span export 遅延対策で「両 span 揃うまで retry」経路) / Section 6 (`gen_ai.operation.name` / `provider.name` / `request.model` = `chat` / `gcp.vertex_ai` / `claude-*` を AnthropicVertexLlm 自前 span でのみ確認) / **Section 6.5: HITL flow smoke = enkin を dummy biblio 名で発火して dispatcher の pending 経路発火 event (`adk.approval.dispatch.enkin`) + `pending_approvals` の `action='adk_confirm'` row 作成の 2 point を assert + cleanup DELETE ** / Section 7 (regression = verify-slack-e2e-gke.sh opt-in)。末尾 `PASS` + 2 連続冪等 exit 0 = **PRD 完了判定**。必須 env = `GCP_PROJECT_ID` / `BQ_DATASET_ID`、任意 env でテスト対象 biblio 名 / regression opt-in を指定可 |
| `scripts/verify-fugue-channel.sh` | 統合検証 (**10 section**5 軸 (疎通 / 認証 / HITL 簡略化 / channel 分離 / keyless) × 2 環境 (local docker compose / Prod GKE))。bash flag `--local` / `--prod` / なし (both) の 3 mode 切替。Section 1 (Preflight = 共通、罠 2/4/7/8 pre-detect + `data/v2.db` 存在 fail-fast) / Section 2-4 (LOCAL: consult/equip 疎通 + 認証 fail 401 / HITL 3 point AND text/json 両対応 / SQLite 2 table 独立性 + 静的 grep) / Section 5-10 (PROD: HTTPS /healthz + consult 200 + 認証 fail 401 / Ingress backend HEALTHY + NEG annotation / Cloud Trace `fugue.consult → biblio.list` 親子関係 + `channel='fugue'` label / BQ sink `channel='fugue'` cnt>=1 / HITL 3 point AND + channel 分離 / keyless 3 段 = KSA annotation + GSA IAM workloadIdentityUser binding + no USER_MANAGED key)。trap cleanup で `fugue_equipped_biblios` verify 用 row を local / Prod 別に冪等 DELETE (`CLEANUP_LOCAL_DIRTY` + `CLEANUP_PROD_DIRTY` 2 flag)。末尾 `PASS (mode)` + 2 連続冪等 exit 0。任意 env = `VERIFY_FUGUE_TEST_SKILL_ID` (default `HajimariInc--test-biblio-minimal` = 実 Prod 棚に存在、`BIBLIO_NAME_RE` = `<owner>--<repo>` 形式必須) / `VERIFY_FUGUE_ORCHESTRATOR_POD` (default `biblio-orchestrator-0`) / `VERIFY_FUGUE_NAMESPACE` (default `biblio-claw`) |
| `scripts/verify-m4-f.sh` | 統合検証 (**agent-container-hybrid MVP 完成判定 7 assertion**)。9 section 3 mode (`--local` / `--prod` / 省略 = both)で3 分類 routing / in-secure 3 点 / agent-container 機能 / 進行ステート表示 (`progress.status.transition` 集計 + 目視 checklist) / Fugue 不変 (chain) / 1 trace 串刺し / keyless の 7 assertion を programmatic に検証。発話経路は `ncl messages send --stub-outbound` (新設の host-only verb)。`PASS (mode)` marker + 2 連続冪等 exit 0 = PRD 完了判定成立 |
| `scripts/verify-m4.sh` | 統合検証 chain。`verify-m4-a.sh` → `verify-m4-b.sh` → `verify-fugue-channel.sh --prod` → `verify-m4-f.sh --prod` の順で chain 実行、各 sub-script が非 0 exit したら `set -e` で親も即 fail。末尾 `PARTIAL PASS` + exit 0。所要時間 ~15-30 min |
| `scripts/verify-phase-5-dynamic-config.sh` | 動的設定 完成判定 (= `biblio_settings` migration apply / CRUD / 上書き + delete / list / 3 層 fallback 4 sub-assert の 6 assertion)。専用 fixture DB (`/tmp/biblio-verify-p5-<pid>.db`) で既存 `data/v2.db` に副作用なし、`LAST_HARNESS_STDERR` で tsx 起動失敗 / migration 失敗を fail 時に表示 (= verify-m2.sh と同流儀)。allowlist 検証は CLI レイヤで再現不可のため `src/biblio/config-action.test.ts` (= 17 case all PASS) に委譲注記 |
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
| messages | send | 発話を任意の messaging_group に注入する host-only debug 経路。`routeInbound` 直呼び + optional `stub_outbound` で実 channel deliver を silent skip。新設 (verify-m4-f.sh から hybrid Slack DM MG を programmatic に発火する用途)|

主要ファイル: `src/cli/dispatch.ts`(ディスパッチャ + approval ハンドラ)、`src/cli/crud.ts`(汎用 CRUD 登録)、`src/cli/resources/`(リソースごとの定義)。

## チャネルと provider(上流 NanoClaw: skill 経由 / biblio-claw: trunk 直接コミット)

> **上流 NanoClaw の前提** (以下 2 段落): trunk には具体的な channel adapter や非デフォルトの agent provider は同梱されていない。コードベースはレジストリ・インフラとしての役割を持ち、実際のアダプタと provider は長命の sibling ブランチに置き、skill 経由でコピーされる。

- **`channels` ブランチ** — Discord、Slack、Telegram、WhatsApp、Teams、Linear、GitHub、iMessage、Webex、Resend、Matrix、Google Chat、WhatsApp Cloud(+ ヘルパー、テスト、channel 固有のセットアップ手順)。`/add-<channel>` skill 経由でインストール。
- **`providers` ブランチ** — OpenCode(および将来の非デフォルト agent provider)。`/add-opencode` 経由でインストール。

各 `/add-<name>` skill は冪等である: `git fetch origin <branch>` → 標準パスにモジュールをコピー → 対応する barrel に self-registration の import を追記 → `pnpm install <pkg>@<pinned-version>` → ビルド。

**biblio-claw 流の運用** (上流継承と差分): 上流の `/add-<channel>` skill フローは biblio-claw では使わず、`setup/add-<channel>.sh` で取り込んだ adapter を biblio-claw の trunk (= `main`) に **直接コミット** する運用を採る。これは「fork は base を持つ = trunk が channel adapter を持って配布される」というスタンスの帰結。本 repo の `src/channels/slack.ts` は本方針の第 1 例。**本 fork で新設された `src/channels/fugue.ts` + `fugue-http.ts` + `fugue-schemas.ts` は第 2 例** (ただし Fugue は upstream 由来の channel ではなく biblio-claw 固有の HTTP adapter のため `setup/add-<channel>.sh` に相当する取り込み元は存在しない = ゼロから実装)。**したがって**本セクション冒頭の上流前提「trunk に adapter は同梱されない」は biblio-claw には当てはまらない。

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

API キー、OAuth トークン、認証クレデンシャルは OneCLI gateway が管理する。シークレットはリクエスト時に agent ごとのコンテナへ注入される — env var にもチャットコンテキストにも渡さない。コンテナ内の agent はこれを `onecli-gateway` コンテナ skill(`container/skills/onecli-gateway/SKILL.md`)経由で認識する。この skill は proxy の仕組み、認証エラーの扱い方、生クレデンシャルを決して尋ねないことを agent に教える。host 側の配線: OneCLI 固有の実装は `src/adapters/secret/onecli.ts`(`SecretProvider` 実装)に隔離され、呼び出し元(`container-runner.ts` / `src/modules/approvals/onecli-approvals.ts`)は `getSecretProvider` 経由で同一インスタンスを共有する。詳細は `onecli --help`。

### 落とし穴: 自動生成された agent は `selective` シークレットモードで起動する

host が新しい agent group のセッションを最初に spawn するとき、`container-runner.ts` の `buildContainerArgs` が `getSecretProvider.ensureAgent({ name, identifier })` を呼ぶ。OneCLI の `POST /api/agents` エンドポイントは agent を **`selective`** シークレットモードで作成する — つまり、vault にシークレットが存在しホストパターンが本来マッチするものでも、**デフォルトではこの agent にシークレットが割り当てられない**。

症状: コンテナが起動し、proxy と CA 証明書は正しく配線されているのに、vault に *実在する* クレデンシャルを使う API から `401 Unauthorized`(または類似)が返ってくる。クレデンシャルがこの agent の allow-list に入っていないだけである。

SDK は `setSecretMode` を公開していないが、OneCLI v1.30.0 の REST には `PATCH /v1/agents/:id/secret-mode {"mode":"all"}` が存在する。biblio-claw では `OneCLISecretProvider.ensureAgent` が SDK 呼び出し直後に `GET /v1/agents` → `PATCH secret-mode` を自動発行するため (init-project-gcp 側で追加)、新規 agent は spawn 直後に mode=all へ昇格する。ローカル環境では `scripts/onecli-vertex-secret.sh` と `scripts/onecli-gh-secret.sh` が secret 投入のついでに全 agent を一括昇格する safety net としても機能する (= ensureAgent 経路で PATCH が失敗したとき、または手動で agent を作成したときの拾い直し)。手動で個別調整したい場合は CLI(または Web UI `http://127.0.0.1:10254`)を使う:

```bash
# agent を探す (identifier は agent group id)
onecli agents list

# "all" に切り替えて、ホストパターンがマッチする vault 内のすべてのシークレットを注入する
onecli agents set-secret-mode --id <agent-id> --mode all

# あるいは selective のまま、特定のシークレットを割り当てる
onecli secrets list # シークレット id を確認
onecli agents set-secrets --id <agent-id> --secret-ids <id1>,<id2>

# 現在 agent に割り当てられているものを確認する
onecli agents secrets --id <agent-id> # この agent に割り当てられたシークレット
onecli secrets list # vault の全シークレット (ホストパターン付き)
```

`mode all` を有効化したばかりの場合、Bearer が未失効ならばコンテナの再起動は不要 — gateway はリクエストごとにシークレットをルックアップするので、稼働中のコンテナからの次の API 呼び出しで新しいクレデンシャルが見える。**ただし、既に 401 retry-loop に入っている agent コンテナは `pnpm run ncl groups restart --id <agent-group-id>` で clean restart が必要** — SDK 内部の認証状態がリクエストごとの lookup を超えて固着していることがあり、host 経由で kill + 再生成すると新しい Bearer で動く。 Task 7-A で実測した知見。

### 落とし穴: OneCLI MITM が `tunnel` mode で素通しになる

OneCLI proxy (v1.30.0) は secret の `hostPattern` にマッチしない宛先 host を **`mode=tunnel`** で素通し転送する (= MITM しない)。tunnel 経路では client が本物の TLS cert を受信するため、`GIT_SSL_CAINFO` / `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS` に OneCLI CA だけを渡していると trust chain が完成せず SSL 検証で落ちる (典型症状: `git clone https://github.com/...` で `unable to get local issuer certificate`)。

biblio-claw は `src/biblio/host-proxy.ts:initHostProxy` で **OneCLI CA + Node.js 組み込みの Mozilla root CA bundle (`tls.rootCertificates`)** を append した combined bundle を書き出すことで、MITM 経路 (= OneCLI 偽 cert) と tunnel 経路 (= 本物 cert chain) のどちらも trust 成立させる。詳細な切り分けデバッグ手順 (= `docker logs biblio-onecli | grep 'mode='` から始まる 3 ステップ) は `docs/operations-runbook.md` §「落とし穴: OneCLI MITM が `tunnel` mode で素通しになる」を参照。

**agent コンテナ内の Go バイナリ (gh CLI 等)** は `HTTPS_PROXY` 経由で OneCLI proxy に接続し OneCLI の MITM 偽 cert を受け取る。Go の `crypto/x509` は `SSL_CERT_FILE` env を尊重するため、`container/Dockerfile` で `ENV SSL_CERT_FILE=/etc/ssl/certs/onecli/onecli-combined-ca.pem` を設定し、K8s Secret mount 済の combined CA bundle を信頼する経路を確立する (= GKE 経路では `K8sJobContainerRuntimeProvider.rewriteOneCLIEnv` が OneCLI SDK の `/tmp/...` 形式 env を Secret mount path に rewrite する。orchestrator container 側は `src/biblio/host-proxy.ts:getChildProcEnv` が子プロセス起動時に動的 inject するため manifest / Dockerfile での ENV 設定は不要)。

### 設計原則: secret は pathPattern を省略する (GKE 環境差分の回避)

OneCLI v1.30.0 では secret に `pathPattern` を string で明示すると、**GKE 環境で MITM Authorization injection logic が呼ばれずに 401 を返す** 不具合がある (= ローカル docker compose 経路では動くが、GKE では skip される)。両環境で dependable な唯一の経路は **pathPattern を payload から省略すること** (= 全パスマッチ)。`pathPattern: null` も別経路で 400 reject (= `expected string, received null`、検証で実測) されるため、**省略以外の選択肢はない**。

biblio-claw では:

- **GH App auth が必要な操作** (棚 / 司書本体 + 仕入れ対象 public repo) → `hostPattern=api.github.com` + **pathPattern 省略** で `api.github.com` の全パスに GH App installation token を inject
- **scope 最小化** は GH App installation の repo 限定 (= biblio-shelf + biblio-claw の 2 repo のみ install 済) で担保。pathPattern による経路フィルタリングは採用しない
- **外部 public biblio の仕入れ** (`/repos/<外部>/*`) も installation token が wire 上載るが、token scope を超えた WRITE は GitHub 側で拒否される (= 観察可能な漏洩リスクなし、rate limit は authenticated 5000/h 扱いに上がるだけ)
- **private repo / 認証必要な外部 access が出てきたら メンテナ と事前相談** (= 新規 hostPattern で別 secret を追加、host で分離)

過去 (/) は「pathPattern 明示で最小権限」を採用していたが、**GKE で injection skip される** ことが 2026-06-24 に判明 、本知見で取り消し。`scripts/onecli-gh-secret.sh` は POST / PATCH 両経路で pathPattern を一切送らない。OneCLI `PATCH /v1/secrets/<id>` の partial update では `value` のみ送れば、`hostPattern` / `injectionConfig` / 既存 `pathPattern` は OneCLI 側で保持される (= 残置された旧 pathPattern を消す API は v1.30.0 観察上存在しないため、必要なら DELETE + POST 再作成)。

### GH installation token (GitHub App Sidecar 経路)

司書 agent が `gh` で GitHub REST API に到達するための認可は、GitHub App PEM → RS256 JWT → installation access token を発行して OneCLI に投入する経路で行う。

- **Local (docker compose 経路)**: `scripts/onecli-gh-secret.sh` を host OS 上のシェルスクリプトとして実行する。PEM はローカルファイル (`GH_APP_PEM_PATH`、`*.pem` で gitignore 済) から読む。同スクリプトは `scripts/sign_jwt.cjs` (Node 組み込み crypto / 依存ゼロ) を内部で呼ぶため、両ファイルは常にペアで存在する必要がある。token 有効期限は **~60min** なので、期限切れ時に同スクリプトを再実行すると `PATCH /v1/secrets/:id` で `value` のみ partial update (id 保持、200) される (= pathPattern は省略経路、 参照)。
- **GKE 経路**: orchestrator Pod 内の `gh-token-rotator` Native sidecar (image は `k8s/10-orchestrator-statefulset.yaml` の `biblio-sidecar-gh:<tag>` 参照、tag は init-project-gcp image-sync で随時 bump) が `scripts/gh-rotate.sh` (= `scripts/onecli-gh-secret.sh` を `ROTATE_INTERVAL_SEC=3000` (= 50min) の sleep loop で wrap) を実行し、自動再投入する。PEM は別の `fetch-pem` initContainer が WI 経由 (orchestrator KSA → `biblio-orchestrator` GSA, `roles/secretmanager.secretAccessor` on `biblio-gh-app-pem`) で Secret Manager から取得し、tmpfs emptyDir (`medium: Memory`) に書き出して rotator container に読み取り専用 mount する。rotator container の env には **`SHELF_REPO_OWNER`** が literal 投入されている (= 本スクリプトの直接依存ではなく、verify-m2/m3/slack-e2e-gke の gh pr cleanup や運用一貫性 (= rotator pod debug 時に orchestrator と同 owner literal が grep で揃う) のため。既存 issue 解消で `onecli-gh-secret.sh` の `need` からは削除済)。旧 `k8s/30-sidecar-cronjob.yaml` (`biblio-sidecar` CronJob `*/30`) は本 fork で **廃止** された。

```bash
# Local 経路 (docker compose):
# 前提: .env に GH_APP_ID / GH_INSTALLATION_ID / GH_APP_PEM_PATH を設定 + docker compose up -d --wait 済
# (SHELF_REPO_OWNER は本スクリプトの実行には不要、verify-m2/m3/slack-e2e-gke 等の他経路で参照されるので .env には残す)
bash scripts/onecli-gh-secret.sh
```

GKE 経路ではメンテナが追加コマンドを叩く必要はない (= `kubectl apply -f k8s/` 後、orchestrator Pod が起動した時点で sidecar が動き始める)。あわせて `set_all_agents_mode_all` で全 agent を mode=all に昇格する処理も rotator script 内で走るため、初回 agent spawn 後の再注入も自動で完了する。

**動作確認の注意**: `api.github.com` の public repo (`/repos/owner/repo`) は無認証でも `200 + repo メタ` を返すため、Authorization 注入の効果検証には rate limit ヘッダ (`X-RateLimit-Limit: 5000` = authenticated) を見るか、private repo か、authenticated 必須エンドポイント (例: `/installation/repositories`) を probe する必要がある。同様に「token 未注入で 401」確認も public repo では成立しない (無認証でも 200 を返すため、Authorization ヘッダの有無で応答が変わらない)。

### OneCLI proxy CA bundle 投入 (GKE 経路、PRD A 以降)

GKE Autopilot Warden が `autogke-no-write-mode-hostpath` で agent Pod の hostPath mount を全 deny するため、OneCLI が agent コンテナに渡したい proxy CA bundle (`/tmp/onecli-{proxy,combined}-ca.pem`) を hostPath 経由で注入できない。

 以降は **orchestrator Pod 内の `onecli` Native sidecar が emptyDir 経由で CA bundle を生成 → 同 Pod 内 orchestrator container 上の `ca-secret-sync` が起動時 + 60s sweep で K8s Secret `biblio-onecli-ca` に自動 upsert** する経路に切り替わった。agent Pod は引き続き Secret から `/etc/ssl/certs/onecli/` に mount される (`K8sJobContainerRuntimeProvider.translateSpec` の Secret mount + env rewrite ロジックは温存)。

メンテナが手動で `kubectl create secret` する手順は不要 (= 以前の手動投入 doc は廃止済み)。

ロジックの所在:
- emptyDir 共有: `k8s/10-orchestrator-statefulset.yaml` の `volumes.onecli-ca` (OneCLI sidecar: `/app/data/gateway` / orchestrator: `/etc/ssl/certs/onecli` readOnly)
- 自動 upsert ループ: `src/sidecar/ca-secret-sync.ts` (起動 + 60s 周期、ENOENT は silent retry + 5min ごとに warn 再発火)
- agent Pod 用 Secret mount: `K8sJobContainerRuntimeProvider.translateSpec` の OneCLI CA Secret volume / volumeMount (`src/adapters/container/k8s.ts`、温存)

### GKE 側 OneCLI への secret 投入時の `.env` 上書き罠 (ローカル経路のみ)

> 以降、GKE 側の secret 投入は orchestrator Pod 内の sidecar (gh-token-rotator / vertex-token-rotator) が自動で行うため、**GKE 経路では本罠は発生しない**。以下はあくまで **ローカル開発で `scripts/onecli-{vertex,gh}-secret.sh` を host 端末から GKE 側に直接投入したいケース** (debug や緊急復旧) に限定した補足。

`scripts/onecli-vertex-secret.sh` および `scripts/onecli-gh-secret.sh` はスクリプト冒頭で `.env` を `set -a; . .env; set +a` で読み込むため、`.env` に `ONECLI_URL=http://localhost:10254` (= ローカル docker compose 用) があると、外部から `ONECLI_URL=...` を渡しても上書きされ、**ローカル OneCLI に投入されて GKE 側 OneCLI には届かない**。実機検証で踏んだ罠。

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
fetch(process.env.ONECLI_URL + '/v1/agents').then(r => r.json).then(d => {
 console.log('count=', d.length);
 for (const a of d) console.log(a.accessToken.slice(0,20), a.identifier, a.name, 'mode='+a.secretMode);
});"
```

### クレデンシャル使用時の承認要求

認証付きアクションの承認制御は **両側** のフローである:

- **サーバ側**(OneCLI gateway): いつリクエストを保留して pending な承認を発行するかを決定する。`onecli@1.3.0` 時点では、CLI からこれを公開していない — `rules create --action` は `block` と `rate_limit` のみ受け付け、`secrets create` には承認用のフラグがない。承認ポリシーは OneCLI の Web UI `http://127.0.0.1:10254` 経由で設定する必要がある。将来 CLI に `approve` アクションが追加されたら、本セクションは更新が必要。
- **host 側**(nanoclaw): pending な承認を受け取り、人間へ振り分ける。`src/modules/approvals/onecli-approvals.ts` が `getSecretProvider.configureManualApproval(cb)` 経由でコールバックを登録する(`GET /api/approvals/pending` を long-poll)。コールバックは `src/modules/approvals/primitive.ts` の `pickApprover` + `pickApprovalDelivery` を使って approver に DM する。approver は `user_roles` テーブルから解決される — 優先順位: agent group に対する scoped admin → global admin → owner。`NANOCLAW_ADMIN_USER_IDS` のような env var は存在しない。role は central DB にのみ永続化される。

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
git diff origin/main --stat HEAD
git log origin/main..HEAD --oneline
```

出力を提示して承認を待つこと。インストール固有のファイル(group ファイル、.claude/settings.json、ローカル設定)は含めてはならない。

## 開発

コマンドは直接実行する — ユーザーに「これを実行してください」とは伝えない。

```bash
# host (Node + pnpm)
pnpm run dev # ホットリロード付きで host を起動
pnpm run build # host の TypeScript (src/) をコンパイル
./container/build.sh # agent コンテナイメージ (nanoclaw-agent:latest) を再ビルド
pnpm test # host のテスト (vitest)

# agent-runner (Bun — container/agent-runner/ 配下の独立パッケージツリー)
cd container/agent-runner && bun install # agent-runner の依存を編集したあと
cd container/agent-runner && bun test # コンテナのテスト (bun:test)
```

コンテナ側の型チェックは別の tsconfig を持つ — `container/agent-runner/src/` を編集した場合、ルートから `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` を実行する(または `container/agent-runner/` から `bun run typecheck`)。

サービス管理:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw # 再起動

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

注意: コンテナログはコンテナ終了後に失われる(`--rm` フラグ)。**ただし Docker (local) 経路では exit !=0 / signal 終了時の直近 64 KiB stderr が host ログ (`logs/nanoclaw.error.log`) に warn として残る** (`src/adapters/container/docker.ts` の `DockerAgentHandle` が stderr buffer + exit 経路で吐く、追加)。`LOG_LEVEL=debug` で line-by-line tail も得られる。K8s Job 経路では引き続き container 内ログは消える (= 別途 `kubectl logs` で live 取得が必要)。kill 経由の non-zero 終了 (= 通常運用) は warn 対象外。

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
| [docs/operations-runbook.md](docs/operations-runbook.md) | **biblio-claw 運用早見表** (local / GCP)。orchestrator / agent / OneCLI の起動・ログ所在・verify 前提セットアップ表、OneCLI tunnel 罠の対処、GKE リセット手順 (部分 reset / 完全 teardown + 再構築 + Cloud SQL Bootstrap GRANT)、`/init-project` / `/init-project-gcp` サブコマンドカタログ、OTel 運用 (Cloud Logging → BigQuery sink Terraform 管理 + `verify-m4-a.sh`)、ADK orchestrator deploy + tool routing 拡張、CLI/Slack dispatcher 統合、9 tool + HITL 統合、Fugue channel の 2 段 trace 構造 (`withFugueEntrySpan`) + Prod GKE deploy + MVP 完成判定 (5 軸 × 2 環境)、life-capabilities (Tavily Web 検索 + 自作 Drive MCP server + `drive-token-rotator` sidecar + R4 経路 = SA 2 段 impersonation)、progress-status (Slack `assistant.threads.setStatus` 経由の進行ステート表示)、`verify-m4-f` 統合検証、M4-H ask endpoint (agent-container 経由応答経路 + rate limit + system prompt override + Prod deploy 手順 + rollback checklist)、M4-C 週次 reporting (Phase 1 週次 K8s CronJob + BQ 4 種 SQL + Slack owner DM + Phase 2 で SQL 完成 + Data Table Block + cache 対称化 + `verify-m4-c.sh` + BQ clustering 適用手順) を集約 |
| [docs/equip-physical.md](docs/equip-physical.md) | 装備機構の物理配置規約 / mount トポロジ / Docker+K8s 両 runtime 透過の仕組み / spawn-time install lifecycle |
| [docs/slack-environments-setup.md](docs/slack-environments-setup.md) | Slack 2 環境分離 (GCP=本番 ws / local=開発 ws) の App セットアップ手順 |
| [terraform/m4-a-observability/](terraform/m4-a-observability/) | BigQuery sink + dataset + IAM の Terraform 宣言。apply / clustering 後追い / teardown / 既知の罠は `docs/operations-runbook.md` を参照。`sql/summary.sql` は `<PROJECT_ID>` / `<DATASET_ID>` placeholder 化 + 固定 marker 単一行返却に再構成 (= verify-m4-a.sh の `sed` 置換経路、操作用 GROUP BY 集計は同ファイル末尾にコメントブロックで保持) |
| [terraform/fugue-channel/](terraform/fugue-channel/) | Fugue channel の GKE Ingress infra 宣言 = static IP + Google-managed cert + Cloud DNS A record + Secret Manager `fugue-shared-token` + secret-scoped IAM (既存 `biblio-orchestrator` GSA に `roles/secretmanager.secretAccessor` 付与 = 1 workload = 1 GSA 原則)。apply / verify (DNS 反映 + cert Active 待ち) / teardown (Ingress delete → Secret delete → terraform destroy の順序が必須) は `README.md` + `docs/operations-runbook.md` を参照。既存踏襲の 6 file 構成 (versions.tf / providers.tf / variables.tf / main.tf / outputs.tf / README.md) |
| [terraform/tavily-secret/](terraform/tavily-secret/) | Tavily Web 検索 API key を Secret Manager 化する module (`biblio-tavily-api-key`)。`create_before_destroy = true` で `latest` alias 継続性保証 + 既存 `biblio-orchestrator` GSA に secret-scoped `roles/secretmanager.secretAccessor` 付与 (Fugue module と同流儀、1 workload = 1 GSA 原則)。`scripts/onecli-tavily-secret.sh` が deploy 時に SM から読み OneCLI vault に投入。regenerate 時は `terraform apply -var="tavily_api_key=tvly-..."` で新 version 追加 + script 再実行 |
| [terraform/iam-drive-user/](terraform/iam-drive-user/) | Drive access の R4 経路 (SA 2 段 impersonation) を成立させる IAM binding module (恒久対応、2026-07-06)。`biblio-orchestrator@` → `biblio-google-drive-user@` の `roles/iam.serviceAccountTokenCreator` を宣言 (SA-scoped、project-scoped ではない)。前提: GSA 本体は Console で作成済 (手動 lifecycle) + Drive フォルダ ACL は Drive UI で分離 SA に共有 (Terraform 管理外)。詳細な R4 経路の背景は `README.md` + `docs/operations-runbook.md` § 罠 7 参照 |

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
- **Dockerfile の entrypoint または動的 spawn コマンドを変更する**(spawn 機構は `src/adapters/container/{docker,k8s}.ts`、agent の起動コマンド文字列は `src/container-runner.ts` の `command: ['-c', '/app/install-biblios.sh && exec bun run ...']` 付近)→ `exec bun ...` を維持してシグナルがクリーンに転送されるようにする。spawn コマンドは から `container/install-biblios.sh` (= `/app/install-biblios.sh`、Dockerfile で COPY + chmod 755) を bun の前に挟む形になった — 装備リスト loop の wrapper script で、装備 0 件なら早期 exit で no-op。command を変更するときは wrapper の前置を保つこと (= 装備機構が壊れる)。`container/Dockerfile` (agent コンテナ) のイメージには `/app/dist` がない。tsc ビルドステップを再導入しないこと (host orchestrator は root `Dockerfile` で tsc を走らせて `/app/dist` を持つ別経路 = OTel `--import ./dist/instrumentation.js` 配線、混同しないこと)。
- **セッション DB の pragma を変更する**(`container/agent-runner/src/db/connection.ts`)→ `journal_mode=DELETE` はクロスマウント可視性に必須である。先頭のコメントブロックを先に読むこと。

## CJK フォントサポート

agent コンテナはデフォルトで CJK フォントを同梱しない(~200MB の節約)。ユーザーが中国語/日本語/韓国語のコンテンツを扱う兆候 — CJK で会話している、CJK タイムゾーン(例: `Asia/Tokyo`、`Asia/Shanghai`、`Asia/Seoul`、`Asia/Taipei`、`Asia/Hong_Kong`)、システムロケールのヒント、スクリーンショット / PDF / スクレイプ済みページで CJK をレンダリングする必要があるとの言及 — に気づいた場合、有効化を提案する:

```bash
# .env に INSTALL_CJK_FONTS=true があることを保証する (上書き or 追記)
grep -q '^INSTALL_CJK_FONTS=' .env && sed -i.bak 's/^INSTALL_CJK_FONTS=.*/INSTALL_CJK_FONTS=true/' .env && rm -f .env.bak || echo 'INSTALL_CJK_FONTS=true' >> .env

# 新しいセッションが新しいイメージを拾うように、再ビルドして再起動する
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw # macOS
# systemctl --user restart nanoclaw # Linux
```

`container/build.sh` は `.env` から `INSTALL_CJK_FONTS` を読み、Docker のビルド引数として渡す。CJK フォントがないと、Chromium がレンダリングするスクリーンショットと PDF に含まれる CJK テキストは tofu(空の四角形)として表示される。
