# 初回起動 Bootstrap (biblio-claw, Phase 1 ローカル)

あなたは biblio-claw を新しいマシンで初めて立ち上げようとしている。開発者 (DEN さん、または fork して動かそうとしている人) が repo を clone し、Claude Code を起動して、このファイルを読ませた状態だ。

あなたの仕事: 自然な会話を通じて環境を準備し、`.env` を埋め、依存をインストールし、最終的に `pnpm run chat "hello"` で司書 (biblio agent) が応答を返す状態まで連れていくこと。

> **このファイルの素性と運用**:
>
> - **正本**: `.claude/templates/BOOTSTRAP.md` (git 追跡対象、PC 跨ぎで共有)
> - **起動前 (人手)**: 開発者が `cp .claude/templates/BOOTSTRAP.md ./BOOTSTRAP.md` で repo root に展開する。Claude Code を起動して開発者から「BOOTSTRAP.md に従ってセットアップして」と指示される
> - **起動後 (AI Agent)**: あなた (claude) が repo root の `./BOOTSTRAP.md` を読んで実行する
> - **完了後 (AI Agent)**: あなた (claude) が **自身で `rm BOOTSTRAP.md`** して repo root 側を片付ける (段階 6.2 で実施)。正本 (`.claude/templates/BOOTSTRAP.md`) は残す

## 前提条件 (bootstrap 開始前に揃っているもの)

以下は bootstrap が動き出すための最小限の前提。**揃っていない項目があれば、まず開発者に揃えてもらってから bootstrap を再開する** (項目によっては bootstrap 内で誘導するが、Slack / GitHub の権限取得や Windows native の OS 切り替えのように bootstrap 外でしか進められないものもある)。

| 前提 | 詳細 | 不在時 |
| :--- | :--- | :--- |
| **GCP アカウント** | 個人 or 組織。Billing account 紐付け済 (Vertex Anthropic は課金 project 前提) | アカウント作成・課金設定から開発者に依頼。bootstrap は停止 |
| **GCP project** | 未作成でも OK — 段階 1.0 で console を開いて作成誘導する | bootstrap 内で誘導 (新規作成手順を案内) |
| **Slack workspace の App 作成権限** | workspace owner / admin、もしくは admin から App 作成権限を取得済 | 権限取得を依頼。取得後に bootstrap を再開してもらう |
| **GitHub アカウント** | 個人 or 組織。GitHub App 作成権限あり | アカウント作成 / 権限取得から開発者に依頼 |
| **OS** | Linux / WSL2 / macOS のいずれか | **Windows native は対応外** — WSL2 に切り替えてもらう (段階 0.1 で機械的に検出) |
| **internet reachable** | google.com / slack.com / github.com / aiplatform.googleapis.com / docker hub に到達できる | corp proxy / VPN / firewall を疑い、開発者に環境確認を依頼 (段階 0.3 で機械的に検出) |
| **ディスク空き** | 5 GB 以上 (docker images で 2-3 GB 消費) | 空きを作ってから再開 (段階 0.4 で機械的に検出) |

bootstrap 開始時に開発者と 1 度確認する。**段階 0 で改めて機械的に検査する** が、最初の挨拶で「揃っていますか?」を温かく尋ねる形でも良い。

## 範囲と非範囲

### 範囲

- **M1 Phase 1 (ローカル) 立ち上げのみ**
- repo clone 直後 → `pnpm run chat "hello"` で司書 (biblio agent) が応答するまで
- `.env` の Vertex / Slack / GitHub App セクションを埋め、OneCLI に各 secret を投入
- `scripts/verify-phase-1-wiring.sh exit 0` で動作確認

### 非範囲 (この bootstrap では触らない)

- **GKE prod デプロイ (M1 Phase 2)** — 別 BOOTSTRAP として将来切り出し
- **GCP project / Billing / IAM の自動セットアップ** — 将来 `.sh` 化想定、今回は人手 + 誘導
- **Cloud SQL Bootstrap GRANT** — Phase 2 で必要、Phase 1 では docker compose 内の sqlite で動く
- **OneCLI / NanoClaw 上流の更新取り込み** — `docs/BRANCH-FORK-MAINTENANCE.md` の領域

## 開始する前に

まず以下を読んで現状を把握すること。すべて既に repo 内にある正本。

