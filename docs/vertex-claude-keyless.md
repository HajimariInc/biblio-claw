# Vertex×Claude keyless 認証

biblio-claw は Google Cloud (Vertex AI) 経由で Claude (Anthropic の LLM) を呼び出す。この経路の認証を **SA (Service Account) キーを一切ダウンロードせずに** 成立させる仕組みを扱う。Sidecar token rotator による自動 rotation と組み合わせることで、GitHub / Slack / Google Drive を含む全ての外部認証で **agent-container が生 token を保持しない** 状態を実現する。

> **セキュリティモデル全体像**: 本 doc は「認証の keyless 化」に特化する。container 分離 + OneCLI Vault + gate 4 層等を含む全体モデルは [`SECURITY.md`](SECURITY.md) 参照。

---

## なぜ keyless か

外部 API への認証を **SA キー配布方式** で行う場合、次のリスクが積み上がる:

- SA キーの JSON ファイルが Repo / K8s Secret / Vault にコピーされ、漏洩経路が線形に増える
- rotation を手動でやると忘れる。忘れると期限切れで本番停止 or 期限切れの SA キーがずっと有効
- 監査 (誰がいつ SA キーで API を叩いたか) が困難、鍵単位で切り分けられない

biblio-claw は **Workload Identity Federation (WIF)** + **Sidecar token rotator** の 2 段構えでこれを解消する。

- **WIF**: GCP 側で「この Kubernetes SA からのアクセスは、このGSAとして扱ってよい」という信頼関係を宣言。GKE Pod は自分の身元 (Kubernetes SA トークン) を提示し、GCP は STS 経由で短命な GCP access token を発行する。SA キーの JSON ファイルは存在しない
- **Sidecar token rotator**: GitHub App PEM / Slack トークン等の「WIF で解決できない外部認証」も、Secret Manager から都度 fetch して短命 token に変換し、OneCLI の内蔵 secret store に投入する。orchestrator / agent-container は生 token を持たない

---

## 認証の 3 系統

biblio-claw が外部 API を叩く経路は 3 系統。全て keyless で成立させる。

| 系統 | 対象 API | 認証方式 | 実装位置 |
| :--- | :--- | :--- | :--- |
| **A** | Vertex AI (Claude / Gemini) | WIF 直接 | orchestrator + `vertex-token-rotator` sidecar |
| **B** | GitHub App (shelf repo への PR 作成 / read) | Secret Manager (PEM) → JWT → installation token | `gh-token-rotator` sidecar |
| **C** | Google Drive (R4 経路 = SA 2 段 impersonation) | WIF → orchestrator GSA → drive-user GSA impersonation | `drive-token-rotator` sidecar |

Slack トークンは K8s Secret (envFrom) で orchestrator に注入されるが、agent-container には渡らず、host process だけが持つ (channel adapter が Slack Socket Mode で完結)。

### 系統 A: Vertex WIF

WIF による Vertex 認証成立のフロー:

1. **GCP 側の宣言** (Terraform、`iam-drive-user/` module 参考):
   - GSA `biblio-orchestrator@<project>.iam.gserviceaccount.com` を作成
   - GSA に `roles/aiplatform.user` を付与 (Vertex 呼び出し権)
   - GSA と GKE Kubernetes SA (`default/biblio-orchestrator`) の間に `roles/iam.workloadIdentityUser` binding を宣言
2. **GKE 側の annotate**: KSA に `iam.gke.io/gcp-service-account: biblio-orchestrator@…` を付与
3. **Pod 起動時**: GKE metadata server 経由で **短命な GCP access token** が自動発行される (Pod は自動的に GSA として振る舞う)
4. **Vertex 呼び出し**: `@anthropic-ai/vertex-sdk` は ADC (Application Default Credentials) を経由してこの token を使う。SA キーの JSON は関与しない

### 系統 B: GitHub App Sidecar token

GitHub App は WIF では扱えない (GitHub 側のプロトコル)。代わりに **RS256 JWT → installation access token** の 2 段で短命 token を得る。

1. GitHub App の **PEM (RSA 秘密鍵)** を Secret Manager `biblio-gh-app-pem` に保存
2. `gh-token-rotator` sidecar が **50 分毎** に:
   - Secret Manager から PEM を fetch (WIF で認可、SA キー不要)
   - PEM で JWT を署名 (`app_id` + `iat` + `exp`)
   - `POST /app/installations/<installation_id>/access_tokens` に JWT を投げて **installation token (`ghs_...`、有効期限 1 時間)** を取得
   - OneCLI の内蔵 secret store (PostgreSQL、AES-256-GCM で暗号化) に `PATCH /api/secrets` で投入
3. agent-container は OneCLI 経由で `gh` API を叩く。OneCLI が MITM proxy で installation token を自動注入する
4. PEM 自体は sidecar の memory 上にしか存在せず、rotation 毎に破棄・再取得。ディスクにも argv にも log にも残らない

### 系統 C: Drive R4 経路 (SA 2 段 impersonation)

Google Drive アクセスは agent-container の別 SA (`biblio-google-drive-user@…`) で成立させる。orchestrator GSA から直接 Drive を叩かない (責務分離 + 権限最小化)。