- `README.md` の「クイックスタート (biblio-claw, local)」セクション — Phase 1 起動コマンド列の正本
- `CLAUDE.md` の冒頭 (環境分離方針 / PRP コマンドフロー / Branch 戦略) — biblio-claw 固有の運用ルール
- `.env.example` — 必要な env キーの正本と各 token の取得経路 (Vertex / OneCLI / Slack / GitHub App)
- `scripts/onecli-vertex-secret.sh` / `scripts/onecli-gh-secret.sh` のヘッダコメント — secret 投入の前提と設計意図

既存の `.env` がある場合は、各セクションで「埋まっている項目」と placeholder のままの項目を区別し、**placeholder の項目だけ尋ねる** こと。

## このオンボーディングの進め方

1. 段階 0 → 6 を順番に進める。**質問は一度に 1 つずつ**。開発者の回答を待ってから次に進む。
2. 機械的に決められる部分はあなた (claude) が単独で実行し、人間が必要な部分 (web UI 操作・OAuth・App 作成) は会話で案内する。
3. **別ターミナル委譲パターン**: 対話プロンプトを返すコマンド (`gcloud auth login`, `gcloud auth application-default login`, `docker login`, ブラウザ認証等) は Claude Code 内で実行すると停止する。これらは**開発者に別ターミナルでの実行を依頼し、結果報告を受けてから次に進む**。あなたは別ターミナルの中で何が起きているかを直接見られないので、報告内容と必要時の事後確認コマンド (例: `gcloud auth application-default print-access-token | head -c 30`) で生存だけ検査する。
4. 各段階の終わりに動作確認 (smoke) を 1 つ挟む。「次に進める根拠」を作ってから次へ。
5. 途中で止めても問題ない。次セッションで `.env` の状態を読んで再開できる (= 再実行可能設計)。
6. 必須なのは段階 0 / 1 / 2 / 4 / 5 / 6。**GitHub App (段階 4) は M2 以降 (棚からの biblio 仕入れ) で bootstrap.md を再利用する際に必須**になるため、M1 段階でも先に設定だけ済ませておく。Slack (段階 3) は任意 — CLI チャット (段階 5) が代替になるため、後回しでも bootstrap goal に到達できる。

> **token / secret の扱い (絶対遵守)**: 開発者が貼った token 値・PEM 内容・パスワードを **ターミナルに表示しない / `echo` や `cat` で擦らない / 会話履歴に再掲しない / argv に乗せない**。`.env` 反映は Edit / Write ツールで直接、`.secrets/` 配下への PEM 配置は `mv` / `cp` で完結させる。一瞬でも値が AI Agent の出力に混ざりそうになったら、その瞬間に立ち止まる。

## 実行ログと failure 時のフロー

上流 NanoClaw の wizard (`docs/setup-flow.md`) が「3 つの出力レベル」で確立した運用思想を、bootstrap.md でもそのまま採用する。**wizard 廃止に伴い bootstrap.md が単一の正本になったので、この運用は bootstrap が引き継ぐ**。

### 3 つの出力レベル

| レベル | 読み手 | 出力先 | 形式 |
| :--- | :--- | :--- | :--- |
| **1. User 向け** | 開発者 (会話相手) | あなた (claude) の応答テキスト | 簡潔・要約・「次に進める根拠」を提示する形 |
| **2. 進行ログ** | 将来のデバッガ / 再開時の AI Agent / 開発者のリトライ | `logs/bootstrap.log` (追記、複数回実行で累積) | ステップごとの構造化ブロック、線形時系列 |
| **3. Raw** | 特定段階を深掘りする AI Agent / 開発者 | `logs/bootstrap-steps/NN-<step-name>.log` (段階ごと) | 子プロセスの raw stdout + stderr、逐語 |

考え方: **User はサマリを見る、進行ログはキーファクト付きの index、raw ログは証拠**。

### 実行原則

- 各段階の Bash コマンドは **raw 出力をキャプチャ** して `logs/bootstrap-steps/<step>.log` に保存。あなた (claude) は raw 出力を **失敗時のみ** 読み返す
- **子プロセスの raw 出力をあなたの応答テキストに垂れ流さない** (`stdio: 'inherit'` 禁止の原則)。要約して User 向けに返す
- 進行ログ (`logs/bootstrap.log`) には段階・結果 (success/fail) ・経過時間・キー情報 (platform, project, OS など)・失敗理由 (あれば) を追記する
- 段階開始時に `mkdir -p logs/bootstrap-steps` で出力先を確保

### 進行ログのエントリ形式 (例)

```
=== [2026-06-12T22:14:12Z] 段階-1.1-adc-login [12.3s] → success ===
  platform: linux
  is_wsl: true
  project: hajimari-ai-hackathon-2026
  next: 段階 1.2
```

```
=== [2026-06-12T22:18:33Z] 段階-2.3-onecli-vertex-secret [3.8s] → failure ===
  platform: linux
  reason: ADC token 取得失敗 (gcloud auth application-default expired?)
  raw: logs/bootstrap-steps/02-3-onecli-vertex-secret.log
  recovery: 段階 1.1 に戻り ADC 再ログインを開発者に依頼
```

### failure 時の AI Agent 診断フロー (4 ステップ)

bootstrap が失敗した時の標準フロー。あなた (claude) は **このフローを淡々と回す**:

1. **raw ログを読む**: `logs/bootstrap-steps/<該当 step>.log` の末尾 50 行を読む
2. **失敗の種別を判定**:
   - **環境要因** (gcloud auth 失効、docker daemon 停止、ディスク満杯) → 該当の前段階に戻る
   - **設定要因** (`.env` 値が違う、scope 不足、permission 不足) → 該当段階の API 実情調査セクションに戻る
   - **外部要因** (Vertex Access 未承認、Slack/GitHub 側の rate limit) → 開発者に状況を報告し、判断を仰ぐ
3. **進行ログに失敗理由 + recovery 計画を追記** (上のエントリ形式)
4. **開発者に簡潔に報告**: User 向けレベルで「段階 N で X が原因で失敗。Y に戻って再試行します」

**raw 出力を会話に貼らない**: 失敗解析のために raw ログを読むのは AI Agent の責任。User 向けには **要約 + 再開計画** だけ返す。

## 段階 0: 環境前提の機械検査

「前提条件」セクションで温かく対話済の項目を、機械的に裏取りする段階。

### 0.1 OS 判定 (Windows native 除外)

```bash
uname -a
```

- Linux / WSL2 (`Microsoft` を含む) / Darwin (macOS) なら継続
- **MINGW / MSYS / CYGWIN を検知したら停止** — 「Windows native は対応外です。WSL2 への切り替えをお願いします」と案内し bootstrap を終了する (前提条件セクション参照)

### 0.2 コマンド存在確認 + バージョン整合性

#### 0.2.1 存在確認

```bash
for c in node pnpm docker gcloud git openssl curl jq; do
  if command -v "$c" >/dev/null 2>&1; then
    printf "%-10s %s\n" "$c" "$("$c" --version 2>/dev/null | head -1)"
  else
    printf "%-10s MISSING\n" "$c"
  fi
done
docker compose version 2>/dev/null | head -1
```

不足コマンドがあれば、開発者の OS (0.1 の結果から推定) に合わせて 1 つだけインストール手順を提案する。続けるかは開発者に尋ねる。

#### 0.2.2 バージョン整合性 (.nvmrc / packageManager)

biblio-claw は **node version と pnpm version を repo 側で固定** している。ずれると `pnpm install` が `ERR_PNPM_BAD_PM_VERSION` で停止する。

```bash
echo ".nvmrc:        $(cat .nvmrc 2>/dev/null)"
echo "node 実体:     $(node --version 2>/dev/null)"
echo "packageManager: $(node -e "console.log(require('./package.json').packageManager || 'unset')" 2>/dev/null)"
echo "pnpm 実体:     $(pnpm --version 2>/dev/null)"
```

- `.nvmrc` (= `22`) と `node --version` の major が一致するか
- `package.json` の `packageManager` (= `pnpm@10.33.0`) と `pnpm --version` が完全一致するか

不一致の場合は **別ターミナル委譲** で:

- node: `nvm use` または `nvm install $(cat .nvmrc)`
- pnpm: `corepack enable && corepack prepare pnpm@10.33.0 --activate` (recommended) または `npm i -g pnpm@10.33.0`

修正後に上のコマンドを再実行して整合確認。

### 0.3 internet reachable 確認

```bash
for url in https://www.google.com https://slack.com https://api.github.com https://aiplatform.googleapis.com; do
  printf "%-40s -> %s\n" "$url" "$(curl -fsS -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo unreachable)"
done
```

- すべて 2xx / 3xx なら継続
- いずれかが `unreachable` / 4xx / 5xx の場合、corp proxy / VPN / firewall の影響を疑い、開発者に環境確認を依頼する

### 0.4 ディスク空き確認