1. `biblio-orchestrator` GSA と `biblio-google-drive-user` GSA の間に `roles/iam.serviceAccountTokenCreator` を宣言 (SA-scoped、project-scoped ではない)
2. `drive-token-rotator` sidecar が orchestrator GSA として起動し、`impersonateServiceAccount` API を叩いて drive-user GSA の access token を取得
3. drive-user GSA には Drive 側のフォルダ ACL で読み取り権限が付与されている (Terraform 管理外、Drive UI で分離)
4. 取得した access token は OneCLI 経由で agent-container に注入され、Drive API 呼び出しに使われる

R4 経路の背景と選択理由は [`operations-runbook.md`](operations-runbook.md#m4-f-phase-3-life-capabilities-web-検索--google-drive--agent-container-経路の実行力拡張) §M4-F Phase 3 参照。

---

## OneCLI との組み合わせ

Sidecar token rotator が投入した短命 token は **OneCLI の内蔵 secret store** に集約され、agent-container からの外部 API 呼び出し時に **MITM proxy で必要な瞬間だけ注入** される。

- agent-container は環境変数として `HTTPS_PROXY=<onecli>` だけを持ち、生 token を持たない
- OneCLI は destination パターン (`api.github.com` / Vertex endpoint / Drive endpoint 等) に応じて対応する token を注入
- token 漏洩の主なリスク面 (agent-container の bash / file / log) が構造的に断たれる

OneCLI 単体の設計 (secret store の暗号化 / 監査ログ / rate limit) は上流 [OneCLI](https://github.com/onecli/onecli) を参照。

---

## 実装ファイル (主要ポインタ)

biblio-claw 側で keyless 認証に関わる実装:

| 目的 | ファイル | 内容 |
| :--- | :--- | :--- |
| Vertex 呼び出し | `src/biblio/vertex-client.ts` | Anthropic の Vertex SDK を通じた Claude 呼び出し、ADC token 経路 |
| Sidecar heartbeat | `src/sidecar/vertex-auth-heartbeat.ts` | Vertex 認証の生存確認 (M4-B Vertex 401 対策の観察経路) |
| Vertex secret snapshot | `src/sidecar/vertex-secret-snapshot.ts` | Vertex token の snapshot 取得 (rotation 経路の観察用) |
| CA bundle sync | `src/sidecar/ca-secret-sync.ts` | OneCLI CA + Node.js Mozilla root CA の combined bundle 生成 (MITM 経路の TLS 成立に必要) |
| K8s manifest | `k8s/10-orchestrator-statefulset.yaml` | orchestrator StatefulSet + 3 系統 rotator sidecar + Kubernetes SA annotation |
| WIF binding (Drive) | `terraform/iam-drive-user/` | drive-user GSA への SA-scoped token creator binding |
| GH App Secret Manager | Secret Manager `biblio-gh-app-pem` | GitHub App の PEM (Console で手動 create、Terraform 管理外) |

Sidecar (gh-token-rotator / vertex-token-rotator / drive-token-rotator) の container entry point は biblio-claw image の同一 build を command 分岐で使い分ける (`k8s/10-orchestrator-statefulset.yaml` の各 container 定義参照)。

---

## 参考

biblio-claw の keyless 認証は次の段階を踏んで構築された:

- **PoC-1** (2026-05-26): keyless ADC で Vertex 経由 `claude-opus-4-7` の実呼び成功 (`BIBLIO_OK`、region=global)。実証段階
- **PoC-2** (2026-05-26): OneCLI MITM で creds-free agent → Vertex に `type:generic` Bearer 注入し `BIBLIO_POC2_OK` 取得。Bearer 付与責任を OneCLI に集約可能なことを実証
- **PoC-4** (2026-05-28): Sidecar が GitHub App PEM から installation token を発行し OneCLI に投入する経路を実証
- **M1 Phase 2** (2026-06-12): 本番実装 = GKE Autopilot 上で orchestrator StatefulSet + Sidecar CronJob で `*/30` rotation を稼働 (この時点は CronJob 型、後の PRD で Native sidecar へ)
- **M2 Phase 2.5 / M2 PRD A Phase 3** (2026-06-17): OneCLI + rotator を orchestrator Pod の Native sidecar に統合、CronJob 型から常駐型へ移行
- **M4-B Phase 0** (2026-06-30): ADK (`@google/adk`) 経由でも同じ keyless 経路が成立することを再確認
- **M4-F Phase 3 附随 PR #146** (2026-07-06): Drive access を R4 経路 (SA 2 段 impersonation) で恒久対応

外部参考:

- [Workload Identity Federation for GKE (公式)](https://cloud.google.com/kubernetes-engine/docs/how-to/workload-identity)
- [Anthropic on Vertex AI (公式)](https://docs.anthropic.com/claude/reference/claude-on-vertex-ai)
- [GitHub App - Authenticating as an installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [OneCLI Agent Vault](https://github.com/onecli/onecli) — 認証集約 + rate limit + policy enforcement

---

## 関連ドキュメント

- [`SECURITY.md`](SECURITY.md) — biblio-claw のセキュリティモデル全体像 (container 分離 + OneCLI + gate 4 層)
- [`gate-4-layer.md`](gate-4-layer.md) — 入力ゲート 4 層設計
- [`operations-runbook.md`](operations-runbook.md) §「落とし穴」 — Vertex 401 / OneCLI MITM 罠等の対症手順
- [`architecture.md`](architecture.md) — biblio-claw のアーキテクチャ全体