```bash
df -h .
```

5 GB 未満の場合は警告し、空きを作ってから継続するか開発者に尋ねる。

## 段階 1: GCP / Vertex セットアップ

biblio-claw は **Vertex AI 上の Claude** で動く (anthropic.com への直接 access ではない)。この段階の最重要事項は 2 つ:

1. GCP project が存在し、ADC でログイン済になっていること
2. **Vertex AI Anthropic Access が承認済** であること (未承認だと段階 2 / 5 の LLM 呼び出しで 403)

`gcloud auth ...` 系は対話プロンプトを返すため、**「進め方」項目 3 の別ターミナル委譲パターン**を使う。

### 1.0 GCP project の確認 (なければ作成誘導)

```bash
gcloud config get-value project 2>/dev/null
gcloud projects list --format='value(projectId,name)' 2>/dev/null | head -10
```

開発者と対話して **使う project ID = `<your-gcp-project-id>`** を確定する。

**project が無い場合 / 新規に作る場合**:

- Console から新規作成を案内: https://console.cloud.google.com/projectcreate
- Billing account を紐付けてもらう (**Vertex Anthropic は課金 project が必須**、無料枠不可)
- 作成完了後、別ターミナルで `gcloud config set project <new-project-id>` を実行してもらう

DEN さん環境では `hajimari-ai-hackathon-2026` が既定の参考値として `.env.example` に記載されているが、他の開発者は自分の project ID を使う。

### 1.1 ADC ログイン (別ターミナル委譲)

`gcloud auth application-default login` はブラウザを開く対話プロンプトを返すため、Claude Code 内で実行すると停止する。**開発者に別ターミナルでの実行を依頼**する:

> 開発者への案内テンプレ:
>
> 「別のターミナルを開いて以下を実行してください。ブラウザが立ち上がって Google account 認証を求められます。完了したらこちらに『終わりました』と教えてください (token 文字列の貼り付けは不要です)」
>
> ```bash
> gcloud auth application-default login --project <your-gcp-project-id>
> ```

開発者の完了報告を受けたら、Claude Code 側で生存確認:

```bash
gcloud auth application-default print-access-token | head -c 30 && echo
```

(値の長さで生存だけ確認、token 値そのものは表示しない)。すでに ADC が設定済なら、上記コマンドの先頭 30 文字が出るだけで OK。

### 1.2 Vertex AI API の有効化

Vertex の Anthropic models は **承認制 (self-serve enable + 数時間〜数日の審査)**。未承認だと段階 2 の secret 投入は通っても、段階 5 の `pnpm run chat` が 403 で失敗する。1.2 → 1.5 で承認状態を確認し、必要なら申請を誘導する。

```bash
gcloud services list --enabled --filter="name:aiplatform.googleapis.com" \
  --project=<your-gcp-project-id> --format='value(config.name)'
```

`aiplatform.googleapis.com` が出れば API は有効。出ない場合は別ターミナルで:

```bash
gcloud services enable aiplatform.googleapis.com --project=<your-gcp-project-id>
```

### 1.3 Anthropic models の承認確認 (Console 併用)

CLI からの完全判定は難しいので、**Console での確認を開発者に依頼**する:

> 開発者への案内テンプレ:
>
> 「ブラウザで以下を開いてください。Anthropic の Claude モデルカードが見えるはずです。**`Enable` ボタンが押せる状態 / `Available` 表示** なら承認済、**`Request access` ボタン** が表示されているなら未承認です」
>
> URL: `https://console.cloud.google.com/vertex-ai/model-garden?project=<your-gcp-project-id>`
> 検索ボックスで `Claude` と入力して絞り込む

### 1.4 未承認の場合の誘導

承認手順:

1. Model Garden の Claude カードを開く (例: `Claude Sonnet 4.6`)
2. **Enable** または **Request access** を押下
3. フォームを記入して送信 (use case、組織情報)
4. 通常 **数時間〜2 営業日** で承認メールが届く
5. 承認後に bootstrap を再開してもらう

未承認のままでも `.env` 反映 → 段階 2 の docker compose / pnpm install までは進められる。**実際の LLM 呼び出し (段階 5.4 の chat)** で初めて 403 になる。承認待ちの間に他段階を先に進める判断もあり。

### 1.5 ナレッジ参照先 (公式 docs + 経験ノート)

**公式 docs (最新仕様の正本)**:

- [Use Claude models | Vertex AI](https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude) — 利用手順の公式
- [Anthropic Claude models | Model Garden](https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/anthropic-claude) — モデル一覧と利用可能 region
- [Vertex AI pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing) — 課金体系

**経験ノート (DEN さん実体験)**:

- 申請から承認まで体感 **数時間〜1 営業日** (DEN さんの場合)
- region は **`global` のみ対応** (`asia-northeast1` 等の region では 404)
- Billing account が紐付いていないとフォームで弾かれる
- 1 度 access 落ちると別 project で取り直しは非自明 (要 contact form)

### 1.6 .env を作る + Vertex セクションを埋める

```bash
[ -f .env ] || cp .env.example .env
```

`.env` の以下を Edit で確認:

- `ANTHROPIC_VERTEX_PROJECT_ID` — **段階 1.0 で確定した `<your-gcp-project-id>` を書き込む**
- `CLOUD_ML_REGION` — `global` 固定 (Vertex の Anthropic は global endpoint のみ)

`.env.example` の `ANTHROPIC_VERTEX_PROJECT_ID` には DEN さん環境の参考値 (`hajimari-ai-hackathon-2026`) が記載されているが、開発者が違う環境であれば Edit で書き換える。

## 段階 2: 依存パッケージ + Compose 起動 + Vertex 単体疎通

ここで「動くもの」が初めて立ち上がる。

### 2.1 pnpm install

```bash
pnpm install
```

`packageManager` フィールドで pnpm@10.33.0 が固定されている。corepack 経由が推奨。

### 2.2 Docker Compose 起動

```bash
docker compose up -d --wait
docker compose ps
```

サービスが `healthy` で揃うまで待つ。失敗したら `docker compose logs --tail=50` を見て概要を報告。

### 2.3 OneCLI に Vertex secret を投入

```bash
bash scripts/onecli-vertex-secret.sh
```

スクリプト内部で ADC token を取得し、OneCLI secret store に AES-256-GCM で投入する。token は ~1h で失効する設計 — Phase 1 では使う前に再実行が必要な点を開発者に共有する。

> **チェックポイント**: ここまで来たら「Vertex までの経路が通った」状態。開発者に「Slack に進む / 一旦休む / 段階 5 まで一気に行く」のどれにするか尋ねる。

## 段階 3: Slack App セットアップ (任意、後回し可)

biblio が patron と会話する窓口。**Socket Mode** で動くので公開エンドポイント不要。

> **任意の理由 (代替が存在する)**: bootstrap goal (= 司書が応答する確認) は **CLI チャット (段階 5)** で十分達成できる。Slack はそれを Slack workspace 経由に拡張する位置付け。M1 で Slack 経由の patron 体験を確認したい場合は実施するが、**bootstrap 完了の必須条件ではない**。スキップする場合は `.env` の `SLACK_*` キーを placeholder のまま残し、後で必要になったら段階 3 だけ単独で実行する。

### 3.1 Slack App の作成 (人間作業)

開発者に以下の手順を案内する (実行は開発者):

1. https://api.slack.com/apps → Create New App → from scratch
2. 開発用 workspace を選択して作成
3. **Socket Mode** を Enable → App-Level Token を発行 (scope: `connections:write`) → `xapp-...` を控える → `SLACK_APP_TOKEN`
4. **OAuth & Permissions** > Bot Token Scopes に追加:
   - `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `channels:history`
5. **Install to Workspace** → `xoxb-...` を控える → `SLACK_BOT_TOKEN`
6. **Basic Information** > Signing Secret → `SLACK_SIGNING_SECRET`
7. **Event Subscriptions** を Enable + Bot Events に `app_mention`, `message.im` を追加 (Socket Mode 下では URL 不要)

### 3.2 .env への反映

開発者から 3 token を 1 つずつ受け取り、**Edit で `.env` の該当行に直接書き込む**。受け取った値はあなたの応答テキストに含めない (確認は「3 つとも書き込みました」程度にとどめる)。

### 3.3 Slack App 設定の現状確認 (API 実情調査)

`.env` 反映後、Slack API で App の実態を調べて不足を指摘する。token 値はターミナルに出力しない (Authorization header 経由で渡す)。

#### 3.3.1 Bot token の生存確認

```bash
. .env && curl -s -X POST https://slack.com/api/auth.test \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" | jq '.'
```

- `ok: true` + `team` / `user` が返れば token 有効
- `ok: false, error: invalid_auth` → token が違う or revoke 済 → 開発者に再発行を依頼

#### 3.3.2 付与済 scope の確認

```bash
. .env && curl -s -X POST https://slack.com/api/auth.test \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" -D - -o /dev/null | grep -i "^x-oauth-scopes"
```

期待される scope (応答ヘッダ `x-oauth-scopes` のカンマ区切りに含まれているべき):

- `app_mentions:read`
- `chat:write`
- `im:history`
- `im:read`
- `im:write`
- `channels:history`

**不足 scope を検知したら** 開発者に指摘:

> 「Slack App > OAuth & Permissions で `<不足 scope>` を追加 → ページ末尾の **Reinstall to Workspace** を押して再 install してください。再 install 後に新しい Bot Token (`xoxb-...`) が発行されるので、それを教えてください」

#### 3.3.3 App-Level Token (`xapp-...`) の検証

App-Level Token は `auth.test` の対象外。代わりに `apps.connections.open` で接続検証:

```bash
. .env && curl -s -X POST https://slack.com/api/apps.connections.open \
  -H "Authorization: Bearer $SLACK_APP_TOKEN" | jq '{ok, error, url: (.url // null | tostring | .[0:40])}'
```

- `ok: true` + `url: "wss://wss-primary.slack.com/..."` → Socket Mode 接続用 WebSocket URL が払い出された = `SLACK_APP_TOKEN` 有効
- `ok: false, error: invalid_auth` → `SLACK_APP_TOKEN` が違う、または `connections:write` scope が無い

#### 3.3.4 Event Subscriptions の人手確認

Event Subscriptions の登録内容は public API では取れない。開発者に手動確認を依頼:

> 「Slack App > Event Subscriptions で以下が Bot Events に登録されていることを確認してください:
> - `app_mention`
> - `message.im`
>
> Socket Mode 下では Request URL の設定は不要です」

## 段階 4: GitHub App セットアップ (必須)

biblio agent が外部 GitHub repo を読む経路 (= 棚から biblio を取り出す = M2 の核) の認可。

> **必須の理由**: M1 Phase 1 の bootstrap goal (段階 5 CLI チャット) には直接使わないが、**M2 以降で bootstrap.md を再利用する際に必須**になる (棚からの biblio 仕入れには GitHub repo 読みが必要)。M1 段階で先に設定だけ済ませて secret を OneCLI に投入できる状態を確保しておけば、M2 着手時に bootstrap を再走させる必要がない。

この段階では「設定を完了して secret を OneCLI に投入できる」状態を目標にする (実際の仕入れ動作確認は M2 の bootstrap で行う)。

### 4.1 GitHub App の作成 (人間作業)

1. https://github.com/settings/apps/new (個人 account 設定。org 用なら org settings の apps から)
2. App name: 任意 (例: `biblio-claw-dev-<handle>`)
3. Homepage URL: `https://github.com/HajimariInc/biblio-shelf` でよい
4. **Webhook: Active を OFF** (Phase 1 では webhook 経路を使わない)
5. Repository permissions:
   - **Contents: Read-only** (biblio の取得)
   - Metadata: Read-only (暗黙で有効)
6. Where can this GitHub App be installed?: Only on this account
7. Create GitHub App

### 4.2 PEM の取得と配置

詳細画面の「Private keys」→ Generate a private key → `.pem` ファイルをダウンロード。

```bash
mkdir -p .secrets
mv ~/Downloads/<downloaded>.pem .secrets/biblio-gh-app.pem
chmod 600 .secrets/biblio-gh-app.pem
```

`.secrets/` は `.gitignore` で deny 済 (確認済)。PEM の中身は **絶対に `cat` しない / `echo` しない / `xxd` しない**。

### 4.3 App ID と Installation ID の取得

- **App ID**: 詳細画面の About セクションに表示される数字 → `GH_APP_ID`
- **Install App**: 対象 repo (テスト用に `HajimariInc/biblio-shelf` を入れる、または当人の任意の repo) に install → URL `https://github.com/settings/installations/<NUMBER>` の `<NUMBER>` → `GH_INSTALLATION_ID`

### 4.4 .env への反映

開発者から 3 値を受け取り、Edit で `.env` に書き込む:

```
GH_APP_ID=...
GH_INSTALLATION_ID=...
GH_APP_PEM_PATH=.secrets/biblio-gh-app.pem
```

他のフィールド (`GH_API_HOST` / `GH_SECRET_*` / `JWT_EXP_SECONDS`) は `.env.example` の既定で OK。

### 4.5 GitHub App 設定の現状確認 (API 実情調査)

OneCLI 投入の **前に**、GitHub API で App の実態を調べて不足を指摘する。JWT 生成は repo 内の `scripts/sign_jwt.cjs` で完結 (PEM はターミナル / argv / 一時ファイルに残さない設計、`scripts/onecli-gh-secret.sh` と同じ流儀)。

#### 4.5.1 PEM → JWT → App 情報の取得

```bash
. .env && JWT="$(cat "$GH_APP_PEM_PATH" | node scripts/sign_jwt.cjs)" && \
  curl -s -H "Authorization: Bearer $JWT" -H "Accept: application/vnd.github+json" \
    https://api.github.com/app | jq '{name, owner: .owner.login, permissions, events}'
```

確認項目:

- `name` — 想定の App 名と一致するか
- `owner.login` — 個人 account か org か
- `permissions` — 以下を含むか:
  - `contents: read` (biblio 取得用)
  - `metadata: read` (必須、暗黙)
- `events` — Phase 1 では空 `[]` または未設定で OK (webhook OFF)

**Permissions に不足検知** したら開発者に指摘:

> 「GitHub App settings (`https://github.com/settings/apps/<app-slug>`) > Permissions & events で `<不足 permission>` を **Read-only** に変更 → ページ末尾の **Save changes** を押下。その後 Installation 側で **Accept new permissions** が必要になるので、`https://github.com/settings/installations/<installation-id>` で承認してください」

#### 4.5.2 Installation の確認

```bash
. .env && JWT="$(cat "$GH_APP_PEM_PATH" | node scripts/sign_jwt.cjs)" && \
  curl -s -H "Authorization: Bearer $JWT" -H "Accept: application/vnd.github+json" \
    https://api.github.com/app/installations \
  | jq '.[] | {id, account: .account.login, repository_selection, target_type}'
```

確認項目:

- 一覧に `id` が `.env` の `GH_INSTALLATION_ID` と一致する行があるか
- `account.login` が想定の install 先 (個人 or org) か
- `repository_selection` — `all` (全 repo に install) または `selected` (選択 repo のみ)
- `selected` の場合は対象 repo (例: `HajimariInc/biblio-shelf`) が含まれているかを別途 `GET /user/installations/{installation_id}/repositories` で確認

**Installation ID 不一致** または `repository_selection: selected` で対象 repo が含まれない場合:

> 「`https://github.com/settings/installations/<installation-id>` で対象 repo を追加してください。または、別の Installation を `.env` の `GH_INSTALLATION_ID` に書き直してください」

#### 4.5.3 Installation token の試し発行

```bash
. .env && JWT="$(cat "$GH_APP_PEM_PATH" | node scripts/sign_jwt.cjs)" && \
  curl -s -X POST -H "Authorization: Bearer $JWT" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/app/installations/$GH_INSTALLATION_ID/access_tokens" \
  | jq '{has_token: (.token != null), expires_at, permissions, repository_selection}'
```

- `has_token: true` + `expires_at` (~60min 後) が出れば installation token が無事発行できる状態
- token 値そのものは jq で `has_token: bool` に潰してターミナルに出さない
- 4xx エラーなら、`installation_id` / Permissions / `repository_selection` のいずれかに齟齬がある — 上の 4.5.1 / 4.5.2 に戻る

### 4.6 OneCLI に GitHub installation token を投入

```bash
bash scripts/onecli-gh-secret.sh
```

スクリプト内部で PEM → RS256 JWT → installation access token を発行し OneCLI secret に upsert する。token は ~60min で失効 (Phase 1 は手動再実行、Phase 2 は CronJob 自動化済)。

## 段階 5: 動作確認 (チャット成立)

bootstrap の goal。「司書が "hello" に返事を返す」を実体験する。

### 5.1 Agent コンテナのビルド

```bash
./container/build.sh
```

初回のみ。biblio agent コンテナイメージをローカルにビルドする。

### 5.2 CLI agent の初期化

```bash
pnpm exec tsx scripts/init-cli-agent.ts --display-name "<patron-name>" --agent-name "<agent-name>"
```

- `--display-name`: 人間側 (patron) の表示名 — 開発者に尋ねる
- `--agent-name`: 司書の名前 — 開発者に尋ねる (省略時のデフォルトあり)

DB に synthetic CLI user + agent group + CLI messaging group を作る。

### 5.3 Host 起動

```bash
pnpm run dev &
```

バックグラウンドで host を起動。`SLACK_*_TOKEN` が埋まっていれば Slack adapter も自動接続する。ログで「ready」相当のメッセージを ~10 秒待つ。

### 5.4 チャット成立

```bash
pnpm run chat "hello"
```

CLI channel 経由で agent に hello を投げ、Vertex × Claude を呼んで応答を受け取る。**応答が返ってくれば bootstrap goal 達成**。

### 5.5 wiring verify

```bash
bash scripts/verify-phase-1-wiring.sh
```

`exit 0` で全項目 OK。失敗があれば、項目名から該当段階 (Vertex / Slack / GitHub / OneCLI) を判定して該当段階に戻る。

## 段階 6: 完了処理

### 6.1 開発者への確認

以下を 1 つずつ確認:

- Vertex 経由で agent が応答した?
- Slack workspace で bot にメッセージしたら返事が来た? (段階 3 をやった場合)
- GitHub installation token は OneCLI に乗った? (段階 4 をやった場合、`scripts/onecli-gh-secret.sh` が exit 0)

### 6.2 repo root の BOOTSTRAP.md を削除 (あなたが実行)

開発者の確認 (6.1) が取れたら、**あなた (claude) 自身が** repo root の `./BOOTSTRAP.md` を削除する。これは bootstrap の完了処理として bootstrap 自身が責任を持つ部分 — 開発者に「自分で `rm` してください」と頼まない。

```bash
rm BOOTSTRAP.md
```

正本 (`.claude/templates/BOOTSTRAP.md`) は残す。次回 fresh clone した時に開発者が再度手で `cp .claude/templates/BOOTSTRAP.md ./BOOTSTRAP.md` して使う。

### 6.3 次の道を案内

- **Phase 2 (GKE prod デプロイ)**: `README.md` の「Phase 2 運用メモ」セクション + `scripts/teardown-phase-2.sh` / `verify-phase-2-wiring.sh` 周辺
- **PRP コマンド**: `/prime` で入室 → `/prp-plan` → `/prp-implement` の流れ (CLAUDE.md § PRP コマンドフロー)
- **NanoClaw 上流の継続更新**: `docs/BRANCH-FORK-MAINTENANCE.md` で fork メンテの作法
- **token 再投入**: secret は ~1h で失効するため、必要時に `bash scripts/onecli-vertex-secret.sh` / `bash scripts/onecli-gh-secret.sh` を実行
- **司書の人格 / patron 知識 / 長期記憶 の取り込み**: `.claude/templates/SOUL.md` / `USER.md` / `MEMORY.md` の biblio-claw への組み込みは **M2 以降の bootstrap で扱う** (SOUL は `CLAUDE.md` から `@import` で参照、USER の preferences と MEMORY 全体は Orchestrator SQLite の動的記憶へ。本 bootstrap (M1) の責務外)

## 重要な注意点

- 自分らしく振る舞う (claude 名義) — 温かく、しかし率直に。企業然とした話し方はしない
- 質問を急いで進めない。開発者が詳しく話したければ、そのままにさせる
- 開発者が忙しそう、または先に進みたい様子なら、それを尊重する。埋められる部分は埋め、残りは `.env` で placeholder のまま残す
- 完了前にセッションが終わっても問題ない — このファイルは次セッションでも残っている。部分的に埋まった `.env` を読んで再開できる
- **token / secret 値は絶対にターミナルに表示しない・log に残さない・会話履歴に出さない** (`.env.example` の方針と整合、再掲)
- `.secrets/` 配下に置いた PEM は `.gitignore` で deny 済だが、誤って `git add -A` で巻き込まないよう常に specific add を使う
- 上流 NanoClaw 由来の `pnpm run setup:auto` / `bash nanoclaw.sh` (clack wizard) は **biblio-claw では使わない**。bootstrap.md が **単一の正本** として、Vertex / Slack / GitHub App / OneCLI secret 投入のセットアップ責任を持つ。wizard は `setup/` ディレクトリに残存しているが、上流 fork 由来の遺物として扱う (撤去は別論点)
- 段階 1 (Vertex Anthropic Access) が承認待ちでも段階 4 (GitHub App) は進められる。**最短到達ゴール = 段階 0 / 1 / 2 / 5 (Vertex 単体疎通 + CLI チャット成立)**、Slack / GitHub は後段で追加
